from .models import SolarOption, SolarResult, SolarSite


def compare_option(site: SolarSite, option: SolarOption, price: float | None) -> SolarResult:
    # For the same requested service, a grid-tied inverter supplies only eligible load.
    used_wh = sum(
        min(generation, demand) if connected else 0
        for generation, demand, connected in zip(option.profile_wh, site.demand_wh, site.grid_available, strict=True)
    )
    avoided = used_wh / 1000
    annual_avoided = option.annual_grid_avoided_kwh
    operating_cost = option.additional_annual_cost_tnd
    net = price * annual_avoided - operating_cost if None not in (price, annual_avoided, operating_cost) else None
    installation_cost = option.installation_cost_tnd
    payback = installation_cost / net if installation_cost is not None and net is not None and net > 0 else None
    return SolarResult(
        **option.model_dump(),
        production_kwh=sum(option.profile_wh) / 1000,
        self_consumed_kwh=avoided,
        grid_avoided_kwh=avoided,
        autonomy_hours=0,
        gross_savings_tnd=price * avoided if price is not None else None,
        net_savings_tnd=net,
        payback_years=payback,
    )
