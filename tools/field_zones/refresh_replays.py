"""Archive local days of NASA POWER weather and calculate daily FAO-56 reference ET."""

import argparse
from datetime import UTC, date, datetime, time, timedelta
from hashlib import sha256
from math import isfinite
from pathlib import Path
import ssl
from statistics import fmean
from tempfile import NamedTemporaryFile
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import httpx

from backend.catalog import DATA_DIR
from backend.field_zones import read_field_zones
from backend.tunisia import Source
from backend.zone_planning import DailyWeather, IrradiationArchive, IrradiationDay
from .reference_et import reference_et, vapour_pressure


NASA = "https://power.larc.nasa.gov/api/temporal/hourly/point"
PARAMETER = "ALLSKY_SFC_SW_DWN"
MET_UNITS = {"T2M": "C", "T2MDEW": "C", "WS2M": "m/s", "PS": "kPa", "PRECTOTCORR": "mm/hour"}
TUNIS = ZoneInfo("Africa/Tunis")
DEFAULT_DAYS = (date(2025, 1, 15), date(2025, 7, 15))


def fetch_day(client: httpx.Client, longitude: float, latitude: float, day: date) -> IrradiationDay:
    start = datetime.combine(day, time.min, TUNIS).astimezone(UTC)
    hours = [start + timedelta(hours=index) for index in range(24)]
    if any(hour.astimezone(TUNIS).hour != index or hour.astimezone(TUNIS).date() != day
           for index, hour in enumerate(hours)):
        raise ValueError("The simulator requires 24 distinct civil hours on the selected date.")
    query = urlencode({"parameters": ",".join([PARAMETER, *MET_UNITS]), "community": "RE", "longitude": longitude, "latitude": latitude,
                       "start": start.strftime("%Y%m%d"), "end": hours[-1].strftime("%Y%m%d"),
                       "format": "JSON", "time-standard": "UTC"})
    url = f"{NASA}?{query}"
    response = client.get(url)
    response.raise_for_status()
    payload = response.json()
    if payload["header"]["time_standard"] != "UTC" or payload["parameters"][PARAMETER]["units"] != "Wh/m^2":
        raise ValueError("Expected UTC hourly irradiation in Wh/m².")
    if any(abs(original - returned) > 0.001 for original, returned in
           zip((longitude, latitude), payload["geometry"]["coordinates"][:2], strict=True)):
        raise ValueError("NASA response coordinates do not match the requested study point.")
    def samples(code: str) -> list[float] | None:
        raw = payload["properties"]["parameter"].get(code, {})
        values = [raw.get(hour.strftime("%Y%m%d%H")) for hour in hours]
        if any(not isinstance(v, (float, int)) or not isfinite(v) or v == payload["header"]["fill_value"] for v in values):
            return None
        return values

    series = samples(PARAMETER)
    if series is None:
        raise ValueError(f"Incomplete NASA POWER local day for {day}, {latitude} N, {longitude} E.")
    source = Source(
        id="nasa-power-hourly", name="NASA POWER hourly irradiation", url=url,
        attribution="NASA POWER Project · " + ", ".join(payload["header"]["sources"]),
        license="NASA open data", provenance="estimated", retrieved_at=datetime.now(UTC).replace(microsecond=0),
        sha256=sha256(response.content).hexdigest(),
        coverage="Regional all-sky shortwave radiation on a horizontal surface, Wh/m² per one-hour interval. "
                 "UTC source hours selected for a full Africa/Tunis civil day. Satellite-derived grid estimate.",
    )
    weather = None
    met = {code: samples(code) for code in MET_UNITS}
    if all(values is not None for values in met.values()):
        if any(payload["parameters"][code]["units"] != unit for code, unit in MET_UNITS.items()):
            raise ValueError("Unexpected NASA POWER meteorological unit.")
        if min(met["PS"]) <= 0 or min(met["WS2M"]) < 0 or min(met["PRECTOTCORR"]) < 0:
            raise ValueError("Invalid NASA POWER pressure, wind or precipitation.")
        elevation = payload["geometry"]["coordinates"][2]
        if not isfinite(elevation) or elevation == payload["header"]["fill_value"]:
            raise ValueError("The reference ET calculation needs the source grid elevation.")
        temp_min, temp_max = min(met["T2M"]), max(met["T2M"])
        actual_vapour = fmean(vapour_pressure(v) for v in met["T2MDEW"])
        wind, pressure = fmean(met["WS2M"]), fmean(met["PS"])
        et0 = reference_et(day, latitude, elevation, temp_min, temp_max, actual_vapour, wind, pressure, sum(series))
        weather = DailyWeather(temperature_mean_c=round(fmean(met["T2M"]), 2), temperature_min_c=temp_min,
                              temperature_max_c=temp_max, precipitation_mm=round(sum(met["PRECTOTCORR"]), 3),
                              wind_2m_m_s=wind, surface_pressure_kpa=pressure, grid_elevation_m=elevation,
                              actual_vapour_pressure_kpa=actual_vapour, et0_mm=round(et0, 3),
                              source=source.model_copy(update={"id": "nasa-power-meteorology",
                                  "name": "NASA POWER hourly meteorology", "coverage":
                                  "Gridded hourly temperature, dewpoint, wind at 2 m, surface pressure, rainfall and solar radiation. "
                                  "MIZUHO derives daily grass-reference ET using FAO-56 Penman–Monteith from these inputs."}))
    return IrradiationDay(date=day, irradiation_wh_m2=series, source=source, weather=weather)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--dates", type=date.fromisoformat, nargs="+", default=DEFAULT_DAYS)
    parser.add_argument("--sites", nargs="+", help="Refresh only these registered study windows.")
    args = parser.parse_args()
    days = sorted(set(args.dates))
    archives = []
    zones = read_field_zones(args.data_dir)
    unknown = set(args.sites or ()) - {zone.site.properties.site_id for zone in zones}
    if unknown:
        parser.error(f"Unknown sites: {', '.join(sorted(unknown))}")
    with httpx.Client(verify=ssl.create_default_context(), timeout=60) as client:
        for zone in zones:
            if args.sites and zone.site.properties.site_id not in args.sites:
                continue
            lon, lat = zone.site.geometry.coordinates
            archives.append(IrradiationArchive(site_id=zone.site.properties.site_id, longitude=lon, latitude=lat,
                                               days=[fetch_day(client, lon, lat, day) for day in days]))
    destination = args.data_dir / "zone_planning"
    destination.mkdir(exist_ok=True)
    for archive in archives:
        with NamedTemporaryFile(dir=destination, mode="w", encoding="utf-8", newline="\n", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(archive.model_dump_json(indent=2) + "\n")
        try:
            temporary.replace(destination / f"{archive.site_id}.json")
        finally:
            temporary.unlink(missing_ok=True)
        print(f"{archive.site_id}: {len(archive.days)} complete solar days, {sum(d.weather is not None for d in archive.days)} with reference ET")


if __name__ == "__main__":
    main()
