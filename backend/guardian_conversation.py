"""Tool-free conversation and project coaching in the active speaking language."""

import asyncio
import re
import unicodedata

from .assistant import clean_text
from .guardian_provider import GuardianProviderError


# Match the entire utterance. An alert, a source request, or a quantity following
# a greeting must still reach the normal assistant with the original wording.
GREETING = r"(?:hi(?: there)?|hey(?: there)?|hello(?: there)?|bonjour|salut|all[oô]|もしもし|こんにちは|عسلامة|السلام عليكم|asslema)"
PREFACE = re.compile(rf"^(?:(?P<greeting>{GREETING})|ok(?:ay)?|uh|um|mizhuo|mizuho|voice guardian)(?:\s+|$)")
MIC_CHECK = re.compile(
    r"(?:(?:(?:can|could|do) )?(?:you|u) hear (?:me|my voice)|(?:are )?(?:you|u) (?:hearing|listening to) me)"
    r"(?: (?:ok(?:ay)?|clearly|(?:right )?now|alright|well))*|am i coming through(?: (?:ok(?:ay)?|clearly))?|"
    r"(?:is )?my (?:mic|microphone) (?:on|working)|(?:mic|microphone|sound) check|"
    r"(?:est ce que )?(?:tu m entends|vous m entendez|m entendez vous)(?: (?:bien|maintenant))?|"
    r"(?:(?:私の)?声(?:が|は)?\s*)?[聞聴]こえ(?:て(?:い)?ますか|てる|ます(?:か)?|る(?:かな)?|ていますでしょうか)|"
    r"(?:(?:بالله|هل) )?(?:تسمعني|تسمع فيا|الصوت (?:واصل|واضح))(?: (?:توا|مليح|باهي))?|"
    r"tesma3(?:ni| fiya)(?: tawa)?"
)
PLAYBACK = re.compile(r"i (?:can t|cant|cannot|can not) hear (?:you|u)|je (?:ne )?(?:t|vous) entends pas|"
                      r"(?:声が|音が)?聞こえ(?:ない|ません)|(?:ما نسمعكش|مانسمعكش)")
PRESENCE = re.compile(r"are (?:you|u) (?:still )?there|can we (?:talk|chat)|tu es là|t es là|vous êtes là|いますか|موجود[ةه]?")
THANKS = re.compile(r"(?:thank you|thanks)(?: so much| a lot)?|merci(?: beaucoup)?|どうもありがとう(?:ございます)?|ありがとう(?:ございます)?|يعيشك|شكرا")
WELLBEING = re.compile(r"how are (?:you|u)(?: doing)?|how s it going|ça va|comment (?:tu vas|allez vous)|元気(?:ですか)?|لاباس")
IDENTITY = re.compile(
    r"who (?:are|r) (?:you|u)(?: exactly)?|who am i (?:speaking|talking) (?:with|to)|"
    r"what(?: s|s| is) your name|what should i call you|(?:please )?introduce yourself|tell me about yourself|"
    r"qui (?:es tu|êtes vous)|tu es qui|comment (?:tu t appelles|vous appelez vous)|présente[rz]? (?:toi|vous)|"
    r"(?:あなたは|君は)?(?:誰|だれ|どなた)(?:ですか)?|(?:お名前|名前)は(?:何ですか)?|自己紹介して(?:ください)?|"
    r"شكونك|(?:شكون|من) (?:انتي|انت|إنتي|إنت|أنت|أنتي)|شنو[ةه] (?:اسمك|إسمك)|(?:ch|sh)koun (?:enti|inta)"
)
CAPABILITIES = re.compile(
    r"what can (?:you|u) (?:do|help (?:me )?with)(?: for me)?|how can (?:you|u) help(?: me)?|"
    r"que (?:peux tu|pouvez vous) faire|comment (?:peux tu|pouvez vous) m aider|"
    r"(?:あなたは)?何ができ(?:ますか|るの)?|(?:شنو[ةه]|شنيا) (?:تنجّم|تنجم) (?:تعمل|تعاوني فيه)"
)


