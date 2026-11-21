# MIZUHO

Le backend de planification compare un tour d’eau fixe à un plan optimisé. Il simule les coupures et la reprise. Le comparatif météo évalue un préremplissage du réservoir sur un profil central et un profil défavorable.

## Démarrage local

Python 3.12 est requis.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
```

## Intégration avec l’API

Les types sont dans `backend/planning_models.py`. Le lot API peut les importer pour valider ses données. Sur le prototype, un exploitant correspond à une parcelle et le jour comporte au plus 24 créneaux d’une heure.

| Fonction | Résultat |
| --- | --- |
| `simulate(scenario, state, actions)` | Bilans physiques par créneau, résultats par parcelle et violations. Une action invalide termine la simulation avec le créneau et la règle enfreinte. |
| `build_baseline(scenario, state)` | Tour fixe limité aux ressources disponibles, puis vérifié par le simulateur. En l’absence de planning de pompage ou de livraison, renvoie le statut `NO_SOLUTION` avec `fixed_schedule_unavailable`. |
| `optimize(scenario, state)` | Plan CP-SAT validé par le simulateur. En cas de limite de calcul, le statut indique si un plan faisable est disponible. |
| `replan_after_outage(scenario, state, outage_slots=...)` | Recalcul des créneaux restants depuis le dernier état validé, avec les nouvelles coupures et les coupures déjà prévues. |
| `compare_weather(central, adverse, state, risk_start_slot=...)` | Planning établi sur le profil central puis rejoué sur l’aléa, plan avec réserve sur le même aléa, volume anticipé et déficit résiduel. |

Les résultats Pydantic se sérialisent avec `model_dump(mode="json")`. Les volumes et l’énergie du planning utilisent m³ et Wh. Dans un créneau d’une heure, l’import réseau en Wh correspond numériquement à la puissance moyenne en W. Les métriques de volume et d’énergie portent sur la période recalculée, et la couverture par parcelle inclut les livraisons historiques renseignées.

L’état au moment du recalcul provient des mesures du site. Le moteur vérifie que les volumes historiques déclarés peuvent tenir dans les créneaux de livraison passés. Le bilan physique complet part du stock et du quota observés à partir de cet instant.

### États physiques et reprise après une coupure

Pour rejouer un incident en simulation, appeler `simulate` avec les actions exécutées et `stop_before_slot` égal au premier créneau à replanifier. La borne est exclusive. Un créneau sans action est considéré au repos. En cas de succès, `end_state` contient le stock, le quota restant et les livraisons cumulées et à l’heure. Une simulation interrompue par une violation laisse `end_state` à `null`.

Pour recalculer, passer cet état simulé, ou le dernier état terrain validé, à `replan_after_outage`. Fournir les créneaux de coupure dans l’horizon restant. Le plan commence à `state.current_slot` et tient compte des livraisons déjà effectuées et de la réserve restante. Selon l’hypothèse photovoltaïque raccordée au réseau, une coupure rend le solaire et le réseau indisponibles pour la pompe. La distribution gravitaire reste possible dans les limites du stock, du débit et des créneaux des parcelles.

M3, M6 et M7 peuvent consommer la même chronologie `slots` de M4. Chaque bilan indique le stock avant et après le créneau, le quota restant, le volume pompé, les livraisons par `plot_id`, l’énergie de la pompe et sa répartition solaire/réseau, le solaire utilisable et la disponibilité et la limite du réseau. La pompe fonctionne dans le modèle quand `pump_m3` est positif. Les volumes sont exprimés en m³ par créneau d’une heure et les énergies en Wh. Pour horodater ces états calculés, l’intégration fournit l’origine et le fuseau du scénario et utilise l’index du créneau. Elle conserve la provenance de l’état initial et le statut calculé des résultats.

Pour une comparaison météo, le lot API construit les deux objets `Scenario` avec les équipements, règles et état du même site. Les conditions horaires avant le risque sont communes. Le champ `early_pump_m3` donne le total à pomper avant ce créneau et `additional_early_pump_m3` le supplément par rapport au plan nominal. Les actions avant le risque sont identiques pour les deux plans de réserve. À couverture, anticipation et consommation de ressources égales, le moteur maximise le volume distribué. Une valeur inconnue est représentée par `null`.

## Données de la station de Bouhertma

Le [CSV officiel et son attribution](data/weather/README.md) documentent le rayonnement mesuré à Jendouba. La suite publiée vérifie l’empreinte de la copie et l’extraction des relevés. Les mesures offrent un historique de rayonnement pour le lot météo. Un planning terrain demande en plus des profils photovoltaïques, des mesures ou journaux d’exploitation pour le stock, les coupures et le quota, et les besoins des parcelles fournis par le gestionnaire.
