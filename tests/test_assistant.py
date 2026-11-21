import pytest

from backend import assistant, llm, rag
from backend.causal import funnel, jev


@pytest.fixture(autouse=True)
def offline(tmp_path, monkeypatch):
    monkeypatch.setattr(funnel, "FEEDBACK_FILE", tmp_path / "fb.json")
    funnel._cache.clear()
    monkeypatch.setattr(funnel, "judge_agent", lambda *a: (_ for _ in ()).throw(jev.JevNotConfigured("off")))
    monkeypatch.setattr(funnel, "critic_agent", lambda *a: (_ for _ in ()).throw(llm.LLMNotConfigured("off")))
    monkeypatch.setattr(rag, "search", lambda q, k=5: [
        {"source_id": "fao56-ch8", "title": "FAO-56, chapitre 8", "organisation": "FAO", "url": "https://www.fao.org/3/X0490E/x0490e0e.htm",
         "chunk": 0, "text": "Lorsque l'eau du sol manque, la culture est en stress et ETc diminue.", "score": 0.5}])


def _jev(intent, cause, stance, conf=0.9, risks=(0.1,)):
    risks = list(risks)

    def decide(state, qs):
        if "non_appuye" in qs:
            return {"model": "fake", "answers": {"non_appuye": {"type": "noul", "noul": risks.pop(0) if len(risks) > 1 else risks[0]}}}
        return {"answers": {"intent": {"choice": intent, "confidence": conf},
                            "cause": {"choice": cause, "confidence": conf},
                            "stance": {"choice": stance, "confidence": conf}}}
    return decide


def test_risky_answer_is_rewritten_once(monkeypatch):
    monkeypatch.setattr(jev, "decide", _jev("question", "aucune", "unsure", risks=(0.9, 0.2)))
    texts = iter(["La moitié du quota explique le facteur 0,25.", "Le quota limite le volume pompé."])
    monkeypatch.setattr(llm, "chat", lambda m: {"text": next(texts), "model": "fake", "finish_reason": "stop", "usage": None})
    r = assistant.chat("P-03", [{"role": "user", "content": "Et le quota ?"}])
    assert r["answer"] == "Le quota limite le volume pompé."
    assert r["verification"]["regenerated"] and r["verification"]["first_risk"] == 0.9 and not r["verification"]["flagged"]


def test_context_has_the_analyses_not_the_series():
    ctx = assistant.context("P-03")
    assert ctx["parcelle"] == "P-03" and ctx["causes_retenues"]
    assert "series" not in str(ctx)


def test_question_is_answered_with_citations(monkeypatch):
    monkeypatch.setattr(jev, "decide", _jev("question", "aucune", "unsure"))
    seen = {}

    def fake_chat(messages):
        seen["prompt"] = messages[-1]["content"]
        return {"text": "**Apport insuffisant** : l'eau utilisée vaut 0.25 fois la demande [S1].", "model": "fake",
                "finish_reason": "stop", "usage": None}

    monkeypatch.setattr(llm, "chat", fake_chat)
    r = assistant.chat("P-03", [{"role": "user", "content": "Pourquoi ?"}])
    assert r["citations"][0]["source_id"] == "fao56-ch8" and r["check"]["ok"]
    assert r["suggested_feedback"] is None
    assert "CONTEXTE" in seen["prompt"] and "[S1] FAO-56" in seen["prompt"]


def test_field_information_becomes_a_suggestion_not_a_saved_feedback(monkeypatch):
    monkeypatch.setattr(jev, "decide", _jev("info_terrain", "quota", "confirm"))
    monkeypatch.setattr(llm, "chat", lambda m: {"text": "Merci.", "model": "fake", "finish_reason": "stop", "usage": None})
    r = assistant.chat("P-03", [{"role": "user", "content": "Le CRDA a réduit notre quota."}])
    assert r["suggested_feedback"]["cause_id"] == "quota" and r["suggested_feedback"]["verdict"] == "confirm"
    assert funnel.load_feedback() == []


def test_low_confidence_gives_no_suggestion(monkeypatch):
    monkeypatch.setattr(jev, "decide", _jev("info_terrain", "quota", "confirm", conf=0.3))
    monkeypatch.setattr(llm, "chat", lambda m: {"text": "D'accord.", "model": "fake", "finish_reason": "stop", "usage": None})
    assert assistant.chat("P-03", [{"role": "user", "content": "peut-être"}])["suggested_feedback"] is None


def test_works_without_jev_and_without_qdrant(monkeypatch):
    monkeypatch.setattr(jev, "decide", lambda *a: (_ for _ in ()).throw(jev.JevNotConfigured("off")))
    monkeypatch.setattr(rag, "search", lambda q, k=5: (_ for _ in ()).throw(rag.RAGError("no collection")))
    monkeypatch.setattr(llm, "chat", lambda m: {"text": "Réponse.", "model": "fake", "finish_reason": "stop", "usage": None})
    r = assistant.chat("P-01", [{"role": "user", "content": "Bonjour"}])
    assert r["answer"] == "Réponse." and r["intent"] is None and r["rag"].startswith("indisponible")


def test_last_message_must_be_from_user():
    with pytest.raises(ValueError):
        assistant.chat("P-03", [{"role": "assistant", "content": "x"}])