def unfocused_spoken_opening(call, prompt: str) -> bool:
    """Brief Derja transcripts are uncertain without a prior topic or an explicitly selected result."""
    return (call.input_language == "aeb" and call.start.reason == "accessibility" and len(prompt.split()) <= 12
            and not any((call.history, call.observations, call.proposal, call.presentation_brief, call.start.comparison,
                         call.start.zone_plan, call.start.selected_scenario_id, call.start.solar_option_id,
                         call.start.pvgis_option_id, call.start.city_id)))


def conversational_reply(call, prompt: str, *, spoken: bool, voice_input_available: bool) -> str | None:
    text = unicodedata.normalize("NFKC", prompt).casefold()
    # Whisper may add punctuation, and Derja may be transcribed with vowel marks.
    text = re.sub(r"[\u0640\u064b-\u065f\u0670]", "", text)
    text = " ".join(re.sub(r"[^\w\s]", " ", text).split())
    if not text:
        return None
    greeted = False
    while prefix := PREFACE.match(text):
        greeted = greeted or prefix["greeting"] is not None
        text = text[prefix.end():]
    if IDENTITY.fullmatch(text):
        return call.say(
            "Je suis Voice Guardian, ton assistant dans MIZUHO. Je peux t’aider à trouver les mots pour ton public, traduire une phrase ou expliquer le projet. Par quoi veux-tu commencer ?",
            "I’m Voice Guardian, your MIZUHO companion. I can help you rehearse your pitch, translate a phrase, or talk through the project. What would you like to try?",
            "Voice Guardianです。MIZUHOの発表練習や翻訳、プロジェクトの説明をお手伝いします。何から始めましょうか？",
            "أنا Voice Guardian، نعاونك في MIZUHO. ننجّم نتمرّن معاك على العرض، نترجملك جملة، وإلا نفسّرلك المشروع. بشنوة تحبّ نبداو؟")
    if CAPABILITIES.fullmatch(text):
        return call.say(
            "Dis-moi une phrase à traduire, essaie ton introduction à voix haute, ou pose-moi une question sur la démo.",
            "Try your opening line on me, give me a phrase to translate, or ask me how something in the demo works.",
            "発表の出だしを聞かせてください。フレーズの翻訳や、デモの仕組みについての質問もどうぞ。",
            "جرّب قولّي كيفاش باش تبدا العرض، أعطيني جملة نترجمهالك، وإلا اسألني على حاجة في الديمو.")
    if MIC_CHECK.fullmatch(text):
        if spoken:
            return call.say("Oui, je t’entends ! De quoi veux-tu parler ?",
                            "Yes, I can hear you! What’s on your mind?",
                            "はい、聞こえていますよ！何をお話ししましょうか？", "إي، نسمع فيك! على شنوة تحبّ نحكيو؟")
        if not voice_input_available:
            return call.say("Je peux lire ton message ! Le mode vocal est indisponible pour le moment. On peut continuer ici.",
                            "I can read your message! Voice input is unavailable right now, but we can chat here.",
                            "メッセージは読めていますよ！今は音声入力を使えませんが、文字でお話しできます。",
                            "قريت مساجك! الصوت موش متوفّر توّا، نجّموا نحكيو بالكتابة.")
        return call.say("Je peux lire ton message ! Pour vérifier le micro, dis-moi bonjour en mode vocal.",
                        "I can read your message! To check your mic, say hello in voice mode.",
                        "メッセージは読めていますよ！マイクを試すには、音声モードで話しかけてください。",
                        "قريت مساجك! باش نجرّبوا الميكرو، قُلّي عسلامة بالصوت.")
    if PLAYBACK.fullmatch(text):
        return call.say("Je suis là. Vérifie le volume et la sortie audio. On peut aussi continuer par écrit.",
                        "I’m here. Check your speaker volume and audio output. We can keep chatting by text, too.",
                        "ここにいますよ。音量と音声の出力先を確認してみてください。文字でも続けられます。",
                        "أنا موجود. ثبّت في الصوت وفي السمّاعات. ونجّموا نكمّلوا بالكتابة زادة.")
    if THANKS.fullmatch(text):
        return call.say("Avec plaisir !", "You’re welcome!", "どういたしまして！", "يعيّشك إنتي!")
    if WELLBEING.fullmatch(text):
        return call.say("Je suis là, prêt à discuter. Et toi, ça va ?", "I’m here and ready to chat. How are you doing?",
                        "いつでもお話しできますよ。調子はいかがですか？", "أنا حاضر نحكي معاك. وإنتي لاباس؟")
    if PRESENCE.fullmatch(text) or (not text and greeted):
        return call.say("Salut, je suis là ! De quoi veux-tu parler ?", "Hey, I’m here! What would you like to talk about?",
                        "はい、ここにいますよ！何をお話ししましょうか？", "عسلامة، أنا معاك! على شنوة تحبّ نحكيو؟")
    return None


