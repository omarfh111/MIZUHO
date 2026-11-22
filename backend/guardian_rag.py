"""Spoken access to the same bounded, read-only LangGraph used by the M8 chat."""

import asyncio
import re

from .assistant import run_assistant
from .assistant_tools import named_plots
from .guardian_dialogue import Dialogue
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
    plots = [m.groups() for fact in answer.facts if
             (m := re.fullmatch(r"Plot (\S+) \(([^)]+)\): ([\d.]+) m³ by its deadline, .*", fact.text))]
    for plot, farmer, amount in plots:
        if requested.intersection({plot.upper(), farmer.upper()}) or (not requested and len(plots) == 1):
            sections.append(call.say("", f"In the simulation, plot {plot} receives {amount} m³ by its deadline.",
                f"シミュレーションでは、区画{plot}には期限までに{amount} m³が届きます。",
                f"في المحاكاة، القطعة {plot} يوصلها {amount} m³ قبل آخر أجل."))
    if not sections:
        for fact in answer.facts:
            m = re.fullmatch(r"(Fixed|Proposed)(?: regional)? schedule: ([\d.]+) m³ delivered on time; "
                             r"[\d.]+ m³ withdrawn; minimum coverage ([\d.]+%); .*", fact.text)
            if m:
                plan, amount, coverage = m.groups()
                sections.append(call.say("", f"The {plan.lower()} schedule delivers {amount} m³ on time, with minimum coverage of {coverage}.",
                    f"{'固定順' if plan == 'Fixed' else '提案'}計画では期限内に{amount} m³を配水し、最低充足率は{coverage}です。",
                    f"{'في النوبة الثابتة' if plan == 'Fixed' else 'في البرنامج المقترح'} يوصل {amount} m³ في الوقت وتغطية أقلّ قطعة هي {coverage}."))
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


async def ask_graph(call: Dialogue, prompt: str) -> dict:
    service = call.service
    providers = service.providers
    if providers is None:
        raise ServiceError("Evidence assistant")
    scope = call.start.model_dump(exclude={"type", "reason"})
    request = AssistantRequest(**scope, question=prompt, session_id=call.rag_session,
        provider="nvidia" if getattr(providers, "nvidia_model", None) else "openai",
        recent_questions=tuple(item["content"] for item in call.history if item["role"] == "user")[-3:])
    # A cancelled turn must never become context for a later follow-up. A worker
    # already inside a synchronous provider releases its own capacity on return.
    memory = call.rag_memory.fork(call.rag_session)

    def run():
        if not service.capacity.acquire(blocking=False):
            raise ServiceError("Evidence assistant capacity")
        try:
            return run_assistant(request, service.catalog, service.corpus, providers, service.solver_budget,
                                 memory, tunisia_data_dir=call.archive)
        finally:
            service.capacity.release()

    answer = await asyncio.to_thread(run)
    call.rag_memory = memory
    return {"type": "reply", "mode": "langgraph", "rag_status": "connected",
            "text": spoken_answer(call, answer, prompt), **answer.model_dump(mode="json")}
