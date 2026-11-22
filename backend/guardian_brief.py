"""Speaking notes shared by Voice Guardian's local presenter and conversational model."""

import json
from functools import cache
from pathlib import Path


BRIEF_PATH = Path(__file__).resolve().parents[1] / "data" / "guardian" / "project-presentation.json"


@cache
def _brief():
    return json.loads(BRIEF_PATH.read_text(encoding="utf-8"))


def _notes(identifiers: list[str], language: str) -> str:
    sections = _brief()["sections"]
    return " ".join(sections[key]["spoken"][language] for key in identifiers)


def presentation_text(topic: str, language: str, depth: int = 0) -> str:
    """Deliver the requested chapter, with different material on successive follow-ups."""
    brief = _brief()
    if topic == "water_energy_detail":
        topic, depth = "water_energy", depth + 1
    chapters = brief["topics"].get(topic, brief["topics"]["overview"])
    if depth >= len(chapters):
        return _notes(["next_topic"], language)
    return _notes(chapters[max(0, depth)], language)


def project_brief(language: str = "en") -> str:
    """Use the published notes as model context, without exposing file paths in speech."""
    return "\n".join(_notes([key], language) for key in _brief()["model_context"])