# Project identifiers and everyday expressions are safe in speech. Operational
# quantities still pass through the same checks as the documentary assistant.
PROJECT_TERMS = re.compile(r"\b(?:M[1-9]|3D)\b|三次元|一緒|\bone (?:way|sentence|line)\b", re.I)
ATTRIBUTION = re.compile(r"\b(?:according to|cited by|selon (?:l[’']|la |le |les )|d[’']après (?:l[’']|la |le |les ))"
                         r"|\b(?:FAO|ANME|DGRE|SONEDE|INS|STEG)\b.{0,30}\b(?:says?|confirms?|reports?|proves?|confirme|affirme)"
                         r"|によると|によれば|حسب (?:تقرير|دراسة|وثيقة)|\bdoi:", re.I)
CLAIMED_ACTION = re.compile(
    r"\b(?:I|we)(?:['’]ve| have| just| already)* (?:approved|modified|updated|applied|recalculated|"
    r"started the pump|stopped the pump|looked up|verified|checked (?:the|your) (?:plan|sensors?))\b|"
    r"\b(?:plan|schedule|proposal) (?:is|was|has been) (?:now |already )?(?:approved|applied|changed)|"
    r"\bj[’']ai (?:validé|modifié|approuvé|appliqué|recalculé|vérifié)|\bplan (?:est|a été) (?:validé|approuvé)|"
    r"(?:承認|変更|適用|再計算)(?:しました|されました)|(?:بدلت|ثبت|صادقت على) (?:الخطة|البرنامج)", re.I)
SPOKEN_SCRIPT = {"ja": re.compile(r"[ぁ-んァ-ン]"), "aeb": re.compile(r"[ء-ي]")}


