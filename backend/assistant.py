"""M1 - conversational assistant: explains the analyses, answers from sources, collects field feedback.

For each message:
  1. Jev reads the message and classifies it (question, field information, opinion on a cause).
  2. Qdrant returns the most relevant passages of the reference documents.
  3. The LLM answers from the parcel's analyses (CONTEXTE) and the passages (SOURCES), citing [S1]...
  4. Verifier agent (Jev) estimates the risk that the answer holds an unsupported claim or wrong
     reasoning; above 0.6 the answer is rewritten once. Numbers are also checked against CONTEXTE and SOURCES.
  5. If the message carries field information about a cause, a feedback is *suggested*; the human
     confirms it in the page before it is stored (never automatic).
"""
from __future__ import annotations

import json

from backend import llm, rag
from backend.causal import funnel, jev
from backend.causal.catalog import CAUSES
from backend.temperature_explain import check_numbers

SYSTEM = (
    "Tu es l'assistant de MIZU NEXUS, un outil d'aide à la décision pour un groupement d'irrigation en Tunisie. "
    "Tu aides le responsable à comprendre les analyses de sa parcelle, avec bienveillance, en français simple, "
    "comme un conseiller agronome patient. Règles strictes :\n"
    "- Réponds d'abord et surtout à la question posée. Ne refais pas tout le bilan des causes si on ne te le demande pas.\n"
    "- Chaleur sur plusieurs décennies, étés plus chauds, solaire, coupures de courant, bilan d'un été à l'autre : "
    "utilise la partie « climat_et_resilience » de CONTEXTE.\n"
    "- Appuie-toi uniquement sur CONTEXTE (analyses calculées) et SOURCES (extraits de documents).\n"
    "- Cite les sources utilisées entre crochets, par exemple [S2]. N'invente aucune source.\n"
    "- N'invente aucun chiffre : reprends ceux de CONTEXTE ou SOURCES tels quels.\n"
    "- Si l'information n'y est pas, dis-le clairement et indique quelle donnée ou quelle question de terrain permettrait de répondre.\n"
    "- Chaque chiffre garde son sens exact : précise sa période et ce qu'il mesure, ne mélange pas des mesures différentes.\n"
    "- Une association statistique n'est pas une preuve de cause.\n"
    "- Tu parles directement au responsable du groupement (vouvoiement), pas de lui à la troisième personne.\n"
    "- N'affirme jamais qu'un avis est enregistré ni qu'une probabilité a changé : c'est lui qui valide un avis dans la page.\n"
    "- Si sa situation n'est pas claire, termine par « **Ma question pour vous :** » suivi d'UNE question courte pour mieux comprendre son cas. "
    "Ne recopie pas le texte de « critique » mot pour mot.\n"
    "- Pas de mots anglais (écris « pente », pas « slope » ; « eau », pas « water »).\n"
    "- Ne fais aucun calcul ni aucune comparaison absents de CONTEXTE (pas de « un tiers », « deux fois plus »…).\n"
    "- 180 mots au maximum (hors tableau), paragraphes courts.\n"
    "Mise en forme (Markdown, la page l'affiche) :\n"
    "- Mets en gras avec **...** les chiffres clés et la conclusion.\n"
    "- Pour comparer plusieurs causes, parcelles ou périodes, fais un petit tableau Markdown "
    "(| Élément | Valeur | Période |), 5 lignes au maximum, chiffres repris tels quels avec leur unité.\n"
    "- Pour des étapes ou des conseils, utilise une liste à puces « - ».\n"
    "- Tu peux colorer un mot court : {vert:retenue} pour ce qui est confirmé ou favorable, "
    "{rouge:écartée} pour un manque ou un risque, {orange:à vérifier sur le terrain} pour un doute, {gris:écartée} pour ce qui est exclu. "
    "Pas plus de trois couleurs par réponse. Pas d'émoji, pas de ligne « --- ».\n"
    "- Pour comparer les causes, préfère un seul tableau | Cause | Statut | Raison courte | avec le statut coloré "
    "({vert:retenue}, {orange:terrain}, {gris:écartée}) plutôt qu'une longue liste. "
    "Le statut de chaque cause est celui de « statut_des_causes », recopié sans le changer.\n"
    "- Écris les probabilités exactement comme dans CONTEXTE (par exemple 0,98), ne les convertis pas en pourcentage.\n"
    "- Pour une question simple, une réponse courte sans tableau suffit."
)

