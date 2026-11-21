# Bouhertma radiation observations

The Tunisian Ministry of Agriculture, Hydraulic Resources and Fisheries publishes FieldClimate records for the GDA Bouhertma station in Jendouba. The original CSV is redistributed under the [Tunisian National Open Data Licence](https://data.gov.tn/fr/licences/licence-nationale/). [Catalogue](https://catalog.data.gov.tn/dataset/station-climatique-station-jendouba-gda-bouhertma-fieldclimate) · [CSV resource](https://catalog.agridata.tn/dataset/1b107563-e9b2-43b9-b082-500fd38d716b/resource/8db5d2d8-586a-4dd3-bedd-9690295b6fe3/download/002131f2_station-jendouba-gda-bouhertma.csv)

The integration preserves the archived bytes from `feature/irrigation-planning`. SHA-256 `d27b8d6ffaffe68461bc954fea116651e1f58518a6936d0bdc8939640c10436d`.

`GET /api/weather/bouhertma?day=2026-05-08` returns the reported hourly solar radiation readings in W/m². An omitted date selects the last date in the archive. Missing hours have no entries. The publisher did not specify a timezone. These measurements describe the station; converting them into parcel-level water demand or hourly PV electricity would require additional assumptions.
