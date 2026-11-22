"""Deliver the project brief to an audience, tracking its subject separately from live site data."""

import asyncio
import re
import unicodedata

from .guardian_brief import presentation_text
from .guardian_presentation import audience_question
from .guardian_provider import GuardianProviderError


def normalized(prompt: str) -> str:
    value = unicodedata.normalize("NFKC", prompt).casefold().replace("’", "'")
    value = re.sub(r"[à-öø-ÿ]", lambda m: unicodedata.normalize("NFD", m[0])[0], value)
    return re.sub(r"[\u064b-\u065f\u0670]", "", value).strip()


LANGUAGE_NAMES = {
    "en": r"english|anglais|英語|بالانقليزي|بالإنقليزي|بالإنجليزي",
    "ja": r"japanese|japonais|日本語|بالياباني|باليابانية",
    "aeb": r"derja|darija|tunisian(?: arabic)?|tunisien|チュニジア(?:方言|語)|بالتونسي|بالدارجة",
}
LANGUAGE_ONLY = re.compile(
    r"^(?:(?:okay|ok|please|just|only|continue|speak|switch|answer|reply|back|now|instead|in|to|en|"
    r"juste|seulement|parle|reponds)\b[ ,]*)*(?:LANG)(?: only| please| stp| svp|で(?:お願いします)?|だけで| برك)?[.!? ؟。！]*$"
    .replace("LANG", "|".join(LANGUAGE_NAMES.values())))
GREET = re.compile(r"\b(?:say (?:hi|hello)|greet|welcome|dire bonjour|dis bonjour|salue)\b.{0,40}"
                   r"\b(?:to|our|the|everyone|all|judge|jury|aux|au|public)|(?:審査員|皆さん).{0,14}挨拶|سلّم على|سلم على")
PROJECT = re.compile(r"\b(?:project|projet|mizuho|mizhuo|platform|prototype|solution)\b|"
                     r"プロジェクト|プラットフォーム|المشروع|المنصة|مشروعنا")
ADDRESS = re.compile(r"\b(?:present|introduce|pitch|presentation|explain to|walk .{0,12}through|"
                     r"presente\w*|presentation|expose)\b|紹介|発表|プレゼン|قدّم|قدم|اعرض")
TO_AUDIENCE = re.compile(r"\b(?:tell|explain|show|present to|speak to) (?:our |the )?(?:judges?|jury|audience)\b|"
                         r"au jury|審査員に|للجنة")
FULL_TALK = re.compile(r"\b(?:give|deliver|do|start) (?:us |them )?(?:the |our |a )?(?:full|whole|complete) "
                       r"(?:presentation|pitch|talk)\b|presentation complete|発表を始めて|قدم العرض كامل")
COACHING = re.compile(r"\b(?:opening line|opening question|analogy|metaphor|wording|feedback|brainstorm|"
                      r"help me (?:write|phrase|practice)|accroche|metaphore)\b|言い換え|冒頭の質問")
FEATURES = re.compile(r"\b(?:features?|functionalit\w*|capabilities)\b|機能|الخصائص|الميزات|شنوة يعمل")
WATER_ENERGY = re.compile(r"(?:\b(?:water|eau)\b|水|الما[ء]?|المياه).{0,28}(?:energy|power|electricity|energie|電力|エネルギー|الطاقة|الضو)|"
                          r"(?:energy|power|energie|エネルギー|الطاقة).{0,28}(?:water|eau|水|المياه|الما)")
MORE = re.compile(r"\b(?:more (?:details?|depth)|(?:in|into) (?:more )?detail|go deeper|"
                  r"expand (?:on (?:it|that|this))?|tell (?:me|us) more|elaborate|another example|"
                  r"plus de details|developpe|approfondis|continue)\b|詳しく|具体例|続けて|فسرلي اكثر|زيد فسّر|زيد فسر|اكثر تفاصيل")
