# Mizhuo · M7

Interface de cartographie et de simulation des tours d’eau pour le périmètre pilote de Jendouba.

## Démarrer

Node.js 22.12 ou une version ultérieure.

```powershell
cd frontend
npm ci
npm run dev
```

Ouvrir [la démo locale](http://localhost:5173/?mode=demo). Le site, les parcelles, les profils solaires et les scénarios sont simulés. Les deux vues cartographiques fonctionnent sans fond en ligne. La carte 2D prend le relais si WebGL est indisponible.

## Parcours de vérification

1. Ouvrir la carte, sélectionner une parcelle et consulter sa provenance. Activer **Anomalies hydrauliques** et sélectionner le compteur pour examiner le résidu simulé de 13 m³.
2. Ouvrir **Comparer les options solaires**, examiner les deux profils à 10 kWc et transmettre une option à la simulation. Le tarif est facultatif. Les chiffres dérivés restent indisponibles quand leurs entrées manquent.
3. Sélectionner **Cas miniature A/B** et lancer le calcul. Le tour fixe livre 10 m³ à A. Le plan proposé livre 5 m³ à chacun pendant la coupure et fait passer la couverture minimale de 0 à 50 %.
4. Valider le plan, puis modifier le stock. La comparaison précédente reste visible avec le statut **Résultat périmé** et la validation redevient disponible après un nouveau calcul valide. Avec **Coupures successives**, sélectionner H12 pour inspecter la reprise.
5. Sélectionner **Réserve météo J+1**. La réserve avance 2 m³ avant 11 h et porte le service de 6 à 8 m³. Avec un quota ramené à 5 m³, le déficit résiduel vaut 2 m³. **Réserve J+1 · Profil stable** demande 0 m³ de réserve.

## Intégration M6

Au démarrage, l’interface essaie `GET /api/sites` et `GET /api/scenarios`. En développement, Vite transmet `/api` à `http://127.0.0.1:8000`. Pour modifier la cible, renseigner `MIZU_API_TARGET` dans un fichier `frontend/.env.local`. En production, servir `frontend/dist` et transmettre `/api` à M6 sur la même origine.

Les couches utilisent les identifiants `plots`, `solar`, `wind` et `anomalies`. La couche solaire fournit un `option_id` pour chaque configuration. Les comparaisons et les fiches sont demandées via `POST /api/solar/compare`, `POST /api/compare` et `GET /api/evidence/{source_id}`. Le plafond de reprise est transmis en watts dans le champ facultatif `restart_grid_cap_w`. Le mode météo envoie une paire déclarée par le scénario dans `weather_pair_id`.

Si le catalogue M6 est inaccessible au démarrage, l’interface ouvre la démo et affiche **Données simulées**. `VITE_DATA_MODE=live` permet de diagnostiquer la connexion sans basculer automatiquement. La démo embarque un calcul heuristique reproductible. Le solveur et les données d’exploitation sont fournis par M6 en mode connecté.

Le fond OpenStreetMap est facultatif. Pour une autre source de tuiles, renseigner ensemble `VITE_MAP_TILES_URL` et `VITE_MAP_TILES_ATTRIBUTION`. Les couches du site restent inspectables dans le menu de la carte 2D.

## Vérifications locales

```powershell
npm test
npm run build
```
