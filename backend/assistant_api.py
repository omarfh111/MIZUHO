from dataclasses import dataclass, field
from pathlib import Path
from threading import BoundedSemaphore

from fastapi import APIRouter, HTTPException, Request

from .assistant import run_assistant
from .assistant_memory import AssistantMemory, SessionBusy
from .catalog import Catalog
from .evidence import Corpus, index_status, load_corpus, search
from .models import AssistantAnswer, AssistantHealth, AssistantRequest, Citation, EvidenceSearchRequest, IndexStatus
from .providers import Providers, ServiceError, Services


@dataclass
class AssistantRuntime:
    catalog: Catalog
    corpus: Corpus
    providers: Providers | None
    solver_budget: float
    capacity: BoundedSemaphore = field(default_factory=lambda: BoundedSemaphore(2))
    memory: AssistantMemory = field(default_factory=AssistantMemory)

    def close(self):
        if self.providers is not None:
            self.providers.close()


def create_runtime(data_dir: Path, catalog: Catalog, solver_budget: float) -> AssistantRuntime:
    try:
        corpus = load_corpus(data_dir, catalog.evidence)
    except (FileNotFoundError, ValueError):
        return AssistantRuntime(catalog, Corpus({}, {}), None, solver_budget)
    try:
        settings = Services.from_env()
    except ValueError:
        settings = None
    return AssistantRuntime(catalog, corpus, Providers(settings) if settings else None, solver_budget)


router = APIRouter(tags=["M8 evidence and assistant"])


def runtime(request: Request) -> AssistantRuntime:
    return request.app.state.assistant


def current_index(service: AssistantRuntime) -> IndexStatus:
    try:
        return index_status(service.corpus, service.providers)
    except ServiceError:
        return index_status(service.corpus, None)


@router.get("/api/assistant/health")
def health(request: Request) -> AssistantHealth:
    service = runtime(request)
    info = current_index(service)
    return AssistantHealth(status=info.status, configured=service.providers is not None, index=info)


@router.get("/api/assistant/index")
def indexing(request: Request) -> IndexStatus:
    return current_index(runtime(request))


@router.get("/api/evidence/{source_id}/passages")
def passages(request: Request, source_id: str) -> list[Citation]:
    service = runtime(request)
    if source_id not in service.catalog.evidence:
        raise HTTPException(404, "Evidence source not found.")
    return service.corpus.for_source(source_id)


def connected(service: AssistantRuntime) -> Providers:
    if service.providers is None:
        raise HTTPException(503, "The evidence assistant is unavailable in this environment.")
    if not service.capacity.acquire(blocking=False):
        raise HTTPException(429, "The evidence assistant is busy. Try again shortly.")
    return service.providers


@router.post("/api/evidence/search")
def retrieve(request: Request, body: EvidenceSearchRequest) -> list[Citation]:
    service = runtime(request)
    providers = connected(service)
    try:
        return search(service.corpus, providers, body.query)
    except ServiceError as error:
        raise HTTPException(503, str(error)) from None
    finally:
        service.capacity.release()


@router.post("/api/assistant/chat")
def chat(request: Request, body: AssistantRequest) -> AssistantAnswer:
    service = runtime(request)
    providers = connected(service)
    try:
        return run_assistant(body, service.catalog, service.corpus, providers, service.solver_budget, service.memory)
    except SessionBusy:
        raise HTTPException(409, "This session already has a question in progress.") from None
    except ServiceError as error:
        raise HTTPException(503, str(error)) from None
    finally:
        service.capacity.release()
