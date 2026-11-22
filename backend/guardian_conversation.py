"""Short conversational turns that require no site data or documentary evidence."""

import re
import unicodedata


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


def unfocused_spoken_opening(call, prompt: str) -> bool:
    """Brief Derja transcripts are uncertain without a prior topic or an explicitly selected result."""
    return (call.start.language == "aeb" and call.start.reason == "accessibility" and len(prompt.split()) <= 12
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
