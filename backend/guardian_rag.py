"""Spoken access to the same bounded, read-only LangGraph used by the M8 chat."""

import asyncio
import re

from .assistant import run_assistant
from .assistant_tools import named_plots
from .guardian_dialogue import Dialogue
from .guardian_progress import PLAN_FACT, PLOT_FACT, plot_sentence, schedule_sentence
from .models import AssistantAnswer, AssistantRequest
from .providers import ServiceError


def spoken_answer(call: Dialogue, answer: AssistantAnswer, prompt: str) -> str:
    # The model cannot write quantities into M8 prose. Read values only from the
    # verified fact records or from the same selected M3 replay that M8 inspected.
    sections = []
    if "get_sensor_anomalies" in answer.tools_used and call.frame:
        sections.append(call.replay_summary())
    elif "get_city_data" in answer.tools_used and call.climate:
        sections.append(call.inspect_site()[0])
    requested = named_plots(prompt)
    plots = [m.groups() for fact in answer.facts if (m := PLOT_FACT.fullmatch(fact.text))]
    for plot, farmer, amount in plots:
        if requested.intersection({plot.upper(), farmer.upper()}) or (not requested and len(plots) == 1):
            sections.append(plot_sentence(call, plot, amount))
    if not sections:
        for fact in answer.facts:
            m = PLAN_FACT.fullmatch(fact.text)
            if m:
                sections.append(schedule_sentence(call, *m.groups()))
    # Keep answers conversational. The unabridged verified records and original
    # source excerpts are also delivered to the client, with their provenance.
    if not sections and call.start.language == "en":
        first = next((f for f in answer.facts if re.search(r"\d", f.text)), None)
        if first:
            sections.append(f"{first.provenance.value.capitalize()}: {first.text}")
    sections.extend(p.text for p in answer.paragraphs if p.fact_ids or not p.citation_ids)
    if answer.citations:
        source = answer.citations[0]
        # Speak the opening sentence verbatim. The UI receives the full passage.
        sentence = re.split(r"(?<=[.!?。])\s+(?=[^\d])", source.excerpt, maxsplit=1)[0]
        sections.append(call.say("", f"{source.organization} gives the following original passage: ",
            f"{source.organization}の資料では、次の箇所を確認できます。原文は、",
            f"حسب الوثيقة متاع {source.organization}، هذا مقتطف بالنصّ: ") + sentence)
    if not sections:
        sections.extend(answer.missing_information)
    # Keep whole factual statements. Never split a figure from its unit/qualifier.
    spoken = ""
    for section in sections:
        if len(section) <= 1500 and len(spoken) + len(section) < 1500:
            spoken = (spoken + " " + section).strip()
        if len(spoken) >= 540:
            break
    return spoken or call.say("", "The original evidence is in the transcript below.",
        "確認できた資料は下の会話記録にあります。", "تلقّى الوثائق المتثبّت منها في نصّ المحادثة.")


async def ask_graph(call: Dialogue, prompt: str, progress=None) -> dict:
    service = call.service
    providers = service.providers
    if providers is None:
        raise ServiceError("Evidence assistant")
    scope = call.start.model_dump(exclude={"type", "reason"})
    request = AssistantRequest(**scope, question=prompt, session_id=call.rag_session,
        provider="nvidia" if getattr(providers, "nvidia_model", None) else "openai",
        recent_questions=call.evidence_questions)
    # A cancelled turn must never become context for a later follow-up. A worker
    # already inside a synchronous provider releases its own capacity on return.
    memory = call.rag_memory.fork(call.rag_session)
    if progress:
        progress.start(prompt)

    def run():
        if not service.capacity.acquire(blocking=False):
            raise ServiceError("Evidence assistant capacity")
        try:
            return run_assistant(request, service.catalog, service.corpus, providers, service.solver_budget,
                                 memory, tunisia_data_dir=call.archive, tool_result=progress.tool_result if progress else None)
        finally:
            service.capacity.release()

    answer = await asyncio.to_thread(run)
    call.rag_memory = memory
    return {"type": "reply", "mode": "langgraph", "rag_status": "connected",
            "text": spoken_answer(call, answer, prompt), **answer.model_dump(mode="json")}
