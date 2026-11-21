from dataclasses import dataclass


@dataclass(frozen=True)
class DemoStation:
    label: str
    reference: float
    capacity_m3: int
    target_stock_m3: int
    max_pump_m3: int
    demand_scale: float


DEFAULT_SITE = "jendouba-pilote"
STATIONS = {
    DEFAULT_SITE: DemoStation("Jendouba pilot", 0.50, 60, 24, 10, 1),
    "kairouan-demo": DemoStation("Kairouan demo", 0.52, 72, 32, 13, 1.2),
    "gabes-demo": DemoStation("Gabès demo", 0.54, 48, 18, 8, 0.85),
}


def demo_station(site_id):
    if not isinstance(site_id, str) or site_id not in STATIONS:
        raise ValueError("site_id: choose a configured demo station")
    return STATIONS[site_id]


def demo_catalog():
    return [{"site_id": site_id, "label": station.label, "reference": station.reference}
            for site_id, station in STATIONS.items()]
