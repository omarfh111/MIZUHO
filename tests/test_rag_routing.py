import pytest

from backend.rag_assistant import route
from backend.rag_store import sparse_vector


@pytest.mark.parametrize(("question", "theme", "label"), [
    ("Comment suivre les prélèvements des nappes souterraines ?", "eau", "Nappes et prélèvements"),
    ("Comment est calculée l’évapotranspiration dans WaPOR ?", "agriculture", "Télédétection et WaPOR"),
    ("Quelles contraintes pour l’onduleur photovoltaïque ?", "energie", "Photovoltaïque et implantation"),
    ("Comment anticiper les fortes températures ?", "climat", "Météo et risque opérationnel"),
])
def test_routes_to_a_domain_specialist(question, theme, label):
    assert any(path == theme and agent.label == label for path, agent in route(question))


def test_routes_a_cross_domain_question():
    themes = {theme for theme, _ in route("Comment alimenter une pompe solaire pour irriguer les parcelles ?")}
    assert themes == {"energie", "agriculture"}


def test_sparse_vectors_share_indices_for_accented_terms():
    query = sparse_vector("Évapotranspiration", query=True)
    document = sparse_vector("evapotranspiration réelle")
    assert len(query["indices"]) == 1
    assert set(query["indices"]) <= set(document["indices"])
    assert query["values"] == [1.0]
