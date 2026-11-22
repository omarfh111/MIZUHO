"""Deliver one verified fact early while LangGraph finishes a hands-free answer."""

import asyncio
import base64
import re
from contextlib import aclosing, suppress
from dataclasses import dataclass

from .assistant_tools import named_plots
from .guardian_dialogue import EVENTS
from .guardian_provider import GuardianProviderError


PLOT_FACT = re.compile(r"Plot (\S+) \(([^)]+)\): ([\d.]+) m³ by its deadline, .*")
PLAN_FACT = re.compile(r"(Fixed|Proposed)(?: regional)? schedule: ([\d.]+) m³ delivered on time; "
                       r"[\d.]+ m³ withdrawn; minimum coverage ([\d.]+%); .*")


@dataclass(frozen=True)
class Lead:
    text: str
    # This exact fragment, if present, can be omitted from the final *audio*.
    omit: str = ""


def plot_sentence(call, plot, volume):
    return call.say("", f"In the simulation, plot {plot} receives {volume} m³ by its deadline.",
                    f"シミュレーションでは、区画{plot}には期限までに{volume} m³が届きます。",
                    f"في المحاكاة، القطعة {plot} يوصلها {volume} m³ قبل آخر أجل.")


def schedule_sentence(call, plan, amount, coverage):
    return call.say("", f"The {plan.lower()} schedule delivers {amount} m³ on time, with minimum coverage of {coverage}.",
                    f"{'固定順' if plan == 'Fixed' else '提案'}計画では期限内に{amount} m³を配水し、最低充足率は{coverage}です。",
                    f"{'في النوبة الثابتة' if plan == 'Fixed' else 'في البرنامج المقترح'} يوصل {amount} m³ في الوقت وتغطية أقلّ قطعة هي {coverage}.")


async def send_speech(send, provider, text, language, *, turn_id, phase, stream, first_audio=None):
    """Stream PCM when requested. Recover to MP3 only before sending any PCM."""
    tag = {"turn_id": turn_id, "phase": phase}
    started = False
    if stream and callable(getattr(provider, "stream_speech", None)):
        try:
            async with aclosing(provider.stream_speech(text, language)) as chunks:
                async for pcm in chunks:
                    await send({"type": "audio_chunk", **tag, "mime": "audio/pcm", "sample_rate": 24000,
                                "data": base64.b64encode(pcm).decode("ascii")})
                    if not started and first_audio:
                        first_audio()
                    started = True
        except GuardianProviderError:
            if started:
                await send({"type": "audio_end", **tag, "partial": True})
                return
        else:
            if started:
                await send({"type": "audio_end", **tag})
                return
    audio, mime = await provider.speak(text, language)
    await send({"type": "audio", **tag, "mime": mime, "data": base64.b64encode(audio).decode("ascii")})
    if first_audio:
        first_audio()