TOPIC_PROMPT = re.compile(r"^(?:(?:please|okay|ok|and|now|next|for|about|what about|focus on|explain|"
                          r"tell (?:them|us|me) about|en ce qui concerne|pour|et|parle de)\b[ ,]*)*", re.I)
ELABORATION = re.compile(r"^(?:(?:okay|please|could you|can you|speak|share|give (?:me|us)|"
                         r"go|talk|explain|a little|a bit|some|in|encore|donne|moi)\b[ ,]*)*"
                         rf"(?:{MORE.pattern})(?: about (?:it|this|that)| on (?:it|this|that)| please| stp| s'il te plait)?[ .!?,。？]*$")
# A request for an actual reading or result takes the M6 route, even during the pitch.
MEASUREMENT = re.compile(r"\b(?:how (?:much|many)|this (?:plot|hour)|selected (?:hour|plan|option)|"
                         r"(?:my|our|actual|current) (?:stock|quota|reading|production)|\d+(?:[.,]\d+)? ?(?:m³|kwh)|"
                         r"combien|quel volume)\b|いくら|どれくらい|何キロ|كمية|قداش")
TOPICS = {
    "water_energy": WATER_ENERGY,
    "features": FEATURES,
    "architecture": re.compile(r"\b(?:architecture|technical stack|backend and frontend)\b|アーキテクチャ|構成|البنية التقنية"),
    "field_data": re.compile(r"delivery (?:records?|files?)|field (?:data|observations?)|operator records|"
                             r"donnees de terrain|現地データ|配水記録|معطيات الميدان"),
    "demo": re.compile(r"\b(?:demo|walkthrough|demonstration)\b|デモ|التجربة"),
    "evidence": re.compile(r"how (?:the |our )?(?:assistant|rag|evidence) works?|"
                           r"documentary assistant|アシスタントの仕組み|المساعد الوثائقي"),
}


def requested_language(prompt: str, default: str) -> str:
    value = normalized(prompt)
    standalone = LANGUAGE_ONLY.fullmatch(value)
    result, last_request = default, -1
    for code, names in LANGUAGE_NAMES.items():
        for mention in re.finditer(rf"(?<![a-z])(?:{names})(?![a-z])", value):
            before, after = value[:mention.start()], value[mention.end():]
            if (standalone or re.search(r"\b(?:in|using|en|speak|into)\s+$", before)
                    or after.startswith(("で", "だけで", "に訳")) or mention[0].startswith("بال")) and mention.start() > last_request:
                result, last_request = code, mention.start()
    return result


def pitch_request(call, prompt: str):
    """Return topic, depth and output language for an audience address or a contextual follow-up."""
    value = normalized(prompt)
    language = requested_language(prompt, call.start.language)
    if LANGUAGE_ONLY.fullmatch(value) and (call.pitch_topic or re.search(r"\b(?:just|continue|speak|switch|answer|reply|parle|reponds)\b", value)):
        # Render the same chapter in the new language. Already there? Acknowledge it without repeating the speech.
        topic = "language" if language == call.start.language or not call.pitch_topic else call.pitch_topic
        return topic, call.pitch_depth, language
    if MEASUREMENT.search(value):
        return None
    if GREET.search(value):
        return "greet", 0, language
    if COACHING.search(value):
        return None
    subject = next((topic for topic, pattern in TOPICS.items() if pattern.search(value)), None)
    project_pitch = PROJECT.search(value) and (ADDRESS.search(value) or FEATURES.search(value))
    if project_pitch or FULL_TALK.search(value) or (subject and TO_AUDIENCE.search(value)):
        topic = subject or "overview"
        depth = call.pitch_depth + 1 if topic == call.pitch_topic and MORE.search(value) else 0
        return topic, min(3, depth), language
    if not call.pitch_topic:
        return None
    # Bare topics and explicit elaborations refer to the preceding presentation.
    stripped = TOPIC_PROMPT.sub("", value).strip(" .?!。؟")
    stripped = re.sub(r"(?:について(?:教えて|話して)?(?:ください)?|を説明して(?:ください)?)$", "", stripped)
    if subject and (TOPICS[subject].fullmatch(stripped) or MORE.search(value)
                    or FEATURES.search(value) and re.search(r"our|project|platform|integrat|features of", value)):
        depth = (call.pitch_depth + 1 if subject == call.pitch_topic else 1) if MORE.search(value) else 0
        return subject, min(3, depth), language
    if ELABORATION.fullmatch(value):
        if call.pitch_depth >= 3:
            return ("water_energy" if call.pitch_topic == "demo" else "demo"), 0, language
        return call.pitch_topic, min(3, call.pitch_depth + 1), language
    return None


