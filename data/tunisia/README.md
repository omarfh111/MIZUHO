# Tunisia atlas data

`catalog.json` contains a refreshable snapshot of 24 governorate capitals, the simplified governorate boundaries, local DEM grids and a dated climate summary for each capital. The API reads this archive so the atlas remains usable without upstream calls during a presentation. The browser requests the current archive and the selected city's profile.

From the repository root with the project's Python dependencies installed:

```powershell
python -m pip install -r tools/tunisia/requirements.txt
python -m tools.tunisia.refresh --start 2025-01-01 --end 2025-12-31
```

Omitting both dates selects the previous complete calendar year. Use `--output-dir` to inspect a download before replacing the app archive. A complete refresh validates the source responses and replaces the previous file atomically. `--allow-partial` records unavailable city datasets as null for troubleshooting. A refresh contacts the upstream providers and uses the configured operating-system TLS trust store. The city detail endpoints serve the new archive after replacement without an application restart.

| Data | Provenance and precision |
| --- | --- |
| Governorate boundaries | [geoBoundaries Tunisia ADM1](https://www.geoboundaries.org/api/current/gbOpen/TUN/ADM1/) simplified archive, based on © OpenStreetMap contributors under the [Open Database License](https://www.openstreetmap.org/copyright). The source metadata names the release and reference year. |
| Capital locations | [GeoNames Tunisia country archive](https://download.geonames.org/export/dump/TN.zip), CC BY 4.0. The importer selects the country capital and first-order administrative seats. Names, coordinates, IDs and population are gazetteer records. |
| Elevation | [Copernicus 2021 GLO-90 tiles](https://registry.opendata.aws/copernicus-dem/) provide surface heights. The importer samples the nearest image cells using the source GeoTIFF transform. Each 15×15 grid covers approximately 12 km × 12 km around its city. Archive sample spacing is about 860 m. |
| Climate | [NASA POWER Daily API](https://power.larc.nasa.gov/docs/services/api/temporal/daily/) supplies MERRA-2 meteorology and SYN1DEG radiation for the location. The summary uses complete UTC days across the named period. Temperature and horizontal solar irradiation are averaged, precipitation is summed. Every city record links to its query. |

The archive stores SHA-256 hashes of the source responses. The DEM fingerprint combines source tiles sorted by their URLs. NASA includes processing times in its JSON, so reruns may have different response hashes while returning the same series. Normalized daily entries are stored as temperature in °C, precipitation in mm and irradiation in kWh/m²/day. An incomplete day is null. Requesting `/api/tunisia/cities/{id}?start=2025-01-01&end=2025-06-30` calculates the summary for that inclusive interval over regional grid cells. The planner's water, outage and IoT figures have separate provenance in the [project data manifest](../manifest.json).

Produced using Copernicus WorldDEM™-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM™-90. [Copernicus DEM licence](https://dataspace.copernicus.eu/sites/default/files/media/files/2025-06/copernicus_contributing_mission_data_access_v2_cop_dem_licenses.pdf)