INTENTS = {
    "question": "il pose une question ou demande une explication",
    "info_terrain": "il donne une information de terrain sur sa parcelle, sa pompe, son quota, une coupure, sa culture",
    "avis_cause": "il dit qu'une cause est vraie ou fausse pour sa parcelle",
    "autre": "salutation, remerciement ou autre",
}


VERDICT_FR = {"increase": "hausse significative", "decrease": "baisse significative",
              "no_significant_effect": "pas d'effet significatif", "insufficient_data": "données insuffisantes"}


def _effect_fr(e: dict, what: str) -> str:
    slope = "" if e.get("slope") is None else f", pente {e['slope']:+g} mm/jour par °C"
    return f"{VERDICT_FR[e['verdict']]} {what} avec la température{slope}, p = {e['p']}"


def context(plot_id: str) -> dict:
    """Compact analyses of the parcel given to the LLM (no raw series)."""
    r = funnel.run(plot_id)
    by_id = {c["id"]: c for c in r["causes"]}
    return {
        "parcelle": plot_id,
        "consequence_analysee": r["consequence"]["label"],
        "mesures": {
            "ete_eau_utilisee_mm_jour (moyenne juin-sept. 2018-2026)": r["facts"]["ete_aeti_mm_jour"],
            "ete_demande_climatique_mm_jour (moyenne juin-sept. 2018-2026)": r["facts"]["ete_et0_mm_jour"],
            "ete_rapport_eau_utilisee_sur_demande": r["facts"]["ete_rapport_aeti_et0"],
            "printemps_eau_utilisee_mm_jour (mars-mai)": r["facts"]["printemps_aeti_mm_jour"],
            "effet_temperature_en_ete": _effect_fr(r["facts"]["ete_effet_temperature"], "de l'eau utilisée"),
            "effet_temperature_sur_demande_climatique": _effect_fr(r["facts"]["demande_climatique_effet_temperature"], "de la demande climatique"),
            "eau_utilisee_11_20_juillet_2026_mm_jour": r["facts"]["juillet_d2_2026_aeti"],
            "eau_utilisee_11_20_juillet_mediane_2018_2025_mm_jour": r["facts"]["juillet_d2_mediane_2018_2025"],
            "pixels_satellite_sur_la_parcelle": r["facts"]["pixels_wapor"],
        },
        "parcelle_donnees": next(({"surface_m2": f["properties"]["surface_m2"], "besoin_m3_jour_11_20_juillet_2026": f["properties"]["demand_m3"],
                                   "occupation_osm": f["properties"]["land_use"]}
                                  for f in json.loads((funnel.ROOT / "data" / "plots.geojson").read_text(encoding="utf-8"))["features"]
                                  if f["properties"]["plot_id"] == plot_id), {}),
        "entonnoir": [f"{s['agent']} : {s['kept']} ({s['note']})" for s in r["stages"]],
        "statut_des_causes": [{"cause": c["label"],
                               "statut": "retenue" if c["id"] in r["final"] else "terrain" if c["lane"] == "field" else "écartée"}
                              for c in r["causes"]
                              if c["id"] in r["final"] or c["lane"] == "field" or c["stage_out"]],
        "causes_retenues": [{"cause": by_id[i]["label"], "probabilite": round(by_id[i]["p"], 2), "preuve": by_id[i]["data"]["why"]}
                            for i in r["final"]],
        "a_verifier_sur_le_terrain": [{"cause": c["label"], "donnees_necessaires": c["data"]["missing"]}
                                      for c in r["causes"] if c["lane"] == "field" and c["id"] not in r["final"]],
        "causes_ecartees": [{"cause": c["label"], "raison": c["data"]["why"]}
                            for c in r["causes"] if c["stage_out"] and c["id"] not in r["final"]],
        "avis_deja_donnes": [{"cause": by_id[c]["label"], "avis": h["verdict"], "note": h["note"]}
                             for c, h in funnel.latest_feedback(plot_id, "summer_gap").items()],
        "critique": (r["critic"] or {}).get("text"),
        "climat_et_resilience": _resilience_fr(plot_id),
    }


