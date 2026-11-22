"""Opt-in to documentary research from a spoken or typed chat turn."""

import re
import unicodedata


_ORGANIZATION = r"(?:anme|fao|ins|sonede|dgre|pvgis|wapor|nasa|world bank|banque mondiale)"
# An unqualified report can be a weather forecast or the user's simulation output.
_REPORT = (
    rf"(?:(?:official|published|{_ORGANIZATION})\s+(?:[\w-]+\s+){{0,3}}reports?|"
    rf"reports?\s+(?:from|by)\s+(?:the\s+)?{_ORGANIZATION}|"
    rf"rapports?\s+(?:officiels?|publies?|(?:de\s+)?(?:la\s+|l\s+)?{_ORGANIZATION}))"
)
_DOCUMENT = rf"(?:sources?|citations?|references?|evidence|proof|preuves?|documents?|etudes?|publications?|official passages?|rag|{_REPORT})"
_REQUEST = re.compile(
    rf"\b(?:which|what|where|quell?e?s?|ou)\s+(?:(?:are|is|est|sont|do|did|does|can|puis|trouver|the|an?|les?|la|des|une?|mes|official|verified|original|supporting|documentary|officielle?s?)\s+){{0,6}}{_DOCUMENT}\b|"
    rf"(?:^|[,.!?;:]\s*|\b(?:can you|could you|would you|please|then|and|peux.tu|pourrais.tu|svp)\s+)"
    rf"(?:cite|find|show|give|provide|consult|search|research|check|use|look up|look for|verify|retrieve|share|cherche|consulte|trouve|donne|montre|utilise|verifie)\b[^.!?;]{{0,65}}\b{_DOCUMENT}\b|"
    rf"\b(?:i (?:need|want)|je (?:veux|voudrais)) (?:an? |des? |les? |une? |some |official |verified )*{_DOCUMENT}\b|"
    rf"\b(?:what (?:does|did)|que (?:dit|disent))\s+(?:(?:the|l|la)\s+)?{_ORGANIZATION}\b|"
    r"(?:^|[,:]\s*|\b(?:can you|could you|would you|please|and|peux.tu|pourrais.tu)\s+)"
    r"cite\s+(?:an?|the|this|that|le|un|ce)\s+(?:[\w-]+\s+){0,3}(?:report|rapport)\b|"
    r"\b(?:where (?:does|did) (?:that|this|it) come from|where did you (?:find|get) (?:that|this)|"
    r"can you cite (?:that|this|it)|cite (?:that|this|it)|selon (?:quelle|quel) (?:etude|document|source))\b|"
    r"(?:出典|根拠|文献|資料|情報源|ソース|公式(?:レポート|報告書)|RAG)(?:を|は|が|で|も|って)?(?:教えて|示して|調べて|検索|確認|見せて|探して|何|どこ|ありますか|使って)|"
    r"(?:どの|どんな)(?:公式)?(?:資料|文献|出典)|"
    r"(?:شنو[ةه]|شنوا|شنية|انهي|أعطيني|اعطيني|هات|وريني|ابحث|لوج|نحب)[^؟.!]{0,35}(?:مصدر|مصادر|الوثائق|الوثيقة|وثائق|دليل|مراجع)|"
    r"(?:منين (?:جبت|جبتي)|حسب (?:انهي|شنو[ةه]) وثيقة)", re.I)
_SHORTHAND = re.compile(rf"^(?:please\s+)?(?:{_DOCUMENT}|出典|資料|文献|المصدر|مصادر)(?:\s+(?:please|stp|svp|بالله|{_ORGANIZATION}\b.*))?$", re.I)
_BLOCK = re.compile(
    rf"\b(?:no|not|without|skip|avoid|except|sans|pas|aucun\w*)\b[^.!?;]{{0,55}}\b{_DOCUMENT}\b|"
    rf"\b{_DOCUMENT}\b[^.!?;]{{0,28}}\b(?:not needed|unnecessary|later|plus tard|inutile)\b|"
    r"(?:出典|資料|文献|根拠|検索|RAG).{0,18}(?:不要|なし|いらない|しないで|ないで)|"
    r"(?:بلا|من غير|مانحبش|ما نحبش|ما تلوجش).{0,38}(?:مصدر|مصادر|وثائق|دليل|مراجع)",
    re.I)
_MENTION = re.compile(
    r"\b(?:(?:what if|if|suppose|imagine) (?:i|someone|(?:a |the )?judge|they) "
    r"(?:were to |would )?(?:say|said|ask|asked|asks)|"
    r"(?:practi[cs](?:e|ing)|rehears(?:e|ing)|repeat(?:ing)?|rewrit(?:e|ing)|role.play(?:ing)?) "
    r"(?:saying|asking|(?:this|the|my) (?:line|question|instruction))|"
    r"how (?:do|can|would) i (?:ask|say)|how (?:do|does) (?:you|it) (?:find|use|cite)|"
    r"how to (?:ask|cite|find|use)\b|what (?:is|are) (?:a |an )?(?:citation|source|rag)\b|"
    r"what sources can you (?:access|search)|si (?:je|le jury) (?:dis|dit|demande)|"
    r"(?:repeter|reformuler) (?:cette|la|ma) (?:question|phrase))\b",
    re.I)


def requests_evidence(prompt: str) -> bool:
    # Quoted material is content for translation, rehearsal or discussion.
    text = re.sub(r'"[^"]*"|“[^”]*”|«[^»]*»|「[^」]*」|(?<!\w)\x27[^\x27]+\x27(?!\w)', " ", prompt)
    text = unicodedata.normalize("NFKC", text).casefold().replace("’", "'")
    text = re.sub(r"[\u00c0-\u024f]", lambda m: unicodedata.normalize("NFD", m[0])[0], text)
    text = re.sub(r"[\u064b-\u065f\u0670]", "", text)
    text = text.replace("n't", " not").replace("l'", "l ").strip(" \t\n?？؟!.。")
    text = re.sub(r"\b(?:source code|open.source|(?:power|energy|water) sources?|sources? of (?:water|power|energy)|code source)\b", "topic", text)
    if _BLOCK.search(text):
        return False
    # A rehearsal line can be followed by a separate, genuine research request.
    return any(
        not _MENTION.search(sentence) and (_REQUEST.search(sentence) or _SHORTHAND.fullmatch(sentence))
        for part in re.split(r"[.!?;。！？؟؛]+", text) if (sentence := part.strip())
    )
