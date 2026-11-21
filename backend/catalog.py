from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from pydantic import TypeAdapter

from .models import (
    EfficiencyReadings, Evidence, Layer, LayerId, Plot, Scenario, ScenarioRecord, Sites,
    SolarSite, WeatherPair, WeatherProfile,
)
from .simulator import validate_state
from .weather import validate_pair


DATA_DIR = Path(__file__).resolve().parents[1] / "data"


@dataclass(frozen=True)
class Catalog:
    sites: Sites
    scenarios: dict[str, ScenarioRecord]
    layers: dict[tuple[str, LayerId], Layer]
    solar: dict[str, SolarSite]
    weather: dict[str, WeatherPair]
    evidence: dict[str, Evidence]
    efficiency: dict[str, EfficiencyReadings]


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
    sites = Sites.model_validate_json((root / "sites.geojson").read_bytes())
    site_ids = by_id(list(sites.features), lambda feature: feature.properties.site_id)
    evidence = TypeAdapter(dict[str, Evidence]).validate_json((root / "sources.json").read_bytes())
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
    return Catalog(sites, scenarios, layers, solar, weather, evidence, efficiency)