def _resilience_fr(plot_id: str) -> dict | None:
    """Long-term heat, summer water gap per year and solar potential, labelled in French."""
    try:
        from backend import resilience
        d = resilience.load()
    except (OSError, ValueError):
        return None
    h, sol = d["heat"], d["solar"]
    dec, lab = h["decades"], h["decade_labels"]
    s = d["seasons"].get(plot_id)
    t, t35 = h["trend"]["summer_tmax_c"], h["trend"]["days_ge_35"]
    out = {
        "chaleur_ete_juin_sept (NASA POWER, " + h["period"] + ")": {
            "periode_ancienne": lab["first"], "periode_recente": lab["last"], "seuils_jours_chauds_c": [35, 40],
            "ecart_tmax_c_entre_les_deux_periodes": dec["summer_tmax_c"]["change"],
            "jours_35c_en_plus_par_ete": dec["days_ge_35"]["change"],
            f"tmax_moyenne_c_{lab['first']}": dec["summer_tmax_c"]["first"],
            f"tmax_moyenne_c_{lab['last']}": dec["summer_tmax_c"]["last"],
            "tendance_c_par_decennie": t["slope_per_decade"], "tendance_p": t["p"], "tendance_verdict": t["verdict"],
            f"jours_35c_ou_plus_par_ete_{lab['first']}": dec["days_ge_35"]["first"],
            f"jours_35c_ou_plus_par_ete_{lab['last']}": dec["days_ge_35"]["last"],
            "jours_35c_tendance_par_decennie": t35["slope_per_decade"], "jours_35c_tendance_p": t35["p"],
        },
        "demande_climatique_supplementaire_estimee_mm_jour": d["demand_link"]["ret_change_mm_day_estimate"],
        "demande_climatique_note": d["demand_link"]["note"],
        "solaire_pvgis": {
            "production_ete_kwh_par_kwc_jour": sol["summer_pv_kwh_per_kwp_day"],
            "correlation_production_solaire_et_demande_climatique_par_mois": sol["pv_vs_demand"]["r"],
            "mois_le_plus_productif": sol["best_month"],
            "a_saisir": sol["needs_user_input"],
            "pendant_une_coupure_steg": sol["during_outage"],
        },
        "limites": d["limits"],
    }
    if s:
        out["ecart_par_ete_mm_jour (demande moins eau utilisée, juin-sept.)"] = {str(x["year"]): x["gap_mm_day"] for x in s["seasons"]}
        out["ecart_pire_ete"] = s["worst"]
        out["ecart_meilleur_ete"] = s["best"]
        out["ecart_tendance_2018_2026"] = s["gap_trend"]["verdict"] if s["gap_trend"] else None
        out["ecart_et_chaleur_entre_etes"] = {"pente_mm_jour_par_c": s["gap_vs_heat"]["slope_per_c"], "p": s["gap_vs_heat"]["p"],
                                              "verdict": s["gap_vs_heat"]["verdict"]} if s["gap_vs_heat"] else None
    return out


def classify(message: str, history: list[dict]) -> dict | None:
    """Jev: intent, cause concerned and stance. None when Jev is not available."""
    state = {"message": message, "conversation_recente": [m["content"][:300] for m in history[-4:]],
             "causes": {c["id"]: c["label"] for c in CAUSES}}
    qs = {
        "intent": {"type": "choice", "instructions": "Que fait l'utilisateur dans `message` ?", "criteria": INTENTS},
        "cause": {"type": "choice", "instructions": "De quelle cause de `causes` parle `message` ?",
                  "criteria": {**{c["id"]: c["label"] for c in CAUSES}, "aucune": "aucune cause précise"}},
        "stance": {"type": "choice", "instructions": "Pour cette cause, `message` indique-t-il qu'elle est vraie ou fausse pour sa parcelle ?",
                   "criteria": {"confirm": "la cause est vraie ou probable", "reject": "la cause est fausse ou exclue",
                                "unsure": "ni l'un ni l'autre, ou il ne sait pas"}},
    }
    try:
        a = jev.decide(state, qs)["answers"]
    except (jev.JevNotConfigured, jev.JevError):
        return None
    return {k: {"choice": v["choice"], "confidence": v["confidence"]} for k, v in a.items()}


def suggest_feedback(intent: dict | None, message: str) -> dict | None:
    if not intent:
        return None
    if intent["intent"]["choice"] not in ("info_terrain", "avis_cause") or intent["cause"]["choice"] == "aucune":
        return None
    if intent["cause"]["confidence"] < 0.5:
        return None
    cause = next(c for c in CAUSES if c["id"] == intent["cause"]["choice"])
    verdict = intent["stance"]["choice"] if intent["stance"]["confidence"] >= 0.5 else "unsure"
    return {"cause_id": cause["id"], "cause_label": cause["label"], "verdict": verdict, "note": message[:500],
            "confidence": round(min(intent["cause"]["confidence"], intent["stance"]["confidence"]), 2)}


