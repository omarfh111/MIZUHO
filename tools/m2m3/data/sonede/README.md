# SONEDE public drinking-water data

Downloaded on 21 November 2026. The national open-data catalog lists SONEDE as the publisher and the Licence Nationale de Données Publiques Ouvertes for the spreadsheets. The statistical report comes from SONEDE’s website. [SONEDE catalog](https://catalog.data.gov.tn/producteurs-de-donnees/sonede)

| File | Coverage and units | Source |
| --- | --- | --- |
| [jendouba-monthly-distribution.csv](jendouba-monthly-distribution.csv) | Jendouba, January 2019 to December 2024. 72 monthly drinking-water volumes in m³. | Derived from `Feuil1` of the governorate workbook below. |
| [monthly-distribution-governorates.xlsx](monthly-distribution-governorates.xlsx) | Monthly distribution by reported area, 2019–2024, in thousands of m³. | [Catalog entry](https://catalog.data.gov.tn/fr/dataset/2461d646-1d22-4978-805f-517291307c3c/resource/ad4425b8-8f29-4c2e-80bc-263be848637f) |
| [monthly-distribution-tunisia.xlsx](monthly-distribution-tunisia.xlsx) | National monthly distribution, 2002–2024, in thousands of m³. | [Catalog entry](https://catalog.data.gov.tn/fr/dataset/2461d646-1d22-4978-805f-517291307c3c/resource/aea613de-387c-4367-9215-e085fe6456dd) |
| [annual-consumption-by-use-and-region.xlsx](annual-consumption-by-use-and-region.xlsx) | Annual billed consumption by district and use, 2007–2024, in thousands of m³. Contains a Jendouba district series. | [Catalog entry](https://catalog.data.gov.tn/fr/dataset/b95c240f-939a-454a-9ecd-9f18e48c479b/resource/3ab140a0-53af-4d20-b551-40951c4330c6) |
| [production-by-supply-hub.xlsx](production-by-supply-hub.xlsx) | Annual production by hub, 2017–2024, including `Nord Ouest`. The catalog states millions of m³, although the workbook column ends in `m3`. | [Catalog entry](https://catalog.data.gov.tn/fr/dataset/8b9dac3b-e74d-4d8e-8b89-2411ee9c75aa/resource/04fafedc-bced-436e-8813-a885bb047871) |
| [repaired-leaks.xlsx](repaired-leaks.xlsx) | Annual repair counts, 2002–2020, for transmission, distribution, and service connections. | [Catalog entry](https://catalog.data.gov.tn/fr/dataset/0fbdddff-3fd5-4dad-b7f6-783b8f57813e/resource/3d489a13-a162-4b10-9f24-9d227a90d219) |
| [statistical-report-2023.pdf](statistical-report-2023.pdf) | SONEDE’s 2023 statistical summary, published in June 2024. | [SONEDE report](https://www.sonede.com.tn/wp-content/uploads/2024/09/rapport_synthese2023.pdf) |

The CSV selects the six rows labeled `Jendouba`, converts each of the 12 month columns into a separate row, and multiplies source values by 1,000 to express them in m³. It contains no interpolated values. The 2024 total is 16,743,572 m³, with the highest monthly volume in August at 1,856,568 m³.

These are aggregate drinking-water records suitable for regional context and monthly seasonality analysis. The M3 forecast and anomaly detector require hourly irrigation-station telemetry with pump energy, pumped and delivered volumes, tank stock, and grid availability.
