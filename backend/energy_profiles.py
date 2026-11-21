"""Local EC JRC PVGIS archive for estimated reference-day production."""

from tools.m2m3.mizu_m2m3.solar import simulation_solar_profile


def archived_profile_wh(site_id: str, option_id: str) -> tuple[int, ...]:
    profile = simulation_solar_profile(site_id, option_id)
    return tuple(slot["solar_wh"] for slot in profile["slots"])