async def project_pitch(call, provider, prompt: str, request):
    topic, depth, language = request
    call.set_output_language(language)
    if topic == "language":
        text = call.say("Bien sûr, je continue en français.", "Of course, I’ll keep speaking English.",
                        "はい、このまま日本語でお話しします。", "بالطبيعة، نكمّل معاكم بالتونسي.")
    elif topic == "greet":
        text = call.say("Bonjour à toutes et à tous, merci d’être là ! Bienvenue dans la démonstration de MIZUHO.",
                        "Hi everyone! It’s lovely to have you here. Welcome to our MIZUHO demo.",
                        "皆さま、こんにちは。今日はお越しいただき、ありがとうございます。MIZUHOのデモへようこそ。",
                        "عسلامة الناس الكلّ، يعطيكم الصحّة اللي جيتوا اليوم! مرحبا بيكم في عرض MIZUHO.")
    else:
        text = presentation_text(topic, language, depth)
        if call.presenter_notes and provider.capabilities["llm"] and depth == 0:
            try:
                async with asyncio.timeout(7):
                    cues = await provider.presentation_emphasis(call.presenter_notes, prompt, language, topic)
                text = personalize(call, text, cues)
            except (GuardianProviderError, TimeoutError):
                pass
        call.pitch_topic, call.pitch_depth = topic, depth
    return {"type": "reply", "activity": "present", "mode": "project_brief", "language": language,
            "text": text, "tools_used": [], "citations": [], "facts": [], "missing_information": []}


def personalize(call, text, cues):
    if not isinstance(cues, dict):
        return text
    audience = cues.get("audience")
    greeting = ""
    if (isinstance(audience, str) and 1 <= len(audience) <= 60 and len(audience.split()) <= 7
            and audience in call.presenter_notes and all(c.isalpha() or c in " ’'-" for c in audience)):
        greeting = call.say(f"Bonjour, {audience} !", f"Hello, {audience}!", f"{audience}の皆さま、こんにちは。",
                            f"مرحبا بيكم، {audience}!")
    opener = audience_question(cues.get("opening_question"), call.start.language)
    closings = {
        "compare_schedules": call.say("Comparons les deux tours d’eau ensemble.", "Let’s compare the irrigation schedules together.",
                                      "では、一緒に配水計画を比べてみましょう。", "توّا خلّينا نقارنوا برامج السقي مع بعضنا."),
        "inspect_data": call.say("Regardons ensemble les relevés qu’il faudrait vérifier sur le terrain.",
                                 "Let’s look together at which readings we would check in the field.",
                                 "一緒に、現地で確認したい記録を見てみましょう。", "خلّينا نشوفو مع بعضنا شنوة يلزم نثبّتوا فيه في الميدان."),
        "invite_questions": call.say("Quelle question aimeriez-vous explorer ensemble ?", "What would you like us to explore together?",
                                     "皆さまなら、次に何を確かめたいですか。", "شنوّة تحبّوا نستكشفوا مع بعضنا؟"),
    }
    closing = cues.get("closing")
    ending = closings.get(closing, "") if isinstance(closing, str) else ""
    parts = [greeting, opener or "", text, ending]
    for index in (1, 0, 3):
        if len(" ".join(filter(None, parts))) <= 1600:
            break
        parts[index] = ""
    return " ".join(filter(None, parts))
