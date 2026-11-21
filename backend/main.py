from contextlib import asynccontextmanager
from os import getenv
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import Field, TypeAdapter

from .catalog import DATA_DIR, load_catalog
from .compare import InputError, compare
from .models import (
    CompareRequest, Comparison, Evidence, Health, Layer, ScenarioRecord, Sites, SolarComparison, SolarRequest,
)
from .simulator import StateError
from .solar import compare_option


DEV_ORIGINS = ",".join(
    f"http://{host}:{port}" for port in (5173, 4173, 4177) for host in ("localhost", "127.0.0.1")
)
SOLVER_BUDGET = TypeAdapter(Annotated[float, Field(ge=0, le=15, allow_inf_nan=False)])


def create_app(data_dir: Path = DATA_DIR, *, solver_timeout: float | None = None) -> FastAPI:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    budget = SOLVER_BUDGET.validate_python(
        getenv("MIZHUO_SOLVER_TIMEOUT_SECONDS", "5") if solver_timeout is None else solver_timeout
    )
    origins = [origin.strip() for origin in getenv("MIZHUO_CORS_ORIGINS", DEV_ORIGINS).split(",") if origin.strip()]
    if "*" in origins:
        raise ValueError("Configure individual CORS origins.")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.catalog = load_catalog(data_dir)
        yield

    app = FastAPI(title="Mizhuo API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                       allow_headers=["Accept", "Accept-Language", "Content-Type"])

    @app.exception_handler(RequestValidationError)
    async def request_validation(_: Request, error: RequestValidationError):
        # Return field locations without reflecting request data or non-finite JSON numbers.
        details = [{key: issue[key] for key in ("type", "loc", "msg")} for issue in error.errors()]
        return JSONResponse({"detail": details}, status_code=422)

    @app.exception_handler(InputError)
    @app.exception_handler(StateError)
    async def request_inputs(_: Request, error: InputError | StateError):
        return JSONResponse(
            {"detail": [{"type": "value_error", "loc": ["body", *error.location], "msg": str(error)}]},
            status_code=422,
        )

    @app.get("/api/health")
    def health() -> Health:
        return Health()

    @app.get("/api/scenarios")
    def scenarios(request: Request) -> list[ScenarioRecord]:
        return list(request.app.state.catalog.scenarios.values())

    @app.get("/api/sites", response_model_exclude_none=True)
    def sites(request: Request) -> Sites:
        return request.app.state.catalog.sites

    @app.get("/api/layers/{site_id}/{layer_id}", response_model_exclude_none=True)
    def layer(request: Request, site_id: str, layer_id: str) -> Layer:
        result = request.app.state.catalog.layers.get((site_id, layer_id))
        if result is None:
            raise HTTPException(404, "Site layer not found.")
        return result

    @app.post("/api/solar/compare")
    def solar_comparison(request: Request, body: SolarRequest) -> SolarComparison:
        site = request.app.state.catalog.solar.get(body.site_id)
        if site is None:
            raise InputError("site_id", "No solar catalog is registered for this site.")
        if len(set(body.option_ids)) != len(body.option_ids):
            raise InputError("option_ids", "Select distinct solar options.")
        options = {option.id: option for option in site.options}
        results = []
        for index, option_id in enumerate(body.option_ids):
            if option_id not in options:
                raise InputError(("option_ids", index), "Unknown solar option for this site.")
            results.append(compare_option(site, options[option_id], body.price_tnd_per_kwh))
        return SolarComparison(options=results)

    @app.post("/api/compare")
    def comparison(request: Request, body: CompareRequest) -> Comparison:
        return compare(request.app.state.catalog, body, budget)

    @app.get("/api/evidence/{source_id}")
    def evidence(request: Request, source_id: str) -> Evidence:
        result = request.app.state.catalog.evidence.get(source_id)
        if result is None:
            raise HTTPException(404, "Evidence source not found.")
        return result

    return app


app = create_app()
