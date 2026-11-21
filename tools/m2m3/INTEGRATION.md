# Raccordement M2/M3 au projet d’équipe

## Lancer les deux applications

Depuis `tools/m2m3`, lancer `python -m mizu_m2m3.web` avec l’environnement décrit dans le [README](README.md). Le workbench écoute sur `127.0.0.1:8765`. Le backend M6 peut tourner sur son port habituel. Le dossier isolé et le module Python `mizu_m2m3` facilitent l’intégration avec les branches qui utilisent déjà `backend`, `frontend` et `data` à la racine.

Exécuter `python -m pytest -q` depuis `tools/m2m3`. La démo tourne hors ligne après installation des dépendances Python.

## Vérifier les échanges

Depuis PowerShell, serveur démarré :

```powershell
$base = 'http://127.0.0.1:8765'
$pv = Invoke-RestMethod "$base/api/solar/profile" -Method Post -ContentType 'application/json' `
  -Body '{"site_id":"jendouba-pilote","option_id":"ombriere","day":"2023-06-21"}'
$pv.slots.Count

$payload = @{
  reference = 0.5
  missing_flow_slots = @(1)
  states = @(
    @{site_id='jendouba-pilote'; simulation_slot=0; timestamp='2026-11-21T00:00:00+01:00';
      tank_stock_m3=24; pumped_m3=5; water_in_m3=5; distributed_m3=5;
      consumed_wh=2500; solar_wh=0; grid_available=$true}
    @{site_id='jendouba-pilote'; simulation_slot=1; timestamp='2026-11-21T01:00:00+01:00';
      tank_stock_m3=22; pumped_m3=0; water_in_m3=0; distributed_m3=2;
      consumed_wh=0; solar_wh=0; grid_available=$false}
  )
} | ConvertTo-Json -Depth 5
$iot = Invoke-RestMethod "$base/api/telemetry/project" -Method Post -ContentType 'application/json' -Body $payload
$iot.measurements | Where-Object { $_.quality -eq 'missing' }
```

Le premier appel renvoie 24 valeurs horaires en Wh. Le second signale le débitmètre `pump-flow-01` comme `missing` au créneau 1. Les autres capteurs transmettent la coupure et le stock de 22 m³. Une requête invalide renvoie HTTP 422 avec le champ ou l’état concerné.

## Points de raccordement

| Besoin | Sortie M2/M3 | Correspondance côté équipe |
| --- | --- | --- |
| Appliquer une option photovoltaïque | `POST /api/solar/profile` renvoie `solar_option_id`, `source_id` et `slots[].solar_wh`. | Copier les Wh par créneau dans le `Slot.solar_wh` de M4, ou enregistrer le tableau dans `data/energy/<site_id>.json` comme `SolarOption.profile_wh` pour le catalogue M6. Ensuite, appeler `POST /api/compare` avec cet identifiant dans `solar_option_id`. |
| Afficher la comparaison solaire | Le workbench sert `POST /api/solar`. | M6 expose `POST /api/solar/compare` et utilise `price_tnd_per_kwh` dans sa requête. Le workbench attend `price`. |
| Transformer un résultat M4 en télémétrie | `POST /api/telemetry/project` reçoit des états horaires. | Faire correspondre `SlotBalance.slot` à `simulation_slot`, `pump_m3` à `pumped_m3` et `water_in_m3` dans le cas d’une alimentation unique par la pompe, `delivered_m3` à `distributed_m3`, `pump_wh` à `consumed_wh`, et conserver `tank_stock_m3`. Prendre `grid_available` et le potentiel `solar_wh` dans le créneau du scénario. `SlotBalance.solar_wh` contient l’énergie déjà consommée. |
| Afficher les mesures et alertes | `measurements[]` contient les identifiants de station, équipement et capteur, ainsi que l’heure UTC, la valeur, l’unité et la qualité. | M6 peut diffuser ces messages à M7. Utiliser `site_id` et `sensor_id` pour identifier une série. Traiter `null` selon `quality`. Les règles d’alerte sont documentées dans le [contrat IoT](M2-M3-IOT.md). |
| Enregistrer un scénario J+1 | `POST /api/weather` exporte `central` et `adverse` pour la même journée. | Le `WeatherPair` de M6 attend `id`, `central`, `adverse` et `reason`. Garder les champs du modèle `WeatherProfile` et retirer les métadonnées d’export supplémentaires. Enregistrer la paire dans le catalogue et la référencer dans `ScenarioRecord.weather_pair_id`. |

Le schéma `SolarOption` de M6 utilise un azimut de boussole. Pour convertir l’azimut PVGIS, dont le zéro est au sud, appliquer `(180 + azimut_pvgis) % 360`. Le catalogue M6 exige aussi que `source_id` référence une fiche enregistrée. Préserver la provenance `estimated` des profils PVGIS et la provenance `simulated` des scénarios d’essai.

Pour la réserve J+1, appeler `POST /api/compare` avec `planning_mode: "weather_buffer"` et la paire enregistrée dans `weather_pair_id`. Les deux profils alimentent M4/M5. Le solveur M5 calcule le volume à pomper en avance et les déficits restants.

## Recette conseillée après intégration

1. Appliquer **Solar canopy** et vérifier que les 24 Wh horaires du scénario M4 correspondent au profil sélectionné.
2. Simuler une coupure et vérifier que la pompe et le solaire raccordé sont à zéro, tandis que la gravité peut encore utiliser le stock.
3. Injecter une perte de débitmètre. M7 doit afficher la valeur manquante et éviter de prolonger une série d’alerte d’efficacité à travers cette absence.
4. Rejouer la réserve J+1 du cahier avec les profils de référence. Le plan nominal livre 6 m³ dans le profil défavorable. La réserve permet d’en livrer 8 m³ en pompant 2 m³ plus tôt.

Le workbench de cette branche fournit les calculs et le replay local. Ces vérifications de raccordement devront être exécutées avec les versions M4, M5, M6 et M7 retenues par l’équipe.