def _local_help(call, prompt):
    if re.search(r"translat|tradui|翻訳|訳し|ترجم", prompt, re.I):
        return call.say("Quelle phrase veux-tu traduire, et vers quelle langue ?",
                        "Which phrase would you like to translate, and into which language?",
                        "訳したい言葉と、どの言語にしたいかを教えてください。", "قُلّي الجملة وبأيّ لغة تحبّها؟")
    previous_user = next((turn["content"] for turn in reversed(call.history) if turn["role"] == "user"), "")
    if (re.search(r"shorter|simpler|reword|plus (?:court|simple)|言い換|短く|أقصر|اختصر", prompt, re.I)
            and re.search(r"pitch|intro|present|présent|project|projet|発表|プロジェクト|المشروع|العرض", previous_user, re.I)):
        return call.say("Essaie cette version : « Quand la pompe s’arrête, MIZUHO aide à décider qui arroser avec l’eau qui reste. »",
                        "Try this: “When the pump stops, MIZUHO helps decide where the remaining water should go.”",
                        "こんな言い方はどうでしょう。「ポンプが止まったとき、残った水をどこに配るか。MIZUHOがその判断を支えます。」",
                        "جرّب هكّا: «كي البومبة توقف، MIZUHO يعاوننا نقرّروا كيفاش نقسموا الما اللي بقى.»")
    if re.search(r"who (?:is (?:it|this|the project) for|benefits)|who uses|pour qui|qui bénéficie|誰のため|誰が使|لشكون|شكون يستفيد", prompt, re.I):
        return call.say("Le gestionnaire d’irrigation compare les options. L’agriculteur peut comprendre quand sa parcelle devrait recevoir de l’eau et les raisons de ce choix.",
                        "An irrigation manager can compare schedules. A grower can see when their plot is expected to receive water and ask why it was scheduled that way.",
                        "灌漑の管理者は配水計画を比べられます。農家の方は、自分の区画にいつ水が届く予定か、なぜその順番なのかを確認できます。",
                        "المسؤول على السقي ينجم يقارن بين البرامج. والفلّاح ينجم يفهم وقتاش دور أرضو في السقي وعلاش جا في الوقت هذاكا.")
    if re.search(r"pitch|jury|audience|rehears|present|présent|intro|opening|発表|プレゼン|冒頭|العرض|الجمهور", prompt, re.I):
        return call.say(
            "Tu pourrais ouvrir ainsi : « Une coupure arrête la pompe. Comment répartir l’eau qui reste ? » Puis montre sur la carte à qui cette décision sert.",
            "Try opening with a question: “The power goes out and the pump stops. How should we share the water that’s left?” Then show the audience who depends on that decision.",
            "「停電でポンプが止まったら、残った水をどう分けますか？」と問いかけてみましょう。続けて、その判断が誰に関わるのかを地図で示せます。",
            "تنجم تبدا هكّا: «الضوّ تقصّ والبومبة وقفت. كيفاش نقسموا الما اللي بقى؟» وبعد ورّي للحضور شكون يهمّو القرار هذا على الخريطة.")
    if re.search(r"mizu|project|projet|purpose|probl[eè]m|irrigation|仕組み|プロジェクト|課題|المشروع|السقي", prompt, re.I):
        return call.say(
            "MIZUHO aide à prévoir comment partager l’eau quand une coupure empêche le pompage. Dans la démo, tu peux comparer les tours d’irrigation et voir quelles parcelles reçoivent de l’eau à temps.",
            "MIZUHO helps irrigation managers decide how to share water when an outage interrupts pumping. In the demo, you can compare schedules and see which plots receive water on time.",
            "MIZUHOは、停電でポンプが使えないときの水の配り方を考えるためのツールです。デモでは灌漑計画を比べ、どの区画に時間どおり水が届くか確かめられます。",
            "MIZUHO يعاون المسؤول على السقي يقرّر كيفاش يقسّم الما وقت اللي الضوّ يتقصّ والبومبة توقف. في الديمو تنجم تقارن برامج السقي وتشوف شكون يوصلو الما في وقتو.")
    return call.say(
        "Je n’ai pas pu préparer une réponse sur mesure. Est-ce que tu veux travailler une phrase pour ton public ou comprendre un écran de la démo ?",
        "I couldn’t put together a tailored reply just now. Are you working on something to say to the audience, or would you like to walk through a screen?",
        "今はご質問に合わせた返事を用意できませんでした。発表で使う表現を考えましょうか。それとも、デモの画面を一緒に見ましょうか？",
        "توّا ما نجّمتش نحضّرلك جواب على طلبك بالضبط. تحبّ نعاونك في جملة تقولها للحاضرين وإلا نفسّرلك شاشة في الديمو؟")


async def companion_reply(call, provider, prompt: str) -> dict:
    text = None
    if provider.capabilities["llm"]:
        try:
            async with asyncio.timeout(12):
                notes = getattr(call, "presenter_notes", "")
                draft = await provider.companion(prompt, call.start.language, call.history,
                                                 **({"presenter_notes": notes} if notes else {}))
            script = SPOKEN_SCRIPT.get(call.start.language)
            if (isinstance(draft, str) and len(draft) <= 1000 and clean_text(PROJECT_TERMS.sub(" ", draft), 1000)
                    and (script is None or script.search(draft))
                    and not ATTRIBUTION.search(draft) and not CLAIMED_ACTION.search(draft)):
                text = " ".join(draft.split())
        except (GuardianProviderError, TimeoutError):
            pass
    return {"type": "reply", "mode": "conversation", "text": text or _local_help(call, prompt),
            "citations": [], "facts": [], "tools_used": [], "missing_information": []}
