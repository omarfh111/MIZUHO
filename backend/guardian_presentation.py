"""Validate a model's spoken audience question separately from the authoritative narration."""

import re
import unicodedata


# Restrict improvised words to audience, choices and the demo's domain. A model cannot introduce a percentage,
# source, place, operational result or a second sentence via this opening. Unrecognized phrasing uses the local intro.
WORDS = {
    "en": """what how which where would could if imagine as when before during after for to in on at from by with without
        of about between among the a an our your their this these that those you we they all each and or then first next
        like want need rather choose decide check look see ask share compare plan prioritize protect prepare consider
        start begin show tell understand explore keep help explain think matter matters most mind through yourself
        farmer farmers grower growers neighbor neighbors family families team community audience manager running sharing
        water watering irrigation power electricity outage cut pump tank reservoir field fields plot plots station
        readings reading meter sensor site map schedule schedules turn turns stock supply supplies deliveries needs
        available remaining stored waiting drops out went off faced facing were planning day limited fair fairly
        reviewing factors priorities comparing them now decisions options should plans fairness ensure ensuring best
        children child students partners decision makers people equitable divide distribute class village gardens crops land group
        who whom whose gets get reaches reach receive together let us let's you'd we're""".split(),
    "ja": """もし 皆さん みなさん みんな 私たち わたしたち あなた だったら なら では が の を に で から まで
        と も は や へ より まず 最初に 次に 何 どの どんな どこ どちら どう どんなふうに 誰 なに どれ
        です か ます たい でしょう かね ません たら とき 場合 すると したら 前に としたら 先に
        考え 見 確認し 確認 チェックし 選び 比べ 比較し 比較 重視し 点 大切にし 優先し 尋ね 聞き 決め 分け 注目し
        について 話し合う 基準 方 方々 初めに 意見 自分 家族 子ども 子供 教室 公平 公平に 公平さ
        て み し する したい みたい しましょう い いちばん 一番 にしたい 知り 調べ 伝え
        水 畑 農家 地域 暮らし 停電 電力 電気 ポンプ タンク 貯水槽 貯水量 水位 配水 取水 灌漑
        計画 情報 データ 画面 地図 手順 順番 こと 場所 ところ 方法 とき 量 判断 配る 分ける 選ぶ 確かめ 守り""".split(),
    "aeb": """شنو شنوة شنوّة شنيا آش أش كيفاش كيف وين أنهي أنهو أيّ لو كان إذا تصوّر تصوّروا تحب تحبّ تحبّوا
        شنختاروا ياخي يا جماعة إنت إنتي إنتو إنتوما إنتما إحنا نحنا كي قبل بعد وقت في على مع من بين باش
        إلّي اللي والّا ولا نحب نحبّو نبدأو تبدأ تبدأو تبداو نثبتوا نثبّتوا تثبّت تثبتو تثبّتوا نتثبتو نختارو تختار
        تختارو تختاروا تختاروها تقارن تقارنوا نقارنو نشوفو تشوف تشوفو تشوفوا تراقب تراقبوا تفضل تفضّل تسأل تسألوا نسألوا تقدّم
        نقرّروا تقرّر تقرّروا نعطيو تعطيو نعطي تعطي تحط تحطّ نحطّوا يهمّك يهمّكم يهمنا يلزمنا يلزمكم أكثر فيها
        أوّل أوّلًا قبل كل شي حاجة حاجةً بالنسبة ليك ليكم عندك عندكم قدّامك قدامكم بيدك بلا بلاش كانك لوكان
        الماء الما ماء ما السقي الريّ الضوّ الكهرباء الخزّان الخزان البومبة المضخّة الدفْق العدّاد القياس مستوى
        منسوب كمّية مخزون الكمية المخزون التوزيع الأولويّة أولوية الأولوية النوبة البرنامج الخطة البرنامجين
        الأرض القطعة القطع الأرضيّة الحقل الفلّاح الفلّاحة جيرانك عايلتك المجموعة القرية الخريطة الأرقام
        القراءة القراءات المعلومة المعطيات القرار تختارها نشوفوه تشوفها عليها بيها المرة المسؤوليّة الفريق المشكل
        تنقطع يتقصّ نقص ناقص مقصوص المتوفر المتوفرّة الباقي نوزّعوا توزّعوا يتوزع نحضّروا روّحنا توّا خطط أحسن
        تحبّو صغار صغاركم التلامذة الحومة بيناتنا قسمة العدل عادل عادلة بالعدل العايلة حقل صاحب أصحاب
        وقتاش وقتها نراقبوا نحطّو نخلّيو""".split(),
}


def normalized(text, language):
    text = unicodedata.normalize("NFKC", text).lower().replace("’", "'")
    if language == "aeb":
        text = re.sub(r"[\u064b-\u065f\u0670]", "", text)
        text = re.sub("[آأإٱ]", "ا", text).replace("ى", "ي")
    return text


VOCABULARY = {lang: frozenset(normalized(word, lang) for word in words) for lang, words in WORDS.items()}


def audience_question(candidate, language):
    if not isinstance(candidate, str) or not 6 <= len(candidate.strip()) <= 160 or language not in VOCABULARY:
        return None
    question = candidate.strip()
    # Some models echo the number of *plans* in the brief. Use the generic noun in a framing question.
    question = question.replace("二つの計画", "計画").replace("الزوز خطط", "الخطط")
    if not re.fullmatch(r"[^!?？؟。.:;؛\n\r<>]{4,}[?？؟]", question):
        return None
    sentence = normalized(question[:-1], language)
    vocab = VOCABULARY[language]
    if language == "ja":
        if not sentence.endswith(("か", "かね")):
            return None
        # Japanese does not delimit words with spaces. Match complete words, bounded by the small character limit.
        sentence = re.sub(r"[ 、,]", "", sentence)
        ends = {0}
        for i in range(len(sentence)):
            if i in ends:
                ends.update(i + len(word) for word in vocab if sentence.startswith(word, i))
        return question if len(sentence) in ends else None
    words = re.sub("[,،]", " ", sentence).split()
    if not words or words[0] not in ({"what", "how", "which", "where", "would", "could", "if", "imagine", "who"}
                                     if language == "en" else {"شنو", "شنوة", "شنيا", "اش", "لو", "كيفاش", "كيف", "وين", "انهي", "كان", "تصور", "تصوروا", "لوكان", "تحب", "تحبو", "شنختاروا", "ياخي"}):
        return None
    return question if all(w in vocab or language == "aeb" and (w.removeprefix("و") in vocab or w.removeprefix("ال") in vocab)
                           for w in words) else None
