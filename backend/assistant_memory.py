"""Bounded LangGraph session memory for verified evidence and simulated planning facts."""

import json
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from hashlib import sha256
from threading import Lock
from time import monotonic
from uuid import UUID

from langgraph.store.memory import InMemoryStore

from .assistant_tools import Turn
from .models import AssistantAnswer, AssistantRequest, DecisionFact

NAMESPACE = ("assistant_sessions",)
MAX_TURNS = 6
MAX_SESSIONS = 128
IDLE_SECONDS = 60 * 60


class SessionBusy(Exception):
    pass


class AssistantMemory:
    def __init__(self):
        self.store = InMemoryStore()
        self._lock = Lock()
        self._active: set[str] = set()
        self._used: OrderedDict[str, float] = OrderedDict()

    @contextmanager
    def session(self, session_id: UUID) -> Iterator[str]:
        key = str(session_id)
        with self._lock:
            if key in self._active:
                raise SessionBusy
            now = monotonic()
            for old, last_used in list(self._used.items()):
                if old not in self._active and (now - last_used >= IDLE_SECONDS or
                                                (key not in self._used and len(self._used) >= MAX_SESSIONS)):
                    self.store.delete(NAMESPACE, old)
                    del self._used[old]
            self._active.add(key)
            self._used[key] = now
            self._used.move_to_end(key)
        try:
            yield key
        finally:
            with self._lock:
                self._used[key] = monotonic()
                self._used.move_to_end(key)
                self._active.remove(key)

    def load(self, key: str, request: AssistantRequest) -> dict:
        scope = planning_scope(request)
        with self._lock:
            item = self.store.get(NAMESPACE, key)
            if item is None:
                return {"scope": scope, "scenario_id": None, "answers": []}
            if item.value["scope"] == scope:
                return item.value
            # Commit the invalidation even when this turn fails upstream.
            answers = [{"citations": answer["citations"], "facts": [], "references": []}
                       for answer in item.value["answers"] if answer["citations"]]
            value = {"scope": scope, "scenario_id": None, "answers": answers}
            self.store.put(NAMESPACE, key, value)
            return value

    def remember(self, key: str, previous: dict, turn: Turn, answer: AssistantAnswer) -> None:
        # Free-form questions, generated prose, providers and raw tool traces never enter the store.
        citations = {item.id: turn.corpus.chunks[item.id].digest for item in answer.citations}
        facts = {item.id: item.model_dump(mode="json") for item in answer.facts if item.id in turn.memory_facts}
        references = [
            {"citation_ids": list(paragraph.citation_ids),
             "fact_ids": [key for key in paragraph.fact_ids if key in facts]}
            for paragraph in answer.paragraphs
        ]
        answers = previous["answers"]
        if citations or facts:
            answers = [*answers, {"citations": citations, "facts": list(facts.values()),
                                  "references": references}][-MAX_TURNS:]
        value = {
            "scope": previous["scope"],
            "scenario_id": turn.discussed_scenario_id or turn.remembered_scenario_id,
            "answers": answers,
        }
        with self._lock:
            self.store.put(NAMESPACE, key, value)


def planning_scope(request: AssistantRequest) -> str:
    comparison = request.comparison.model_dump(mode="json") if request.comparison else None
    city_period = request.city_period.model_dump(mode="json") if request.city_period else None
    snapshot = [request.site_id, request.city_id, city_period, request.solar_option_id, request.pvgis_option_id, request.selected_scenario_id,
                request.simulation_revision, request.simulation_pending, comparison,
                request.telemetry.model_dump(mode="json") if request.telemetry else None]
    return sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()


def recall(turn: Turn, previous: dict) -> list[dict]:
    turn.remembered_scenario_id = previous["scenario_id"]
    answers = []
    for answer in previous["answers"]:
        citations = {}
        for key, digest in answer["citations"].items():
            if (chunk := turn.corpus.chunks.get(key)) and chunk.digest == digest:
                turn.citations[key] = citations[key] = chunk.citation
        facts = {}
        for item in answer["facts"]:
            prior = DecisionFact.model_validate(item)
            facts[prior.id] = turn.fact(prior.text, prior.provenance, remember=True, source_url=prior.source_url)
        if citations or facts:
            answers.append({
                "citations": [item.model_dump(mode="json", exclude={"limitation"}) for item in citations.values()],
                "facts": [item.model_dump(mode="json") for item in facts.values()],
                "references": [
                    {"citation_ids": [key for key in reference["citation_ids"] if key in citations],
                     "fact_ids": [facts[key].id for key in reference["fact_ids"] if key in facts]}
                    for reference in answer["references"]
                ],
            })
    return answers
