# Membre 2 · Télémétrie M2/M3

Le workbench rejoue trois stations simulées et publie des mesures par capteur. M2 prépare le profil de production photovoltaïque. M3 transforme les états horaires en observations, qualifie les valeurs manquantes et exécute les contrôles du bilan d’eau et de l’énergie de pompage.

## Démo locale

1. Ouvrir **Solar comparison**, comparer les deux installations et cliquer sur **Apply to simulation**. Le profil PVGIS choisi est utilisé pour calculer la production, l’autoconsommation de la pompe et le prélèvement électrique sur le réseau. La date du profil de référence apparaît dans la simulation.
2. Dans **Simulation**, déclencher **Flow sensor dropout**. Pour les deux prochaines heures simulées, le débit mesuré est `null`, avec la qualité `missing`. Cette interruption coupe la série utilisée pour l’alerte d’efficacité. Les volumes physiques du réservoir et les autres capteurs restent disponibles.
3. Déclencher **Grid outage** pendant une heure ensoleillée. La pompe et le photovoltaïque raccordé s’arrêtent. La distribution par gravité continue tant que le stock le permet.
4. Dans **Virtual sensors**, inspecter les valeurs courantes ou télécharger la télémétrie et les alertes du replay en JSON.

Le calcul local applique la production solaire à une demande de pompage donnée pour comparer les sources d’énergie. Le calcul de la capacité de pompage, du quota et du planning vient de M4/M5 lors de l’intégration.

## Contrat pour M4, M5, M6 et M7

| Entrée locale | Requête | Résultat |
| --- | --- | --- |
| `POST /api/solar/profile` | `site_id`, `option_id`, `day` facultatif. | `solar_option_id`, provenance, date du profil, fuseau et 24 entrées `slot` / `solar_wh` à transmettre à M4. |
| `POST /api/telemetry/project` | `states`, `reference` facultative en kWh/m³ et `missing_flow_slots` facultatif. | `records`, `measurements`, `alerts` et `diagnostics`. |

M4 fournit ses états horaires dans l’ordre des créneaux, pour un seul `site_id` par requête. Exemple pour le premier créneau d’une station :

```json
{
  "reference": 0.5,
  "missing_flow_slots": [],
  "states": [
    {
      "site_id": "jendouba-pilote",
      "timestamp": "2026-11-21T00:00:00+01:00",
      "simulation_slot": 0,
      "tank_stock_m3": 24,
      "pumped_m3": 5,
      "water_in_m3": 5,
      "distributed_m3": 5,
      "consumed_wh": 2500,
      "solar_wh": 0,
      "grid_available": true
    }
  ]
}
```

`tank_stock_m3` est le stock en fin de créneau. `solar_wh` représente le potentiel solaire avant prise en compte de la coupure. Les quantités d’eau sont intégrées sur une heure. Les mesures de débit les expriment en m³/h. La puissance est la moyenne horaire et le cumul de la pompe est calculé quand la série est complète depuis le créneau 0.

Chaque mesure contient `site_id`, `equipment_id`, `sensor_id`, `simulation_slot`, `timestamp` en UTC, `metric`, `value`, `unit`, `source` et `quality`. Le matériel et le capteur sont identifiés de manière stable au sein de la station. `valid` signifie qu’une mesure est disponible, y compris la valeur zéro. `missing` indique une absence simulée et `unavailable` un signal que la source ne permet pas de calculer. Le tableau `measurements` peut être envoyé à l’interface par M6.

| Équipement | Capteurs |
| --- | --- |
| `tank-01` | `tank-level-01`, `inlet-flow-01` |
| `pump-01` | `pump-flow-01`, `pump-power-01`, `pump-energy-01` |
| `distribution-01` | `delivery-flow-01` |
| `pv-01` | `pv-generation-01`, `pv-use-01` |
| `grid-01` | `grid-import-01`, `grid-state-01` |

La source du replay est indiquée par `physical_source: "local_replay"`. Le raccordement au moteur M4 consistera à remplacer ces états locaux par ses sorties en utilisant le contrat de projection ci-dessus.
