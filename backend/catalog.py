from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import TypeAdapter

from . import DATA_DIR
from .agriculture import Survey, SurveyPlot, read_survey

from .models import (
    EfficiencyReadings, Evidence, Layer, LayerId, Plot, Scenario, ScenarioRecord, Sites,
    SolarSite, WeatherPair, WeatherProfile,
)
from .simulator import validate_state
from .weather import validate_pair

if TYPE_CHECKING:
    from .field_zones import FieldZone
    from .zone_planning import ZonePlanningProfile


@dataclass(frozen=True)
class Catalog:
    sites: Sites
    scenarios: dict[str, ScenarioRecord]
    layers: dict[tuple[str, LayerId], Layer]
    solar: dict[str, SolarSite]
    weather: dict[str, WeatherPair]
    evidence: dict[str, Evidence]
    efficiency: dict[str, EfficiencyReadings]
    agriculture: dict[str, Survey]
    field_zones: dict[str, "FieldZone"]
    zone_planning: dict[str, "ZonePlanningProfile"]

    def load_plots(self, site_id: str) -> tuple[SurveyPlot | Plot, ...]:
        if site_id in self.agriculture:
            return self.agriculture[site_id].parcels
        layer = self.layers[(site_id, LayerId.PLOTS)]
        mapped = [feature.properties.plot_id for feature in layer.features]
        for scenario in self.scenarios.values():
            if scenario.site_id == site_id and {p.plot_id for p in scenario.plots} == set(mapped):
                return scenario.plots
        raise KeyError(f"No complete plot catalogue for {site_id}.")


def apply_weather_profile(scenario: Scenario, profile: WeatherProfile) -> Scenario:
    if len(profile.slots) != len(scenario.slots):
        raise ValueError("Weather profile does not cover the scenario's horizon.")
    if profile.revised_demand_m3.keys() - {plot.plot_id for plot in scenario.plots}:
        raise ValueError("Weather profile references an unknown plot.")
    plots = tuple(
        Plot.model_validate({**plot.model_dump(), "demand_m3": profile.revised_demand_m3[plot.plot_id]})
        if plot.plot_id in profile.revised_demand_m3 else plot
        for plot in scenario.plots
    )
    slots = tuple(
        slot.model_copy(update={"solar_wh": hour.solar_wh})
        for slot, hour in zip(scenario.slots, profile.slots, strict=True)
    )
    return scenario.model_copy(update={"slots": slots, "plots": plots})


def by_id[T](items: list[T], key: Callable[[T], str]) -> dict[str, T]:
    indexed: dict[str, T] = {}
    for item in items:
        identifier = key(item)
        if identifier in indexed:
            raise ValueError(f"Duplicate catalog ID {identifier}.")
        indexed[identifier] = item
    return indexed


