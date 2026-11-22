import json
from pathlib import Path

import pytest

from backend.guardian_brief import BRIEF_PATH, presentation_text, project_brief


def test_published_presentation_points_to_its_implementation_and_datasets():
    materials = json.loads(BRIEF_PATH.read_text(encoding="utf-8"))
    root = Path(__file__).resolve().parents[1]
    for key, section in materials["sections"].items():
        assert section["basis"] and all((root / path).is_file() for path in section["basis"]), key
        assert set(section["spoken"]) == {"en", "ja", "aeb", "fr"}, key
    referenced = {key for chapters in materials["topics"].values() for chapter in chapters for key in chapter}
    assert referenced | {"next_topic"} == set(materials["sections"])


@pytest.mark.parametrize("language", ["en", "ja", "aeb", "fr"])
def test_spoken_chapters_build_on_each_other_and_fit_playback(language):
    materials = json.loads(BRIEF_PATH.read_text(encoding="utf-8"))
    for topic in materials["topics"]:
        turns = [presentation_text(topic, language, depth) for depth in range(4)]
        assert all(0 < len(turn) <= 1200 for turn in turns)
        assert len(set(turns)) == len(turns)
        assert turns[-1].endswith(("?", "？", "؟"))
        assert "http" not in "".join(turns)
    assert presentation_text("water_energy_detail", language) == presentation_text("water_energy", language, 1)


def test_japanese_pitch_develops_the_water_and_energy_example_from_the_published_notes():
    assert "皆さま、こんにちは" in presentation_text("overview", "ja")
    assert "ピーク電力" in presentation_text("water_energy", "ja")
    assert "高低差" in presentation_text("water_energy", "ja", 1)
    assert "予備電源" in presentation_text("water_energy", "ja", 2)
    assert "ガフサ" in project_brief("ja")