class VoiceProgress:
    def __init__(self, call, provider, send, turn_id, stream):
        self.call = call
        self.provider = provider
        self.send = send
        self.turn_id = turn_id
        self.stream = stream
        self.loop = asyncio.get_running_loop()
        self.task = None
        self.lead = None
        self.audible = False
        self.closed = False
        self.plots = set()
        self.terms = set()

    def replay(self):
        event = self.call.event
        if not event:
            if self.call.frame:
                stock = self.call.frame["tank_stock_m3"]
                clause = self.call.say("", f"End-of-hour stock: {stock} m³.", f"時間枠終了時の貯水量は{stock} m³です。",
                                       f"بقى في الخزّان {stock} m³ في آخر الساعة.")
                return Lead(clause, clause)
            return None
        if event["type"] != "unexplained_water":
            text = self.call.say(*EVENTS[event["type"]])
            first = re.split(r"(?<=[.?!؟])\s+|(?<=。)", text, maxsplit=1)[0]
            return Lead(first, first)
        value = f"{event['value']:g}"
        omit = self.call.say("", f"Discrepancy: {value} m³.", f"差は{value} m³です。", f"الفرق {value} m³.")
        return Lead(self.call.say("", f"The simulated water balance shows a {value} m³ discrepancy.",
                                  f"シミュレーションでは水収支に{value} m³の差があります。",
                                  f"في المحاكاة، فمّا فرق بـ {value} m³ في حساب الماء."), omit)

    def start(self, question):
        self.plots = named_plots(question)
        self.terms = set(re.findall(r"[a-z]{4,}", question.lower())) - {
            "what", "which", "this", "that", "about", "does", "should", "tell", "give", "please", "show"}

    def tool_result(self, name, result):
        # Called on the LangGraph worker. The event loop owns the task and socket.
        if not self.closed:
            with suppress(RuntimeError):  # The client may already have disconnected.
                self.loop.call_soon_threadsafe(self.from_tool, name, result)

    def from_tool(self, name, result):
        if self.closed or self.task:
            return
        if name == "get_sensor_anomalies" and result.get("facts"):
            self.offer(self.replay())
        elif name in {"explain_decision", "get_simulation_results"}:
            facts = result.get("facts", [])
            for fact in facts:
                m = PLOT_FACT.fullmatch(fact["text"])
                if m and self.plots.intersection({m[1].upper(), m[2].upper()}):
                    text = plot_sentence(self.call, m[1], m[3])
                    self.offer(Lead(text, text))
                    return
            for fact in facts:
                m = PLAN_FACT.fullmatch(fact["text"])
                if m and m[1] == "Proposed":
                    text = schedule_sentence(self.call, *m.groups())
                    self.offer(Lead(text, text))
                    return
        elif name == "get_city_data" and result.get("facts") and self.call.climate:
            text = self.call.inspect_site()[0]
            self.offer(Lead(text, text))
        elif name in {"get_site_data", "get_agricultural_insights"} and self.call.start.language == "en":
            # A tool can return several unrelated site layers. Use a short fact
            # only when it mentions the topic asked about; otherwise wait for M8.
            fact = next((f for f in result.get("facts", []) if 0 < len(f["text"]) <= 145 and
                         self.terms.intersection(re.findall(r"[a-z]{4,}", f["text"].lower()))), None)
            if fact:
                text = f"{fact['provenance'].capitalize()}: {fact['text']}"
                self.offer(Lead(text, text))
        elif name == "search_evidence" and result.get("verified_passages"):
            source = result["verified_passages"][0]
            # This is the verified source's actual scope, not a generated claim.
            org, section = source["organization"], source["section"]
            text = self.call.say("", f"{org} has a passage on {section}.",
                                 f"{org}の資料に「{section}」という節があります。",
                                 f"لقينا في وثيقة {org} الفقرة «{section}».")
            if len(text) <= 160:
                self.offer(Lead(text))

    def offer(self, lead):
        if lead and not self.closed and self.task is None:
            self.lead = lead
            self.task = asyncio.create_task(self.play(lead))

    async def play(self, lead):
        await self.send({"type": "progress", "turn_id": self.turn_id, "text": lead.text,
                         "language": self.call.start.language})
        try:
            await send_speech(self.send, self.provider, lead.text, self.call.start.language,
                              turn_id=self.turn_id, phase="preview", stream=self.stream, first_audio=self.mark_audible)
        except GuardianProviderError:
            pass  # The final answer still carries the full text and can be read aloud.

    def mark_audible(self):
        self.audible = True

    async def finish(self, text):
        self.closed = True
        if self.task:
            try:
                # Do not delay a fast final answer waiting for an unstarted preview.
                async with asyncio.timeout(4 if self.audible else 0.15):
                    await asyncio.shield(self.task)
            except TimeoutError:
                await self.cancel()
                if self.audible and self.stream:
                    await self.send({"type": "audio_end", "turn_id": self.turn_id, "phase": "preview", "partial": True})
        return text.replace(self.lead.omit, "", 1).strip() if self.audible and self.lead.omit else text

    async def cancel(self):
        self.closed = True
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
