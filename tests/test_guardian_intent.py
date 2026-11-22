"""Speech rehearsal and explicit documentary requests can share one turn."""

import pytest

from backend.guardian_intent import requests_evidence


@pytest.mark.parametrize("opening, closing", [('"', '"'), ("'", "'"), ("“", "”"), ("«", "»"), ("「", "」")])
def test_quoted_request_is_only_rehearsal_material(opening, closing):
    line = f"The slide says {opening}Which official source describes solar pumping?{closing}."
    assert not requests_evidence(line)
    assert requests_evidence(f"{line} Show me the official source.")


def test_quoted_negation_does_not_cancel_a_separate_request():
    assert requests_evidence("My slide reads “Do not search for sources.” Could you cite an official report?")
    assert not requests_evidence("Don't search for sources. The slide reads 'Which official source describes solar?'")


def test_unmatched_quote_does_not_hide_the_speakers_next_question():
    assert requests_evidence("One slide title starts with «Eau. Which official source describes solar pumping?")
