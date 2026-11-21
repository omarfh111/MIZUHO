"""Daily FAO Irrigation and Drainage Paper 56 grass-reference Penman–Monteith calculation."""

from datetime import date
from math import acos, cos, exp, pi, radians, sin, sqrt, tan


def vapour_pressure(temperature_c: float) -> float:
    """Saturation vapour pressure in kPa, equation 11; at dewpoint this gives actual pressure."""
    return 0.6108 * exp(17.27 * temperature_c / (temperature_c + 237.3))


def reference_et(day: date, latitude: float, elevation_m: float, temperature_min_c: float,
                 temperature_max_c: float, actual_vapour_kpa: float, wind_2m_m_s: float,
                 pressure_kpa: float, irradiation_wh_m2: float) -> float:
    """Daily reference surface depth (mm). See FAO-56 chapters 3–4, equations 6–8, 11–13, 21–25, 37–40."""
    angle = 2 * pi * day.timetuple().tm_yday / 365
    phi = radians(latitude)
    inverse_distance = 1 + 0.033 * cos(angle)
    declination = 0.409 * sin(angle - 1.39)
    sunset_angle = acos(max(-1.0, min(1.0, -tan(phi) * tan(declination))))
    extraterrestrial = (24 * 60 / pi) * 0.0820 * inverse_distance * (
        sunset_angle * sin(phi) * sin(declination) + cos(phi) * cos(declination) * sin(sunset_angle))
    clear_sky = (0.75 + 0.00002 * elevation_m) * extraterrestrial
    if clear_sky <= 0:
        raise ValueError("Daily shortwave/clear-sky radiation ratio is undefined at this location and date.")
    shortwave = irradiation_wh_m2 * 0.0036  # Wh/m² to MJ/m² for this complete day
    relative_radiation = min(1.0, shortwave / clear_sky)
    fourth_power_mean = ((temperature_max_c + 273.16) ** 4 + (temperature_min_c + 273.16) ** 4) / 2
    longwave = 4.903e-9 * fourth_power_mean * (0.34 - 0.14 * sqrt(actual_vapour_kpa)) * (1.35 * relative_radiation - 0.35)
    net_radiation = 0.77 * shortwave - longwave  # reference grass albedo 0.23, daily soil heat flux assumed zero
    temperature = (temperature_min_c + temperature_max_c) / 2
    slope = 4098 * vapour_pressure(temperature) / (temperature + 237.3) ** 2
    saturated = (vapour_pressure(temperature_min_c) + vapour_pressure(temperature_max_c)) / 2
    gamma = 0.000665 * pressure_kpa
    numerator = (0.408 * slope * net_radiation + gamma * 900 / (temperature + 273)
                 * wind_2m_m_s * (saturated - actual_vapour_kpa))
    return max(0.0, numerator / (slope + gamma * (1 + 0.34 * wind_2m_m_s)))