def load_catalog(root: Path = DATA_DIR) -> Catalog:
    from .field_zones import read_field_zones
    from .zone_planning import read_planning_profiles

    sites = Sites.model_validate_json((root / "sites.geojson").read_bytes())
    datasets = [read_survey(path.parent) for path in sorted((root / "agriculture").glob("*/site.geojson"))]
    zones = by_id(read_field_zones(root), lambda zone: zone.site.properties.site_id)
    sites = Sites(type="FeatureCollection",
                  features=(*sites.features, *(d.site for d in datasets), *(z.site for z in zones.values())))
    site_ids = by_id(list(sites.features), lambda feature: feature.properties.site_id)
    evidence = TypeAdapter(dict[str, Evidence]).validate_json((root / "sources.json").read_bytes())
    for zone in zones.values():
        source_id = zone.site.properties.source_id
        if source_id in evidence:
            raise ValueError(f"Duplicate zone evidence ID {source_id}.")
        evidence[source_id] = zone.evidence
    efficiency = TypeAdapter(dict[str, EfficiencyReadings]).validate_json(
        (root / "telemetry" / "efficiency.json").read_bytes()
    )
    scenarios = by_id(
        [ScenarioRecord.model_validate_json(path.read_bytes()) for path in sorted((root / "scenarios").glob("*.json"))],
        lambda scenario: scenario.id,
    )
    weather = by_id(
        [WeatherPair.model_validate_json(path.read_bytes()) for path in sorted((root / "weather").glob("*.json"))],
        lambda pair: pair.id,
    )
    layers = {
        (path.parent.name, LayerId(path.stem)): Layer.model_validate_json(path.read_bytes())
        for path in (root / "layers").glob("*/*.geojson")
    }
    agriculture = {}
    for dataset in datasets:
        if dataset.sources.keys() & evidence.keys() or dataset.layers.keys() & layers.keys():
            raise ValueError("Agricultural catalogue IDs overlap existing source or layer IDs.")
        agriculture[dataset.survey.site_id] = dataset.survey
        evidence.update(dataset.sources)
        layers.update(dataset.layers)
    solar = {
        path.stem: SolarSite.model_validate_json(path.read_bytes())
        for path in (root / "energy").glob("*.json")
    }
    if not sites.features or not scenarios:
        raise ValueError("The catalog must include at least one site and scenario.")

    sources = {feature.properties.source_id for feature in sites.features}
    sources.update(source for pair in weather.values() for source in (pair.central.source_id, pair.adverse.source_id))
    if solar.keys() - site_ids.keys() or efficiency.keys() - scenarios.keys():
        raise ValueError("Energy or telemetry data references an unknown site or scenario.")
    for site_id, solar_site in solar.items():
        by_id(list(solar_site.options), lambda option: option.id)
        sources.update(option.source_id for option in solar_site.options)
        solar_layer = layers.get((site_id, LayerId.SOLAR))
        mapped = {feature.properties.option_id for feature in solar_layer.features} if solar_layer else set()
        if mapped != {option.id for option in solar_site.options}:
            raise ValueError(f"Solar options and map features differ for {site_id}.")

    plot_ids_by_site: dict[str, set[str]] = {site_id: set() for site_id in site_ids}
    for survey in agriculture.values():
        plot_ids_by_site[survey.site_id].update(p.plot_id for p in survey.parcels)
    for scenario in scenarios.values():
        if scenario.site_id not in site_ids:
            raise ValueError(f"Unknown site for scenario {scenario.id}.")
        if not scenario.fixed_pump_m3 or not scenario.fixed_deliveries:
            raise ValueError(f"Missing fixed schedule for scenario {scenario.id}.")
        plot_ids_by_site[scenario.site_id].update(plot.plot_id for plot in scenario.plots)
        sources.update(plot.source_id for plot in scenario.plots if plot.source_id)
        validate_state(scenario, scenario.state)
        if scenario.weather_pair_id is not None:
            pair = weather[scenario.weather_pair_id]
            central = apply_weather_profile(scenario, pair.central)
            adverse = apply_weather_profile(scenario, pair.adverse)
            validate_pair(central, adverse, scenario.state, pair.central.risk_start_slot)

    for (site_id, layer_id), layer in layers.items():
        if site_id not in site_ids:
            raise ValueError(f"Unknown site for {layer_id} layer: {site_id}.")
        sources.add(layer.source_id)
        sources.update(feature.properties.source_id for feature in layer.features)
        if layer_id == LayerId.PLOTS:
            keys = [feature.properties.plot_id for feature in layer.features]
            if len(set(keys)) != len(keys) or set(keys) - plot_ids_by_site[site_id]:
                raise ValueError(f"Duplicate or unknown plot IDs on the map for {site_id}.")
    for scenario_id, record in efficiency.items():
        sources.add(record.source_id)
        if any(sample.slot >= len(scenarios[scenario_id].slots) for sample in record.samples):
            raise ValueError(f"Telemetry slots exceed the horizon for {scenario_id}.")
    if missing := sources - evidence.keys():
        raise ValueError(f"Missing evidence records: {', '.join(sorted(missing))}.")
    return Catalog(sites, scenarios, layers, solar, weather, evidence, efficiency, agriculture, zones,
                   read_planning_profiles(root, zones))
