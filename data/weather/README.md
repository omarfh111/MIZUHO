# Station climatique du GDA de Bouhertma

- Producteur — Ministère tunisien de l’Agriculture, des Ressources Hydrauliques et de la Pêche.
- Source — [Fiche du catalogue national](https://catalog.data.gov.tn/dataset/station-climatique-station-jendouba-gda-bouhertma-fieldclimate) et [CSV du portail sectoriel](https://catalog.agridata.tn/dataset/1b107563-e9b2-43b9-b082-500fd38d716b/resource/8db5d2d8-586a-4dd3-bedd-9690295b6fe3/download/002131f2_station-jendouba-gda-bouhertma.csv).
- Métadonnées mises à jour le 21 novembre 2026. Copie téléchargée le 21 novembre 2026.
- Licence — [Licence nationale de données publiques ouvertes](https://data.gov.tn/fr/licences/licence-nationale/).
- Fichier d’origine — `bouhertma-fieldclimate.csv`. SHA-256 `d27b8d6ffaffe68461bc954fea116651e1f58518a6936d0bdc8939640c10436d`.

L’export compte 17 703 lignes, dont 2 529 relevés de rayonnement solaire en W/m². Les horodatages publiés vont du 18 avril 2026 à 00 h au 14 septembre 2026 à 06 h. Les relevés de rayonnement sont horodatés à l’heure et comportent quatre interruptions de série. Le CSV ne précise pas le fuseau et ne contient pas de série de température.

`read_radiation` sélectionne les lignes de rayonnement, valide l’unité et trie les relevés par date. Il conserve les valeurs et les intervalles manquants. Le rayonnement rapporte une puissance par surface. Pour obtenir les Wh photovoltaïques demandés par le moteur, il faut un compteur ou un modèle documenté avec des paramètres du site et une provenance explicite.
