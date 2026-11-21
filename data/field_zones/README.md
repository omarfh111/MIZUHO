# Researched agricultural zones

These profiles cover three agricultural settings with distinct water-management questions. Each record describes an approximately 10 × 10 km window around a documented reference point. The window can include settlement, water and other land uses.

| Zone | Why it was selected | Reference point |
| --- | --- | --- |
| **Korba, Cap Bon** | Coastal groundwater and documented vulnerability to seawater intrusion. The site raises questions about well conductivity, levels and permitted withdrawals before planning irrigation. [Aquifer study](https://doi.org/10.3390/w14071177) · [Field investigation](https://doi.org/10.1016/j.jafrearsci.2013.07.009) | Korba town, 36.57861° N, 10.85861° E. [GeoNames](https://www.geonames.org/2467920/korba.html) |
| **Kairouan Plain, Chebika** | A semi-arid agricultural plain where researchers studied how to distinguish irrigation from other satellite signals. Rainfall, irrigation events and crop calendars are needed to interpret a specific plot. [Sentinel field study](https://doi.org/10.3390/rs10121953) | Published study reference, 35°34′51″ N, 9°53′57″ E. [Study map and methods](https://horizon.documentation.ird.fr/exl-doc/pleins_textes/divers19-02/010074950.pdf) |
| **Gafsa, El Ksar** | Inland oasis landscape with layered cultivation and traditional rotating water access. Actual canal flows and water turns would be required to model its delivery network. [FAO heritage profile](https://www.fao.org/giahs/giahs-around-the-world/gafsa-oases--tunisia/en) · [Tunisian Ministry of Environment](https://www.environnement.gov.tn/tunisie-environnement/la-diversite-biologique/les-systemes-ingenieux-du-patrimoine-agricole-mondial-sipam-en-tunisie) | El Ksar, 34.39920° N, 8.80399° E. [GeoNames](https://www.geonames.org/2473466/) |

The selector lists all three alongside Assila and the Jendouba planning pilot. The atlas links nearby registered sites. Each profile shares its evidence with the same assistant used by the pilot.

## Site-specific 3D scenes

The default surface is a real **Sentinel-2 annual natural-colour composite for 2021**. The satellite image, land-cover classification and Copernicus elevations share the scene's WGS84 bounds. Korba includes the lagoon and coast, Chebika covers the inland agricultural plain and El Ksar the oasis edge. The archived 768 × 768 crops remain usable offline. The source WMS request for each image, its hash and the display file hash are recorded in the [imagery manifest](../../frontend/src/assets/site-imagery/manifest.json). The WMS 1.3 EPSG:4326 request uses latitude–longitude axis order. The image spans the full displayed DEM from northwest to southeast. [ESA WorldCover data, annual composites and licence](https://esa-worldcover.org/en/data-access)

The two demonstration outlets coincide with the solver's cropland service points. The layout chooses a hypothetical station on mapped cropland in the north-central part of each window, scoring local elevation and distance from the centre. The branches follow connected dry land-cover cells to each outlet. These are illustrative positions and alignments. No survey establishes hydraulic head, pipes, electrical connections, land ownership or equipment at those coordinates. Trees and built-up structures are representative class symbols. Equipment is enlarged for legibility. During playback, the simulated tank level, pump indicator, grid indicator and directional flow use the chosen plan's hourly physical results. A different sharing rule changes the deliveries without relocating the same installation.

Assila uses the five original OpenStreetMap parcel boundaries and their WaPOR layer over a separately cropped Copernicus surface and Sentinel-2 image. Crop identity, water rights and delivery windows are unverified there. Jendouba retains its explicitly fictional, reproducible pilot geometry.

To rebuild the Assila terrain and refresh the images, install the atlas import dependencies and run the following from the repository root. The frontend build embeds the resulting assets and makes no WMS requests during the demonstration.

```powershell
python -m pip install -r tools/tunisia/requirements.txt
python -m tools.m1.refresh_relief
python -m tools.field_zones.refresh_imagery
```

## Data and refresh

- **Land cover.** ESA WorldCover 2021 v200 is a satellite-derived categorical map. The importer tallies valid pixels in the source 10 m window, including water, and builds a 128 × 128 preview by dominant class. The 3D renderer projects that preview over the local relief. A tree-cover pixel can contain cultivated trees. Class shares do not measure currently irrigated hectares. [Dataset and licence](https://esa-worldcover.org/en/data-access) · [Product DOI](https://doi.org/10.5281/zenodo.7254221)
- **Terrain.** The importer samples actual Copernicus GLO-90 elevations on a 33 × 33 mesh. The mesh emphasizes height by the multiplier printed on screen. Source tiles, hashes, dates and attribution are included alongside the geometry. [Original tiles and licence](https://registry.opendata.aws/copernicus-dem/)
- **Climate.** The saved summary uses 365 complete days from NASA POWER in 2025. Temperature and irradiation are means and precipitation is a sum. The gridded records describe the regional reference point. The same sources and values drive both the UI and the assistant. [NASA POWER Daily API](https://power.larc.nasa.gov/docs/services/api/temporal/daily/)

Run from the repository root after installing the app's Python dependencies.

```powershell
python -m pip install -r tools/field_zones/requirements.txt
python -m tools.field_zones.refresh --year 2025 --cache-dir .venv/field-sources
```

The importer can download approximately 176 MB of original WorldCover tiles and keeps them in the cache directory. It validates all three windows before writing their compact profiles. It also fetches the Copernicus terrain and NASA climate sources. Restart the API to load refreshed files. The app can serve the committed derived data without contacting the data publishers at startup.

The WorldCover map is © ESA WorldCover project 2021 and contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. Produced using Copernicus WorldDEM™-90 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018 provided under COPERNICUS by the European Union and ESA. [Copernicus licence and attribution](../tunisia/README.md)
