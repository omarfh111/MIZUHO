"""Consequences to explain and the candidate causes for each one.

A cause lists the observation it predicts and the data needed to test it. The
Data agent tests it when that data exists; otherwise it stays open for the field.
"""
from __future__ import annotations

CONSEQUENCES = {
    "summer_gap": {
        "id": "summer_gap",
        "label": "En saison sèche, l'eau réellement utilisée reste très inférieure à la demande climatique",
        "metric": "rapport AETI / ET de référence, juin à septembre",
    },
}

CAUSES = [
    {"id": "water_supply", "label": "Apport d'irrigation insuffisant",
     "mechanism": "La parcelle ne reçoit pas assez d'eau : l'eau utilisée reste basse même quand la demande monte.",
     "prediction": "Rapport AETI/ET0 bas en été et AETI qui ne suit pas la température alors que l'ET0 la suit.",
     "data": ["WaPOR AETI", "WaPOR ET0", "NASA POWER température"]},
    {"id": "heat_stress", "label": "Stress thermique de la culture",
     "mechanism": "La chaleur fait fermer les stomates : la plante transpire moins quand il fait plus chaud.",
     "prediction": "AETI qui baisse significativement quand la température monte, en été.",
     "data": ["WaPOR AETI", "NASA POWER température"]},
    {"id": "no_rain", "label": "Absence de pluie en été",
     "mechanism": "Sans pluie, seule l'irrigation alimente la parcelle.",
     "prediction": "AETI qui suit la pluie sur l'année ; pluie quasi nulle en été.",
     "data": ["WaPOR AETI", "NASA POWER pluie"]},
    {"id": "fallow", "label": "Parcelle en jachère ou culture déjà récoltée",
     "mechanism": "Sans culture active en été, il n'y a presque rien pour transpirer.",
     "prediction": "AETI d'été proche du sol nu (moins de 1 mm/jour) et pic au printemps.",
     "data": ["WaPOR AETI"]},
    {"id": "power_cuts", "label": "Coupures électriques qui arrêtent le pompage",
     "mechanism": "Pendant les coupures STEG, la pompe ne tourne pas et les tours d'eau prennent du retard.",
     "prediction": "Baisse d'AETI pendant la période des coupures par rapport aux autres années.",
     "data": ["WaPOR AETI", "relevés des coupures STEG (une seule annonce connue : 19 juillet 2026)"]},
    {"id": "quota", "label": "Quota de prélèvement trop bas",
     "mechanism": "Le quota attribué au groupement limite le volume pompé.",
     "prediction": "Volumes prélevés plafonnés au quota.",
     "data": ["quota CRDA / GDA", "volumes pompés"]},
    {"id": "leaks", "label": "Pertes et fuites du réseau",
     "mechanism": "Une partie de l'eau pompée n'arrive pas à la parcelle.",
     "prediction": "Écart entre volume pompé et volume livré.",
     "data": ["compteurs pompe et parcelle"]},
    {"id": "salinity", "label": "Salinité de l'eau ou du sol",
     "mechanism": "Le sel réduit l'absorption d'eau par la plante.",
     "prediction": "Conductivité élevée de l'eau d'irrigation ou du sol.",
     "data": ["analyses de conductivité"]},
    {"id": "pump", "label": "Pompe en panne ou sous-dimensionnée",
     "mechanism": "La pompe ne fournit pas le débit nécessaire.",
     "prediction": "Débit bas ou kWh/m³ en hausse.",
     "data": ["télémétrie pompe (kWh, m³)"]},
    {"id": "satellite", "label": "Erreur de mesure satellite",
     "mechanism": "Parcelle trop petite pour les pixels de 100 m : la valeur mélange la parcelle et ses voisins.",
     "prediction": "Moins de 4 pixels WaPOR sur la parcelle.",
     "data": ["géométrie OSM", "grille WaPOR 100 m"]},
]

CAUSE_IDS = [c["id"] for c in CAUSES]
