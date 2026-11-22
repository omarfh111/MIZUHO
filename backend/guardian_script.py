"""Read the speaker's own notes in bounded passages, separate from project evidence."""

import re

from .guardian_pitch import normalized


READ_NOTES = re.compile(
    r"^(?:(?:okay|ok|please|can you|could you|now)\b[ ,]*)*"
    r"(?:read(?: out)?|present|deliver|recite) (?:my|our|the uploaded|the attached) "
    r"(?:(?:prepared|presentation|speaker|speaking) )?(?:script|notes|speech|presentation)\b"
    r"(?: (?:out loud|aloud|to (?:our|the) (?:jury|judges?|audience)|(?:in|into) (?:japanese|english|derja|darija|tunisian(?: arabic)?)))*[.!? ]*$|"
    r"^(?:lis|presente|recite) (?:mes|mon|notre|nos) (?:notes|texte|discours|presentation)\b(?: au jury| en (?:japonais|anglais|tunisien))*[.!? ]*$|"
    r"^(?:(?:私の|この|添付した)?(?:原稿|メモ)を)(?:(?:日本語|英語|チュニジア方言)で)?(?:読んで|読み上げて)(?:ください)?[。！ ]*$|"
    r"^(?:اقرا|اقرالي|اقرى) (?:النوتات|النص|الملاحظات)(?: متاعي| متاعنا)?(?: بالتونسي| بالياباني| بالإنقليزي)?[.؟! ]*$")
CONTINUE = re.compile(r"^(?:please )?(?:continue(?: reading(?: (?:my|our) (?:script|notes))?)?|keep reading|"
                      r"read the next (?:part|section)|continue la lecture|la suite|続けて|続きを読んで|كمّل|كمل|زيد اقرا)[.!?。 ]*$")


def script_start(prompt: str, offset: int | None) -> int | None:
    value = normalized(prompt)
    if READ_NOTES.fullmatch(value):
        return 0
    if offset is not None and CONTINUE.fullmatch(value):
        return offset
    return None


def passage(notes: str, start: int, limit: int) -> tuple[str, int]:
    while start < len(notes) and notes[start].isspace():
        start += 1
    end = min(start + limit, len(notes))
    if end < len(notes):
        chunk = notes[start:end]
        sentences = list(re.finditer(r"(?<=[.!?。！？؟])(?:\s+|(?=[^\s]))|\n+", chunk))
        spaces = list(re.finditer(r"\s+", chunk)) if not sentences else []
        if boundaries := sentences or spaces:
            end = start + boundaries[-1].end()
    return notes[start:end].strip(), end
