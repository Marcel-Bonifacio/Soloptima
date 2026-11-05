# Soloptima terms of use

Version 1.3 · effective 6 November 2026

These terms apply to everyone who uses Soloptima. You accept them when you create a profile. Soloptima asks again whenever this version changes.

## 1. Licence

Soloptima is open source under the Apache License, Version 2.0 (`LICENSE`). You may use, copy, change and distribute it, for commercial purposes too, under the conditions of that licence. The licence alone defines these rights; this section summarises it, and `LICENSE` prevails where they differ.

If you pass on copies, with or without changes, include `LICENSE` and `NOTICE`, mark the files you changed, and keep `THIRD_PARTY_NOTICES.md` with them, as the licences of the bundled libraries and fonts require.

## 2. Engineering results are estimates

Soloptima models plants from your inputs and from public data. Its results (energy yield, fuel, battery life, costs, cash flows, cable and transformer sizes, single-line diagrams) are estimates for feasibility and design studies. They are not guarantees of performance, not a certified design, and not financial or investment advice.

You are responsible for the inputs you enter and for how you use the results. Have designs, safety-relevant equipment sizing and financial decisions checked by qualified engineers and advisers, with site measurements and manufacturer data, before you build, procure, finance or sign anything.

## 3. Data and map services from other providers

Soloptima uses these services from other providers. It contacts none of them before you sign in and accept these terms.
- Whenever a project's map shows the site: map tiles from Esri, OpenStreetMap or OpenTopoMap (or Google's Map Tiles API with your own key, if you choose Google imagery), and the site's address from OpenStreetMap Nominatim, looked up automatically when the site is set or moved.
- When you open the Google Maps view or search for a place: the embedded Google Maps view, and Nominatim place search.
- When you fetch weather data: PVGIS (European Commission JRC) or NASA POWER, for one year or for the multi-year P50/P90 run.
- After every PV yield calculation: a cross-check against PVGIS PVcalc.
- When you click *Horizon from PVGIS*: the terrain horizon of the site from PVGIS.
- When you click *OSM buildings*, or Ctrl+click a roof that is not a building you drew: the building outlines of the map view, or of the square of about 220 m that holds the click, from the OpenStreetMap Overpass API (© OpenStreetMap contributors, ODbL).
- When the Report page shows its preview (as soon as the page opens) or you download or print the report, if a PV area is drawn and the satellite option is on (the default): an Esri World Imagery image of a rectangle around the drawn areas and the site.
- When you plan a day ahead: a weather forecast from Open-Meteo or MET Norway.
- After you sign in, at most once a day unless you turn it off in Settings, and when you choose Check now: the list of Soloptima releases from GitHub. When you confirm an update: its installer, checksum list and the list's signature from GitHub.

Each provider has its own terms and usage limits, and you must follow them. The free Open-Meteo service is for noncommercial use only; commercial use of its forecasts needs an Open-Meteo API key. MET Norway data is licensed under CC BY 4.0.

## 4. Your data stays on this computer

Soloptima has no account system and sends no usage data. Profiles, projects, terms acceptances and bug reports are stored as files in the data folder shown in the profile menu.

The requests in section 3 carry the site coordinates (for the report image, the corners of a rectangle around the drawn areas and the site, with a margin of at least 40 m), except the update check and the update download, which carry only the Soloptima version. The PVGIS cross-check also sends the PV tilt, azimuth and mounting, place search sends the text you type, and the forecast request sends your Open-Meteo API key if you entered one. Bug reports leave this computer only if you download, copy or open them as an issue yourself.

## 5. No warranty and no liability

As the licence states in its sections 7 and 8, the software comes as is, without warranties or conditions of any kind, and no contributor is liable to you for damages arising from its use or from being unable to use it, unless applicable law requires otherwise or the contributor agreed to it in writing. Some jurisdictions do not allow these limits; there, they apply as far as the law allows.

## 6. Changes to these terms

New versions of Soloptima may come with new terms. Soloptima shows the new version and asks you to accept it before you continue. If you do not accept the new terms, do not use that version.
