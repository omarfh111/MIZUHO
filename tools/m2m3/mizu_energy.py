import argparse
import json
from pathlib import Path
from zoneinfo import ZoneInfoNotFoundError

from mizu_m2m3.anomalies import analyze_telemetry
from mizu_m2m3.inputs import DATA
from mizu_m2m3.solar import compare_solar
from mizu_m2m3.telemetry import read_telemetry
from mizu_m2m3.weather import load_weather_pair


def _solar(args):
    return {"options": compare_solar(
        args.site, args.options, args.price,
        options_path=args.catalog, profiles_path=args.profiles, load_path=args.load, day=args.day,
    )}


def _forecast(args):
    from mizu_m2m3.forecast import forecast_load

    return forecast_load(
        args.site, args.as_of, telemetry_path=args.telemetry, weather_path=args.weather, timezone=args.timezone,
    )


def _anomalies(args):
    return analyze_telemetry(read_telemetry(args.telemetry), args.reference_kwh_per_m3)


def main(argv=None):
    parser = argparse.ArgumentParser(description="MIZU NEXUS standalone energy and telemetry tools")
    commands = parser.add_subparsers(dest="command", required=True)

    solar = commands.add_parser("solar", help="compare PV options and calculate solar indicators")
    solar.add_argument("--site", required=True)
    solar.add_argument("--options", nargs="+", required=True)
    solar.add_argument("--catalog", type=Path, default=DATA / "energy/options.json")
    solar.add_argument("--profiles", type=Path, default=DATA / "energy/pv_profiles.csv")
    solar.add_argument("--load", type=Path, help="optional, timestamped eligible load and grid status")
    solar.add_argument("--day", help="local day in YYYY-MM-DD format")
    solar.add_argument("--price", type=float, help="marginal tariff in TND/kWh")
    solar.set_defaults(run=_solar)

    forecast = commands.add_parser("forecast", help="forecast the next 24 hours of load")
    forecast.add_argument("--site", required=True)
    forecast.add_argument("--as-of", required=True, help="timezone-aware hourly cutoff")
    forecast.add_argument("--telemetry", type=Path, default=DATA / "telemetry/sample.csv")
    forecast.add_argument("--weather", type=Path, help="optional archived weather forecasts with availability times")
    forecast.add_argument("--timezone", default="Africa/Tunis")
    forecast.set_defaults(run=_forecast)

    anomalies = commands.add_parser("anomalies", help="check pump efficiency and the water balance")
    anomalies.add_argument("--telemetry", type=Path, default=DATA / "telemetry/sample.csv")
    anomalies.add_argument("--reference-kwh-per-m3", type=float)
    anomalies.set_defaults(run=_anomalies)

    weather = commands.add_parser("weather", help="validate and export a J+1 solar profile pair")
    weather.add_argument("--input", type=Path, default=DATA / "weather/jplus1_demo.json")
    weather.add_argument("--pair", required=True)
    weather.set_defaults(run=lambda args: load_weather_pair(args.pair, args.input))

    args = parser.parse_args(argv)
    try:
        result = args.run(args)
        print(json.dumps(result, indent=2, allow_nan=False))
    except (OSError, ValueError, TypeError, KeyError, ZoneInfoNotFoundError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
