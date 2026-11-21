import pytest

from backend import llm, temperature_explain as texp
from backend.temperature_effect import load_temperature_effect


@pytest.fixture
def result():
    try:
        return load_temperature_effect()
    except FileNotFoundError:
        pytest.skip("temperature_effect.json not built")


def test_facts_carry_only_computed_numbers(result):
    f = texp.facts(result)
    assert f["demande_climatique"]["pente_mm_jour_par_degre"] == result["climatic_demand"]["slope"]
    assert [p["parcelle"] for p in f["parcelles"]] == [p["plot_id"] for p in result["plots"]]
    assert "series" not in str(f)


def test_missing_key_is_reported(monkeypatch):
    monkeypatch.setattr(llm, "_load_dotenv", lambda *a, **k: None)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    with pytest.raises(llm.LLMNotConfigured):
        llm.chat([{"role": "user", "content": "x"}])


def test_reasoning_block_is_removed():
    assert llm._strip_reasoning("<think>calc</think>\n**Oui**, ...") == "**Oui**, ..."


def test_explain_uses_cache(monkeypatch, result):
    calls = []

    def fake_chat(messages):
        calls.append(messages)
        return {"text": "**Oui** sur l'année.", "model": "fake", "finish_reason": "stop", "usage": None}

    monkeypatch.setattr(llm, "chat", fake_chat)
    texp._cache.clear()
    a = texp.explain(result)
    b = texp.explain(result)
    assert a["text"] == b["text"] and not a["cached"] and b["cached"] and len(calls) == 1
    assert "FAITS" in calls[0][1]["content"]