VERIFY_THRESHOLD = 0.6


def verify(ctx: dict, sources: list[dict], question: str, answer: str) -> dict | None:
    """Verifier agent (Jev): probability that the answer contains an unsupported claim or a wrong reasoning."""
    try:
        r = jev.decide({"contexte": ctx, "sources": [s["extrait"][:600] for s in sources],
                        "message_utilisateur": question, "reponse": answer},
                       {"non_appuye": {"type": "noul", "instructions":
                        "La `reponse` contient-elle une affirmation, un calcul ou une comparaison qui n'est appuyé ni par "
                        "`contexte`, ni par `sources`, ni par `message_utilisateur`, ou un raisonnement faux ?"}})
    except (jev.JevNotConfigured, jev.JevError):
        return None
    risk = r["answers"]["non_appuye"]["noul"]
    return {"risk": risk, "flagged": risk >= VERIFY_THRESHOLD, "regenerated": False, "model": r["model"]}


def chat(plot_id: str, messages: list[dict]) -> dict:
    """messages: [{role: user|assistant, content}], the last one is the user's."""
    if not messages or messages[-1]["role"] != "user":
        raise ValueError("the last message must come from the user")
    question = messages[-1]["content"].strip()[:2000]
    history = messages[:-1][-8:]
    ctx = context(plot_id)

    intent = classify(question, history)
    try:
        passages = rag.search(question, k=5)
        rag_status = "ok"
    except Exception as e:  # the assistant still answers from the analyses alone
        passages, rag_status = [], f"indisponible : {e}"
    sources = [{"n": f"S{i + 1}", "titre": p["title"], "organisme": p.get("organisation"), "extrait": p["text"][:1100]}
               for i, p in enumerate(passages)]

    sugg = suggest_feedback(intent, question)
    note = (f"\n\nNOTE : son message apporte une information sur la cause « {sugg['cause_label']} ». "
            "La page lui propose de l'enregistrer comme avis ; remercie-le et explique ce que cette information change "
            "ou ne change pas, sans dire qu'elle est déjà prise en compte.") if sugg else ""
    user_block = ("CONTEXTE (JSON) :\n" + json.dumps(ctx, ensure_ascii=False) + note +
                  "\n\nSOURCES :\n" + "\n\n".join(f"[{s['n']}] {s['titre']} ({s['organisme']}) :\n{s['extrait']}" for s in sources) +
                  f"\n\nQUESTION : {question}")
    convo = [{"role": "system", "content": SYSTEM}, *history, {"role": "user", "content": user_block}]
    out = llm.chat(convo)
    verification = verify(ctx, sources, question, out["text"])
    if verification and verification["risk"] >= VERIFY_THRESHOLD:
        retry = llm.chat(convo + [{"role": "assistant", "content": out["text"]},
                                  {"role": "user", "content": "Ta réponse contient une affirmation, un calcul ou une comparaison qui "
                                   "n'est pas appuyé par CONTEXTE ou SOURCES, ou un raisonnement faux. Réécris-la en restant "
                                   "strictement aux faits fournis, sans nouveau calcul."}])
        v2 = verify(ctx, sources, question, retry["text"])
        if v2 and v2["risk"] < verification["risk"]:
            out, verification = retry, {**v2, "regenerated": True, "first_risk": verification["risk"]}
    check = check_numbers(out["text"], {"c": ctx, "s": [s["extrait"] for s in sources], "q": question})
    cited = sorted({int(n) for n in __import__("re").findall(r"\[S(\d+)\]", out["text"]) if 0 < int(n) <= len(passages)})
    return {
        "answer": out["text"], "model": out["model"], "check": check,
        "citations": [{"n": f"S{i}", "title": passages[i - 1]["title"], "organisation": passages[i - 1].get("organisation"),
                       "url": passages[i - 1].get("url"), "path": passages[i - 1].get("path"),
                       "source_id": passages[i - 1]["source_id"], "score": passages[i - 1]["score"],
                       "snippet": passages[i - 1]["text"][:240]} for i in cited],
        "retrieved": len(passages), "rag": rag_status,
        "intent": intent, "suggested_feedback": sugg, "verification": verification,
    }


def status() -> dict:
    try:
        n, err = rag.count(), None
    except Exception as e:
        n, err = 0, str(e)
    return {"llm": llm.public_config(), "jev": jev.public_config(), "rag": {**rag.public_config(), "points": n, "error": err}}
