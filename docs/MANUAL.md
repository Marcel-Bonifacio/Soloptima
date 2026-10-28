# Soloptima manual

This is the detailed reference: what each page of the app does, the models behind the results, and the known limits. To install or build Soloptima, see the [README](../README.md).

## Profiles and the landing page

The app opens on a sign-in page. Choose a local profile or create one; a new profile must accept the terms of use and the licence, and every profile is asked again when `TERMS.md` gets a new version. Profiles have no password: projects are plain files in the data folder, so a password would protect nothing. After signing in, the landing page lets you:
- browse saved projects, with search, sort and result badges;
- start a new project from a template, open the example study, or import a `.json`;
- switch, add or remove profiles and sign out from the profile menu (top right);
- open **Settings** from the same menu to change your name, picture, organisation and email, move the projects folder, or clear the cache.

## Where projects are saved

Projects are saved automatically:

| System | Where projects are stored |
|---|---|
| macOS | `~/Library/Application Support/Soloptima/` |
| Windows | `%LOCALAPPDATA%\Soloptima\` |
| Linux | `$XDG_DATA_HOME/Soloptima/` (default `~/.local/share/Soloptima/`) |

A `data/users/` folder next to the program or in the working directory takes precedence, which gives a portable install (e.g. on a USB stick). A folder chosen in *Settings* takes precedence over both; the choice is kept in `Soloptima-settings.json` beside the default folder (so deleting that folder later does not lose it). `--data /path/to/folder` overrides all of these for one run. A folder saved under the old name (`SolarHybrid`) is renamed to `Soloptima` on first start. The user menu (top right) shows the folder in use.

*Settings* can move the data (profiles, projects and bug reports) to another folder: everything is copied, the copy is checked, and the previous folder is left unchanged as a backup. It can also open a folder that already holds Soloptima data, such as a backup or a folder synced from another computer. *Clear cache* drops what the engine keeps in memory (downloaded weather years and PV yield checks, finished optimisation and variability runs), the satellite images of the report, and temporary files left by an interrupted save; profiles, projects and reports are not touched.

## Bug reports and feedback

**Report** in the top bar opens a form for a bug, feedback or a feature request (title, what happened, steps to reproduce, expected result, severity). It can attach the errors of the session and the open project's inputs. Errors are also captured automatically: script exceptions, an engine that does not answer, and engine responses that are not its own worded messages (raw C++ exception text, parse errors, unexpected HTTP statuses). Messages that explain a wrong input are only kept in the session's error list. The same error at the same place is counted on one report instead of filed again, and a recurrence of an error marked fixed or closed reopens it.

Every report keeps a dated history: who reported it, status and severity changes, notes, recurrences, and when it was opened as an issue. *Bug reports and feedback* in the profile menu (or the footer) lists them and edits status, severity and notes. They are files in the `reports` folder of the data folder:
- `SOL-nnnn.json`: the report and its history (and the attached project, if any);
- `SOL-nnnn.md`: the same as a readable document, rewritten on every change;
- `README.md`: an index of all reports.

Nothing is sent anywhere. *Download .md* saves one report; *Copy for an issue* copies it without the reporter, the project and the notes; with a GitHub repository entered under the list, *Open GitHub issue* opens a prefilled issue in the browser for you to check and submit. If the engine has stopped, captured errors wait in browser storage and are filed on the next start.

## Privacy and the local server

The server binds to `127.0.0.1` only. The site location leaves the computer only for weather data and forecasts (PVGIS, NASA POWER, Open-Meteo, MET Norway), the PVGIS yield reference, map tiles, the report's satellite image (Esri World Imagery), the Google Maps view and place search / address lookup (OpenStreetMap Nominatim); the time zone is looked up offline. Two checks stop other websites open in the same browser from reaching the local API:
- requests must carry a localhost `Host` header, which blocks DNS rebinding;
- every API call other than GET must carry an `X-Soloptima` header, which blocks cross-site form posts.

## Help in the app

Every input with an **ⓘ** button has a short explanation and a typical value; the texts are in `web/js/help.js`.

---

## Workflow (left sidebar)

| Step | What you do | What the tool does |
|---|---|---|
| **1 Site & layout** | Type coordinates (decimal, DMS, or paste a Google Maps link) or search (places of the same name far apart give a pick list); draw the PV land and exclusion zones | Flies to the site, shows the address and the time zone, whose standard offset becomes the UTC offset; satellite / hybrid / streets / topographic maps or Google Maps (embedded view, or Google tiles with an API key); fills the land with module tables live as you edit → maximum kWp |
| **2 Solar resource** | Pick a database and press *Fetch*, or upload a CSV (import dialog with a preview); optionally run the historical weather years | PVGIS TMY or a specific year (EU JRC, global except polar), NASA POWER hourly (global), or a station file averaged to hours with a gap report; data checks (timestamps against the sun, physical limits, stuck or copied values); inter-annual variability: year 1 of the plant with every historical year → P50, P75, P90 and P99 of yield, fuel saved, renewable fraction, revenue and fuel used, and the P90/P50 revenue factor for debt sizing |
| **3 Load** | Choose a daily shape, scale and variability, or upload measured data (a logger CSV with timestamps at any interval up to an hour, or one year of values) | Synthetic 8760 h profile (day-to-day and hour-to-hour noise, monthly factors, weekends, growth); measured files averaged to hours with a gap report and checked for outages, stuck values, spikes, level shifts and unit errors |
| **4 PV & wind** | Module, mounting (fixed / single-axis tracker), losses, DC/AC; optional wind turbines | Hourly loss chain and loss diagram (recalculated automatically); monthly balances with normalised production and PR per month; cross-check against PVGIS; tilt scan; wind resource at hub height |
| **5 Battery** | Size, RTE, SOC window, reserve duration, ageing (cycle life at its rated DoD, replacement threshold, initial SOH, warranty cycle cap), auxiliary loads (battery HVAC and BMS, PCS no-load, plant auxiliaries, transformer no-load) | Calendar + cycle fade, replacement at the threshold; battery reserve limited by its stored energy; auxiliaries served every hour like the load |
| **6 Diesel & control** | Units × rating, minimum load, spinning reserve, fuel curve, strategy; optionally the existing plant's records (load, peak, generation, fuel, run hours, monthly fuel) | Load following, cycle charging, or predictive EMS; the records check the modelled diesel-only case |
| **7 Costs** | Capex, O&M, fuel price and escalation, discount rate, emission and job factors | NPC, LCOE, TAC/COE, IRR, payback vs diesel-only |
| **8 Equipment datasheets** | Library of PV modules, inverters, batteries, gensets, transformers, cables (import/export JSON/CSV) | Checks module data (Voc per cell, fill factor, temperature coefficients); applies module (incl. NOCT and low-light efficiency), inverter, battery (incl. PCS no-load loss) and genset data (incl. fuel curve) to the model |
| **9 Electrical & SLD** | MV voltage, transformers, cable lengths and types | String sizing, transformer loading, cable ampacity/voltage drop/losses, auto-sizing, 8760-h AC load flow, single-line diagram (SVG/PNG) |
| **Simulation results** | Run, or drag the live what-if sliders | 8760 h × every project year; KPIs with change vs last run and the inputs changed since it, the diesel-only baseline against the site's records, reliability/self-sufficiency/environment/social indicators, energy flow diagram and monthly energy balance, operational adequacy (loss-of-load events, reserve shortfall, gensets needed, low-load running), units online duration curve, dispatch explorer with a jump to notable weeks, battery health, cash flow; the battery's own NPV against PV only, and operating options (diesel only, PV only, every strategy) with an NPC waterfall; a tornado of the inputs that move NPV of savings, LCOE, IRR, equity IRR or fuel saved |
| **Optimise sizing** | Algorithm (grid, PSO, SHO–QAO–GOA, MOPSO), ranges, constraints, sensitivity | PV kWp, BESS kWh/kW, C-rate and wind turbines; search map, convergence, Pareto front, ranked table |
| **Forecast & EMS** | Run the Forecast Lab | Skill of 10 PV and 11 load forecasting methods (including the perfect and noisy benchmarks) vs horizon, fuel value of each method in the EMS, plan vs actual SOC, live day-ahead dispatch schedule |
| **Project finance** | Ownership structure (host-owned, single-owner PPA, third-party), presets, tariff components, debt, tax | Annual after-tax cash flow: equity and project IRR/NPV, LPPA/LCOE (nominal and real), DSCR/LLCR, payback, host savings, tariff solved for a target IRR; see `docs/FINANCE.md` |
| **Script console** | JavaScript with numeric helpers | Vectors/statistics/fitting/matrices, plots and tables, parallel parametric sweeps and Monte Carlo through the engine, CSV/XLSX export |
| **Report & export** | Download / print | Full engineering report (HTML → PDF) and an Excel workbook with all inputs, results and 8760-h series; the site section starts with the site and PV layout (coordinates, a drawing of the PV areas, exclusion zones and PV tables with a scale bar and north arrow, optionally over an Esri satellite image, and the PV area corners, all of them in a *Layout* sheet); figures you add on the Report page (photos, drawings, PNG/JPEG/WebP, saved in the project) appear with their captions in the section you choose; the PV section has the monthly balances, array characteristics, loss parameters and models used, and the workbook has *PV monthly* and *Energy monthly* sheets; the resource section has the P50/P90 table, and the workbook a *Resource years* sheet; the check of the diesel-only baseline against the site's records is under Energy simulation and in a *Baseline check* sheet; the data quality of the weather and of a measured load is under the resource and the load, with a *Data quality* sheet of the flagged hours |

Results stay tied to the inputs they came from. When an input changes after a simulation, Simulation results and Project finance show a warning that lists the inputs that changed, with a *Run again* button. The report and the workbook take the PV, battery and wind sizes from the simulation, not from the input pages. *Download report*, *Print / Save as PDF* and *Export Excel workbook* first simulate again when the result is from other inputs and the dispatch is rule-based (about a second). A predictive EMS run is not repeated: the report's executive summary and the workbook's *Summary* sheet then list the inputs that changed. The landing page shows result badges only for a project saved with current results.

Projects autosave to the data folder described above. **Export .json** (top bar, or *Export* on a project card of the landing page) and **Import .json** (landing page) exchange project files. These include weather and load data, so they also run offline and headless. They leave out the Google Maps and Open-Meteo API keys.

---

## Models

### Solar resource and PV yield (`src/pv.cpp`, `src/weather.cpp`)
- Weather in UTC is shifted to local standard time by the UTC offset in Site. Irradiance timestamps use the source's own offset (PVGIS reports it; NASA POWER is hour-averaged).
  - Choosing a site sets the offset to the standard offset of its time zone, looked up offline from the coordinates (tz-lookup). The lookup is approximate within a few kilometres of a zone border, so the site info names the zone. A typed offset is kept while the site stays in the same zone. A project saved before the lookup keeps its offset, with a warning when it differs from the zone's.
  - Zones with daylight saving use their lower offset. Clock-time logger data is converted on import with the time basis *Local clock time with daylight saving*.
  - Half-hour and quarter-hour offsets (India +5:30, Nepal +5:45) are applied exactly. With offset n + f, local hour L = f × UTC hour (L − n − 1) + (1 − f) × UTC hour (L − n), the mean over the local hour, for irradiance, PV output, cell temperature, wind and the auxiliary load. The day-ahead schedule averages the local-time load over each forecast hour in UTC. Earlier builds rounded the offset to whole hours, which put PV 30 minutes off the load at such sites.
- NASA POWER marks missing hours with -999. Gaps of up to 3 h are interpolated linearly; longer gaps take the same hour of the previous day. A year with a gap over 72 h is refused: NASA POWER publishes its hourly irradiance about three months late, so the current year and, until May, the previous one are incomplete. The weather keeps the hours filled and the longest gap, with the service called and the download time.
- Sun position: Spencer/NOAA equations. Beam/diffuse split kept consistent with GHI; Erbs decomposition when only GHI is available.
- Transposition: Hay-Davies (beam, circumsolar + isotropic sky, ground albedo).
- Row shading: 2-D infinite-row beam shading from GCR and profile angle; trackers with backtracking (no shading) or true tracking (shading).
- Optical: ASHRAE IAM (b0); soiling.
- Thermal: heat-loss factor model `Tc = Ta + α·G·(1−η)/(Uc + Uv·v)`, or NOCT `Tc = Ta + (NOCT − 20)/800·G`.
- Electrical: low-irradiance loss, temperature coefficient, mismatch / wiring / LID / quality, inverter efficiency, clipping at DC/AC ratio, AC/transformer losses, availability, annual degradation.
- DC wiring loss: a constant fraction of every hour (annual basis), or the loss at STC power as yield reports usually state it, scaled each hour with the string current and inversely with the string voltage, both relative to STC (I²R loss). A 1.5 % loss at STC then costs 0.8 % of the annual energy on the example site; sunnier sites lose more.
- Monthly balances: GlobHor, DiffHor, T_amb, GlobInc (module plane before shading), GlobEff (after shading, IAM and soiling), EArray (DC), E_avail and PR for every month and the year. The normalised production per kWp and day splits the reference yield into the final yield Yf, the system losses Ls and the array capture losses Lc; after a simulation it adds the unused (curtailed) PV energy Lu and the PR of the PV energy delivered.
- PVGIS cross-check: after every yield calculation the yield is compared with PVGIS PVcalc for 1 kWp of free-standing crystalline silicon (trackers: PVGIS's single inclined axis at 0°, so north-south axes only). The comparable Soloptima yield leaves out row shading and inverter clipping, which PVGIS does not model (trackers also track without backtracking or a rotation limit), and the losses PVGIS does not model itself (soiling, mismatch, wiring, LID, quality, inverter, AC, availability) become its system loss. A gap of more than 8 % is flagged. PVGIS uses its own thermal and spectral models and the multi-year average of its radiation database, so a few percent is normal; with weather from another source or a single PVGIS year the comparison is not like for like. On the example site PVGIS gives 1,323 kWh/kWp and Soloptima 1,356 kWh/kWp (+2.5 %). PVGIS is asked again only when the site or orientation changes; offline the check is skipped.

### Measured load and weather files, data checks (`src/series.cpp`, `web/js/tsimport.js`)
*Upload CSV* on Solar resource and Load opens an import dialog. It shows the first 20 lines and guesses the time column, the value columns and the units from the header; you confirm or change them, with the date order, the year, the time basis and the moment of the interval the stamps mark. The engine then reads the whole file and reports what it found before the data replace the project's:
- Delimiter: semicolon, tab or comma, whichever splits most of the first 20 lines evenly, so title or metadata lines above the data (as in PVGIS downloads) do not decide it.
- Timestamps: ISO 8601 (a stamp with Z or +hh:mm uses its own offset), dates with -, / or . in any order (detected from a day above 12; a file in which no day is above 12 must be told), PVGIS stamps and Excel serial days, with the time of day in the same or its own column. Stamps are converted to UTC with calendar arithmetic, without operating-system time-zone calls. Local clock time with daylight saving uses the clock changes of the site's time zone, found to the minute by the browser; the hour repeated in autumn takes the standard offset on its second occurrence.
- Rows are sorted, and duplicate stamps averaged and counted. The interval is the most common step; another step on more than 5 % of the rows is reported with its dates.
- Units: mean power (kW, W, MW) or energy per interval (kWh, MWh) divided by the interval; irradiance in W/m², or Wh/m², kWh/m² or MJ/m² per interval; temperature in °C or K; wind in m/s or km/h.
- Each sample covers its interval as labelled (start, end, or centred on an instantaneous sample), and each hour is the time-weighted mean of the samples that overlap it: in local standard time for load, on the file's own basis for weather. An hour less than half covered is missing. Hourly instantaneous samples thus become the mean of the stamps at the start and the end of the hour.
- The year with most data is taken (or a chosen year, or for load the last 12 months, each day at its calendar date), without 29 February.
- Gaps: weather as for NASA POWER (up to 3 h interpolated, longer gaps from the previous day, over 72 h refused); load up to 3 h interpolated, longer gaps from the same hour a week earlier (a week later at the start), over 72 h refused unless *Fill long gaps from adjacent weeks* is chosen. Zeros are data, never gaps.
- The report gives the rows read and not read, duplicates, rows out of order, the interval, the period, the coverage, the missing and filled hours and the longest gap. One hour missing in spring and one doubled in autumn in a file read as standard time point to clock time with daylight saving. Unit hints compare the load peak with the genset fleet and the annual GHI with 700–2,700 kWh/m².
- Without a time column every row is one interval in file order from 1 January, as before, from the columns chosen in the dialog (the load upload used to take the last number of each row). The file must hold one year of hourly, half-hourly or quarter-hourly rows; a row without a number is an error naming its line, and a missing weather cell is a gap instead of 0 W/m², 25 °C or 1 m/s. Headless project JSON takes the same lengths (8760, 17520 or 35040 values; 8784, 17568 or 35136 in a leap year).

After every weather download or upload and every load upload, the *Data checks* under the annual summary and the load statistics list flags by hour. They are kept with the project and change nothing:
- Weather, on the file's own time base with the sun at the start, middle and end of each hour: GHI above 5 W/m² with the sun more than 2° below the horizon; zero GHI with the sun above 15°; GHI above 1.5 E0 μ^1.2 + 100 W/m² or DHI above 0.95 E0 μ^1.2 + 50 W/m² (μ: cosine of the zenith angle, E0: extraterrestrial irradiance; the physically possible limits of the BSRN tests, Long and Shi 2008, which on hourly means catch only gross errors); DHI above 1.05 GHI + 10 W/m²; a non-zero value stuck for 4 daylight hours (GHI) or 6 hours (temperature, wind); the same value at the same hour on 3 days or more (daylight GHI, temperature); temperature outside -40 to 60 °C or a step above 10 °C in an hour; wind below 0 or above 40 m/s; a missing temperature or wind column; annual GHI outside 700–2,700 kWh/m².
- Timing: over 24 h centred on each day's solar noon on the file's time base, the centroid of the irradiance of each clear day is compared with that of the Haurwitz clear-sky model averaged over the hour as the PV model times it. Clear days have a daily clearness of at least 0.9 × the 90th percentile of their month and a variability of at most 1.5 times the clear sky's. The median offset gives the verdict: within 10 min the stamps match the sun; 20–40 min means instantaneous samples read as hour means, or the reverse; whole hours (within 10 min per hour) mean interval-end stamps read as interval-start, or a clock error; about the UTC offset means a wrong UTC flag; monthly medians 40–80 min apart point to a clock change during the year; with fewer than 10 clear days there is no verdict. *Shift 1 h earlier* (or later), *Treat as instantaneous samples* and *Timestamps are UTC / local time* change the weather only when clicked. On the example study, the 133 clear days of the PVGIS TMY peak 10 min before the clear-sky model.
- Load: near-zero runs (below 2 % of the 95th percentile for 2 h or more); a value stuck for 6 h or more while the rest of its day varies by more than 1 % of its mean, so flat process loads pass; linear infill (4 or more equal non-zero steps, which also marks a 3 h gap filled by the import); spikes above the median + 6 × 1.4826 MAD of the same hour of the week in the 8 weeks around it, so a level shift or a season is not a spike; level shifts of the daily mean by binary segmentation of its logarithm (at most 5, each a step of 10 % or more between segments of at least 30 days, with a BIC penalty); a peak above the genset fleet or below a fifth of one unit, with the unit error that would explain it (W, MW, kWh per 15 or 30 min). There is no clock check on load: a flat 24-hour load gives no timing signal.
- The score is the share of days without a flag. Flagged days are outlined in the heatmaps. The report has a *Data quality* paragraph and table under the resource and the load, and the workbook a *Data quality* sheet with the flagged hours (the first 200 of each data set).

### Inter-annual variability and P50/P90 (`src/resource.cpp`)
Lenders size debt on a P90 case, but in a diesel hybrid the fuel saved and the revenue do not scale with the PV yield: genset minimum loading, a full battery and take-or-pay floors damp them. The *Inter-annual variability and P50/P90* card on the Solar resource page therefore runs year 1 of the plant once with every historical weather year (PVGIS hourly series 2005–2023, or NASA POWER 2001 to the last complete year), with the sizes and settings unchanged, and gives each result its own spread:
- The spread is used only as ratios: r = value ÷ multi-year mean, and σ_iav is the sample standard deviation of r. P50 is the result with the project's own weather.
- The project weather need not be an average year. The card, the report and the *Resource years* sheet state how far its specific yield is from the multi-year mean of the weather years (P50 ÷ mean − 1), and warn above 2 %: a single NASA POWER or PVGIS year, or a CSV of one year, then makes P50 and the whole base case better or poorer than an average year, so use a TMY or a long-term average for the base case. With a TMY as the project weather, such a gap comes from a different database or period, or from the typical year's choice of months; with a single year from another database, it mixes the year and the difference between the databases. The gap does not change the P90 ÷ P50 factor, which is a ratio. The chart draws each weather year as a percentage of the multi-year mean (100 %), with P50 and the one-year P90 on the same basis.
- The systematic uncertainty σ_sys is the root-sum-square of the irradiance dataset (default 5 %), transposition and PV model (2 %), and soiling and availability (1.5 %). Each result's elasticity e = (M₊ − M₋) / (2 σ_sys M₀) comes from two more runs with the project's GHI, DNI and DHI × (1 ± σ_sys), so clipping, cell temperature, curtailment and genset minimum loading count. With wind turbines, each weather year also brings its own wind speeds, but the systematic uncertainty and the elasticity cover irradiance only, so the P90 leaves out the uncertainty of the long-term wind resource.
- σ_N = √(σ_iav² / N + (e σ_sys)²) for one year (N = 1) and a 10-year average (N = 10, independent years), and P_x = P50 × (1 − z_x σ_N) with z = 0.6745 (P75), 1.2816 (P90) and 2.3263 (P99). For fuel used, where higher is worse, P_x = P50 × (1 + z_x σ_N). The worst year of each result is reported too.
- Results: specific yield, fuel saved, renewable fraction, avoided diesel cost, year-1 revenue of Project finance (the avoided cost for a host-owned plant; tariff × billed energy, with take-or-pay and deemed energy, under a PPA) and fuel used. Every weather year keeps the contract of the P50 case: a tariff solved for a target IRR is solved once, for P50, and the contracted energy behind take-or-pay and shortfall penalties stays at its P50 value. Under a PPA or third-party ownership the revenue P-values are the P-values of the renewable energy delivered, mapped through the contract (take-or-pay floor, shortfall penalty), so they respect the take-or-pay floor as every weather year does. Deemed energy stays at its P50 value although curtailment drops in poor years, so with deemed energy they are slightly optimistic.
- *Use for debt sizing* sets the revenue haircut of Project finance to P90 ÷ P50 of the revenue, of one year (the default, as the factor applies to every year) or of a 10-year average. The Debt card shows where the value came from until it is typed over.

On the example site (PVGIS-ERA5 2005–2023) the yield varies by 4.1 % from year to year and the fuel saved changes by 0.94 % per 1 % of irradiance, so revenue P90 ÷ P50 is 0.915 for one year and 0.931 for a 10-year average. With PV of three times the average load (the test project), curtailment cuts the fuel-saved elasticity to 0.44. The weather years are downloaded in blocks (PVGIS: four years per request, three requests at a time, about a minute in all; NASA POWER: one request per year, three at a time), kept in memory for the session by site and range, and never saved in the project; only the summary is. PVGIS serves ERA5 reanalysis over most of Indonesia, so cross-check it against NASA POWER.

### Dispatch (`src/sim.cpp`)
Every hour of every project year (year 1 only, repeated, when *Simulate every project year* is off or the optimiser runs in fast mode):

1. **Unit commitment:** gensets online = ⌈(residual deficit + planned charging + spinning reserve − battery reserve) / unit rating⌉, at least *units always online* and at most the fleet. Battery reserve is the spare discharge power, limited to what the energy above the minimum SOC sustains for the *reserve duration* (default 1 h; 0.25–0.5 h covers a genset start).
2. **Allocation:** genset minimum loading (must run) → PV → battery → gensets above minimum → battery emergency reserve → unmet.
3. **Charging:** PV surplus → battery; unavoidable genset excess at minimum load → battery, else dumped; deliberate genset charging (cycle charging or EMS plan).
4. **Fuel:** part-load curve per online unit (datasheet table interpolated as L/h, or a linear curve: intercept + slope).
5. Load and PV balances close every hour to within 0.05 kW (checked by `make test`).

The *Energy flow* card draws year 1 as a Sankey diagram: PV, wind and the gensets (and the unmet energy) into the battery and the load, and out to curtailment, genset dump at minimum loading, battery losses, self-discharge and the auxiliaries. Battery losses = energy charged − discharged − self-discharge − change in stored energy over the year, so the battery's own balance closes; the change in stored energy is drawn when it exceeds 0.1 % of the throughput. The direct RE share is the part of the PV and wind used that goes straight to the load. The *Monthly energy supply* card adds the monthly balance: load, PV and wind direct, battery and diesel to the load, unmet, curtailment, genset dump, fuel and renewable fraction.

Strategies:
- **Load following**: gensets serve only the load.
- **Cycle charging**: the battery covers the deficit as in load following until it is empty (or until gensets at minimum loading plus PV cover the load). The running gensets then charge it from their spare capacity to the SOC setpoint (capped at the maximum SOC), and until it gets there it discharges only to cover load the gensets cannot. No unit is started only to charge, and cycle charging does not look ahead to PV; while the battery holds, a rising load starts gensets that a discharge could have avoided. The hour in which a charge starts or ends is shared: a battery that runs empty part way through an hour is charged for the rest of it, and one that reaches the setpoint part way through discharges for the rest of it, so results do not move by whole hours when the battery size, its state of health or the setpoint change slightly. Units are still committed per hour, so genset starts change in steps. Earlier builds had no hold: the battery was topped up in one hour and emptied in the next, which gave far more cycles and starts and results that jumped between two patterns with small changes in battery capacity.
- **Predictive EMS**: see below.

### Operational adequacy (`src/sim.cpp`)
Unmet energy alone says little about how often supply fails, so every year also records:
- loss-of-load hours (more than 0.1 % of the hour's load unserved), events (runs of such hours) and the longest event;
- reserve shortfall: hours in which the genset headroom (genset charging counts as headroom) and the battery reserve left after dispatch do not cover the spinning-reserve rule, and the largest shortfall in kW. The PV and wind part counts only the power the load would lose if PV and wind fell by the reserve share, since curtailed and charging power absorbs the drop first;
- most gensets online, hours with the whole fleet online, hours with every online genset at minimum loading and the longest such run (wet stacking), and most gensets started in one hour.

With enough units for the peak load and its reserve, the shortfall is normally zero for both the hybrid and diesel only. It shows a fleet that is too small: one unit fewer for maintenance, a few large units, load growth. The Simulation results page compares these with diesel only, draws the units online duration curve, and lists notable weeks to open in the dispatch chart (highest unmet load, most gensets online, lowest renewable share, highest curtailment, lowest SOC, longest low-load run, best PV week). The report adds the dispatch of the lowest-renewable week. Firm capacity is set by the peak load and the reserve rule, so the duration curve shows daytime unit-hours freed for maintenance, not units that can be retired.

### Auxiliary loads (`src/sim.cpp`)
The plant's own consumption is added to the load and dispatched with it every hour, also at night when it costs diesel:
- battery HVAC, BMS and fire system, in kW per MWh of nameplate energy, rising by a coefficient per °C of hourly ambient temperature above a reference (with a battery);
- the no-load loss of the battery inverters (PCS) while energised, in kW per MW of PCS rating (with a battery); it follows each candidate's battery power in the optimiser, so a higher C-rate pays for its larger PCS;
- plant auxiliaries (SCADA, lighting, tracker motors), with PV, wind or a battery;
- the no-load loss of the PV step-up transformers (with PV) and of the BESS step-up transformers (with a battery), so the PV-only reference and designs without a battery do not pay for the battery's transformers.

They do not grow with the load, and the diesel-only baseline has none. LCOE, COE and the renewable energy billed in Project finance count only the energy served to the site; unmet energy is attributed to the site load first. The predictive EMS and the day-ahead schedule plan with the auxiliary load as known (the schedule at the forecast temperature). Enter the battery standby draw here rather than in the round-trip efficiency, which charges it only when energy passes through the battery. The PCS no-load loss counts in every hour, so in hours with battery flow it overlaps slightly with the round-trip efficiency; for a PCS that sleeps while the gensets carry the load, enter its standby draw.

### Battery ageing (`src/sim.cpp`)
State of health (SOH) falls every year by:
- calendar fade, a fixed loss per year;
- cycle fade = DC equivalent full cycles × (1 − end-of-life SOH) / (cycle life × rated depth of discharge). DC cycles are the energy taken from the cells (AC discharge ÷ one-way efficiency) divided by nameplate energy. A battery rated 8,000 cycles at 95 % DoD therefore reaches end of life after 7,600 full-nameplate cycles.

The battery is replaced when its SOH falls to the replacement threshold (blank = the end-of-life SOH), except in the last project year, and the new one starts at 100 %. The end-of-life SOH only sets the fade per cycle, so the threshold can differ from it. Fade is linear; real cells fade faster below their datasheet end of life (capacity knee), so a lower threshold is optimistic. An existing or second-life battery starts at its initial SOH (set its capex to zero). The salvage value at the end of the project is the cost of the battery in service times its SOH left above the threshold, as a share of the SOH it had above the threshold when installed.

The *Battery health* card on the Simulation results page shows the SOH curve with the threshold and the replacement years, and the calendar and cycle fade of each year. It also shows the highest cycles per year (AC discharge ÷ nameplate energy, with the DC value alongside) against the warranty cap, the highest C-rate used, and the expected life of a new battery at year-1 use, with the term that limits it.

Earlier versions counted cycles on the AC side. Counting them at the cells raises the cycle fade by 1/√RTE (6.6 % at 88 % RTE), so replacements can come earlier than before.

### Forecast-based EMS (`src/forecast.cpp`, `src/ems.cpp`)
The EMS is model-predictive control with dynamic programming:

1. **Forecast** (at every re-plan, by default every hour, using only data observed so far). PV and load forecasts are made for the next *H* hours (default 24). Wind is forecast too when turbines are present.
2. **Plan** with a backward dynamic programme over the battery's stored energy, discretised into n levels (SOC resolution setting, default 21, at most 101). n is raised when one level step would exceed half the energy the battery can charge in an hour at rated power.
   - The cost of each hour *h* and level change is fuel(units, loading) × price + genset O&M (per run-hour and per kWh) + battery wear (replacement cost / (cycle life × its rated DoD) per kWh discharged) + value of lost load × unserved energy.
   - Units committed = ⌈(net load − battery + spinning reserve − battery reserve) / unit rating⌉, at least the minimum online, with genset minimum loading enforced.
   - The DP credits the battery's spare power as reserve whatever its stored energy. Once the path is chosen, its units are recomputed with the battery reserve limited as in real time: the energy above the minimum SOC at the start of the hour ÷ the reserve duration, less the hour's discharge. The plan therefore no longer leaves out units that real time must start, at any reserve duration. Predictive results moved slightly with this change: year-1 fuel up to 0.004 % higher on the example study.
   - The hour cost depends only on the level *change*, so it is tabulated once per hour. A plan costs at most H × (2n − 1) cost evaluations plus H × n² additions (24 × 41 and 24 × 441 with the defaults), and fewer when the battery power limits the level change in one hour.
   - Energy left at the end of the horizon is valued at the fuel it would displace (terminal value), so the plan does not empty the battery just because the horizon ends.
3. **Act until the next re-plan** (by default the first hour only): steer toward the planned state of charge, then re-plan (receding horizon).
4. **Compensate in real time.** The battery absorbs a forecast error only when the error would otherwise force an *unplanned genset start*. It first drops planned genset charging, then discharges just enough (found by bisection). Diesel marginal fuel is almost flat, so moving energy through the battery to fix every small error would only add round-trip losses. Surplus PV/wind always charges the battery. Optional *firm commitment* keeps the units committed in the current plan online even when the actual net load is lower.

**Forecasting methods** (all causal; PV methods work on the clear-sky index, load methods on load relative to its mean):

| Method | PV | Load | Idea |
|---|---|---|---|
| Persistence | ✓ | ✓ | same hour yesterday (baseline for the skill score) |
| Seasonal naive (weekly) | | ✓ | same hour last week (weekday/weekend) |
| Smart persistence | ✓ | | clear-sky output × clear-sky index of the last 3 h blended into the last 24 h |
| 7-day profile + persistence | | ✓ | mean of the same hour over 7 days + decaying latest deviation |
| 30-day climatology | ✓ | ✓ | mean index of that hour over the last 30 days |
| Exponential smoothing | ✓ | ✓ | exponentially smoothed level per hour of day + decaying correction from the latest hour |
| Adaptive regression (RLS) | ✓ | ✓ | lead-specific linear model (11 lead buckets, 5 features + intercept) learnt online by recursive least squares |
| Analog ensemble (k-NN) | ✓ | ✓ | the 7 of the last 60 days whose last-24-h pattern best matches now; average of what followed |
| Adaptive ensemble | ✓ | ✓ | blend of five members (PV: smart persistence, climatology, smoothing, RLS, analog; load: profile, weekly, smoothing, RLS, analog), weights ∝ 1 / MSE over the last 14 days, separately intraday (lead < 6 h) and day-ahead |
| Neural network (MLP) | ✓ | ✓ | 10-16-16-1 ReLU network trained with Adam on lagged indices, lead time and calendar; retrained monthly on the preceding 330 days only (causal) |
| Perfect / perfect + noise | ✓ | ✓ | benchmarks: the forecasting ceiling, and robustness to a chosen error level |

The **Forecast Lab** benchmarks all of them over horizons of 1–48 h (nMAE, nRMSE, bias, skill vs persistence). It also re-runs the EMS with each method to show the fuel, genset-hour and NPC value of better forecasts.

**Operational day-ahead schedule.** This pulls a live weather forecast: Open-Meteo irradiance, or MET Norway cloud cover converted to irradiance via Kasten-Czeplak. It runs the same PV model and planner from the current SOC and outputs hourly genset commitment, battery set-points and fuel, exportable as CSV.
- The plan starts at the current hour of the computer's clock, and the SOC you enter applies at its start. Open-Meteo's forecast begins at 00:00 UTC, so its hours already past are dropped (one more day is fetched to make up for them); MET Norway's begins at the current hour. *Days ahead* × 24 hours are planned.
- Each row is the mean over its hour: Open-Meteo's irradiance is the mean of the hour before its timestamp, and MET Norway's cloud cover, temperature and wind are averaged from the forecast instants at the start and end of the hour. The load is averaged over the same hour. The table and chart label each row by the start of its hour in local time; in the CSV, `time_utc` and `time_local` are the provider's stamp and `start_local` the start of the hour.
- The hours are planned one after the other, also across 29 February. The forecast ends at the first hour without irradiance or temperature (Open-Meteo returns empty values past the end of its model's range), so missing data is never read as zero PV.
- With wind turbines, their output on the forecast 10 m wind (the project's shear, power curve, losses and availability) is added to PV, as in the lifecycle simulation, and the plan commits gensets for the net load.
- The status line gives the provider, when the forecast was fetched and, for MET Norway, how old its model run was at that time, with a warning above 12 h. The CSV starts with a comment line holding these, the plan start and the SOC entered.
- Open-Meteo's free API is for **noncommercial** use only; an Open-Meteo API key covers Open-Meteo's terms, not Soloptima's licence. MET Norway data is CC BY 4.0.

### Economics
Nominal discounted cash flow over the project life: capex (PV, BESS energy + PCS, wind, optional new gensets, development margin), fuel with escalation, O&M with escalation (PV per kWp, BESS per kWh, wind per kW, gensets per kWh and per unit run-hour), inverter and wind-turbine replacement, battery replacements at the replacement threshold with price decline, carbon price, linear salvage. LCOE = NPC / discounted energy served to the site (auxiliary consumption excluded). IRR / payback on the incremental cash flow vs the diesel-only baseline (same fleet, same reserve rules). The battery's own value uses the same incremental cash flow against PV only (below).

### Diesel-only baseline against site records (`web/js/app.js`)
Every result is measured against the modelled diesel-only case: fuel saved, NPV, IRR and the battery's own value. For an existing plant, *Existing diesel plant records* on the Diesel & control page takes what the site has recorded: site load, peak load, genset generation, fuel, run hours of all units and the fuel of each month, with the period, source and scope of the records. Blank fields and fields entered as zero are left out. The Simulation results page compares them with the diesel-only case of the last run (year 1, without auxiliary loads), as model ÷ site − 1:
- flagged beyond ±3 % for the site load and the generation, ±5 % for the peak, the fuel and the specific fuel consumption (L/kWh), and ±10 % for the run hours;
- the monthly fuel is drawn against the records, with its CV(RMSE) and the months more than 15 % off. Fuel records are often deliveries, so a change in tank stock moves fuel between months.

Fixed rules suggest where a gap comes from; nothing is applied to the model. A load that matches with a fuel that does not points to the fuel curve or the units online. More recorded run hours than the model mean the operators run more units than the reserve rule, and the hybrid's savings assume the modelled practice. A generation that matches with a specific consumption that does not points to the fuel curve, with the factor that would match. A load, peak or generation that differs points to the load profile (station service, losses, metering point). The card also gives the leverage: each 1 % of error in the baseline fuel alone moves the fuel saved by baseline fuel ÷ fuel saved %, 5.2 % on the example study. An error in the fuel curve moves the baseline and the hybrid together, and the fuel saved by about 1 % per 1 %. The report shows the check under Energy simulation, and the workbook has a *Baseline check* sheet.

### Battery value and operating options (`src/main.cpp`, `web/js/app.js`)
Every simulation also runs the same PV and wind without the battery (PV only); without a battery every strategy reduces to load following. The battery's own NPV and IRR come from the incremental cash flow of the hybrid against PV only, so its capex, O&M, replacements and salvage are weighed against the fuel and genset costs it avoids. A hybrid can beat diesel only by a wide margin while its battery loses money. The *Battery adds* tile shows this NPV (in red when negative), and the comparison table gains a PV-only column. PV only keeps the hybrid's PV capacity, so it usually curtails more than a design without a battery sized on its own. After an optimisation the *Best PV-only design* tile gives the cheapest ranked design without a battery.

*Compare options* on the Simulation results page runs one batch of the project with one setting changed per row: diesel only, PV only, the battery with load following, with cycle charging to 60, 80 and 100 % SOC (capped at the maximum SOC; rows that coincide after the cap run once), with the predictive EMS and the project's forecasters, and with the predictive EMS and perfect forecasts (a benchmark for better forecasting, not an option; the EMS plans over a rolling horizon, so it does not always give a lower NPC). The table gives fuel, renewable fraction, genset hours and starts, battery cycles and replacements, curtailment, unmet load, capex, NPC, LCOE, NPV and IRR against diesel only, equity IRR, and the NPC change from the row above. It highlights the lowest NPC that meets the optimiser constraints and marks differences below 0.5 % of NPC as within model accuracy. A waterfall splits the NPC from diesel only to the hybrid into PV, the battery with load following, and the best strategy; the split depends on that order. *Year 1 only (fast)* repeats year 1 over the project life, which saves most of the time of the two predictive runs.

### What drives the result (`web/js/app.js`)
The *What drives the result (tornado)* card simulates the current design once at a low and once at a high value of each listed input, one input at a time, in one batch with the base case. The sizes stay fixed; the sensitivity cases of the optimiser re-optimise them instead. Each input is a project path changed by a factor (× base), an amount added to the base (+ base, in percentage points for percentages) or a set value, and `load.kw` scales the load in every hour. The defaults are diesel price, fuel escalation, discount rate, PV and battery capex, battery replacement price and price decline, cycle life, calendar fade, PV degradation and availability, genset O&M per run hour and the load. The bars start at the base value of the chosen result (NPV of savings, LCOE, IRR, equity IRR or fuel saved in year 1) and are sorted by swing. *Battery prices move together* lets the battery energy capex also move the power capex and the replacement price. Cycle life and calendar fade move the replacement year in whole-year steps, so their bars can be lumpy and asymmetric. A path the engine does not read, such as a typo or the module power and size (which only the layout and the equipment library use), is not simulated: its row shows *not an input of the engine* instead of a zero bar. The report shows the chart and table under Economics, and the workbook has a *Tornado* sheet with every result of every case.

### Optimiser (`src/optimizer.cpp`)
Every candidate is a full chronological lifecycle simulation, run multi-threaded.

| Algorithm | Use |
|---|---|
| **Grid + pattern search** | Exhaustive PV × BESS × C-rate grid, then Hooke-Jeeves refinement. Gives the full search-space map. |
| **PSO** | Global-best particle swarm, inertia 0.9 → 0.4, c1 = c2 = 2 (El Boujdaini et al. 2022). |
| **Hybrid SHO–QAO–GOA** | Spotted-hyena search, quadratic-approximation refinement and grasshopper diversification (Suresh Babu et al. 2025), with the equation corrections listed in `docs/LITERATURE.md`. |
| **MOPSO** | Pareto front of cost vs renewable fraction or SSSI (Abdoulaye et al. 2024). The reported "best" is the knee point. |

All algorithms share these features:
- **Constraints**: maximum unmet load (in every simulated year, so load growth counts), maximum loss-of-load hours and reserve shortfall hours per year (worst year, optional), minimum renewable fraction, maximum curtailment, land limit from the layout, capex budget. Metaheuristics handle them with a static penalty.
- **Search variables**: the grid tests the listed C-rates at the project's wind-turbine count. The metaheuristics search the C-rate continuously between the smallest and largest listed value, and the turbine count as an integer within its range.
- **Sensitivity cases**: diesel price, fuel escalation, discount rate, PV/BESS capex, load multiplier, battery life multiplier (cycle life × value, calendar fade ÷ value), cycle life, calendar fade, replacement price, battery price multiplier (energy and power capex and replacement price), replacement SOH, PV degradation and genset O&M per run hour. The end-of-life SOH is not offered: it also sets the fade per cycle, so the cycle part always reaches it after the rated cycle life.

The metaheuristics also plot a convergence chart. All algorithms except MOPSO warn when the optimum sits on the search boundary.

### Electrical design (`web/js/electrical.js`, `web/js/sld.js`)
- **String sizing**:
  - Voc at the site minimum temperature against inverter and module voltage limits;
  - MPPT window from Vmp at the maximum cell temperature and at the site minimum. Vmp uses its own temperature coefficient: the datasheet value, or γPmax − αIsc when it is not given (slightly steeper than the true value, so conservative);
  - the maximum cell temperature is checked against the 99.9th percentile of the yield model's hourly cell temperature (hours above 200 W/m²), with a 5 °C margin for short peaks;
  - MPPT current check (1.25 × Isc).
- **Transformers**: chosen from datasheets. Loading, plus annual no-load and load losses integrated over the hourly flows.
- **Cables**:
  - current rating × derating × parallel runs, and voltage drop (DC: 2IRL/V; AC: √3 I (R cosφ + X sinφ) L / V) with R corrected to 70 °C;
  - I²R losses integrated over the hourly profiles, with distributed-load factors for MV collectors carrying several transformers;
  - auto-sizing picks the smallest cable and fewest runs that meet both limits.
- **AC load flow**: backward/forward sweep on the radial network for all 8,760 hours. It reports bus voltages, voltage deviation, network losses and limit violations.
- **Feedback to the model**: DC wiring loss (as a constant annual fraction), AC loss and BESS path efficiency (cables and transformer load loss), DC/AC ratio, built kWp, and the no-load loss of the PV and BESS step-up transformers as auxiliary loads, each counted only with its own asset.
- **Single-line diagram**: A3 drawing with IEC-style symbols, protection tags, cable labels, notes, legend and title block. Exports to SVG/PNG and is embedded in the report.

### Project finance (`src/finance.cpp`)
The financial model is an annual after-tax cash flow:
- **Ownership structures:** host-owned, single-owner PPA, and third-party lease/PPA with the host's savings view.
- **Costs:** construction period with IDC, soft costs and VAT.
- **Debt:** sized by gearing and/or DSCR sculpting, optionally on revenue cut to P90 (the factor can come from the inter-annual variability run); sculpted, annuity or equal-principal repayment; DSRA.
- **Tax:** depreciation by asset class (including Indonesian groups), loss carry-forward, tax holiday, creditable withholding and the Art. 31E reduced rate.
- **Revenue:** take-or-pay and deemed energy; multi-component staged tariffs (PLN A/B/E/F style); a tariff solver for a target IRR.

`docs/FINANCE.md` gives every formula, the presets, and lessons from two industry financial models: what was adopted, and the spreadsheet errors that were avoided.

### Literature basis
Four journal papers supplied with the project were reviewed in full. `docs/LITERATURE.md` lists exactly what was taken from each, the errors corrected and what was left out. In short: wind turbine and NOCT models, self-discharge, LPSP/SSCI/SSSI/REP/emission/job/HDI indicators, CRF-based annualised cost, PSO/MOPSO/SHO–QAO–GOA optimisers, voltage-deviation and network-loss indicators, Weibull/lognormal Monte Carlo sampling, and a causal neural-network (MLP) forecaster. Only the Frontiers paper has a forecasting component.

---

## Why C++ (and not Julia)
- Speed: the sizing search runs hundreds to thousands of 8760 h × 25-year simulations. With rule-based dispatch the engine runs about 150 full 25-year simulations per CPU-second on the example project. The predictive EMS, which re-plans every hour, runs about one.
- One small native binary with no runtime, package installs or JIT start-up delay. Users need only the binary and the `web/` folder.
- The GUI is a browser page served by the binary, so maps (Leaflet / Google tiles) and interactive charts (Plotly) work on any OS.
- Julia (JuMP) would suit LP/MILP formulations; the DP-based EMS and grid search here need no solver.

## Google Maps
The Google Maps view tab shows Google's satellite map of the site without an API key. It uses Google's standard embed, so you can look but not draw on it.

For drawing, the layout map uses Esri World Imagery by default (no key needed). The other options without a key are hybrid (satellite + roads and labels), OpenStreetMap streets and OpenTopoMap.

To draw directly on Google imagery:
1. Enable the **Map Tiles API** in Google Cloud.
2. Paste the key into *Layout parameters → Google Maps API key*.
3. Choose *Google satellite / hybrid / roadmap*.

The key is saved with the project in the data folder, as is the Open-Meteo API key (Forecast & EMS). **Export .json** leaves both out, so an exported project file can be shared; enter the keys again after importing it. "Open in Google Maps ↗" opens the site in a new browser tab.

## Files
```
src/        C++ engine: model, pv (solar + wind), sim (dispatch + economics + indicators), forecast (10 PV / 11 load methods),
            ems (DP planner, benchmark, day-ahead), optimizer (grid, PSO, MOPSO, SHO-QAO-GOA), finance, weather,
            resource (inter-annual variability, P50/P90), series (timestamped load and weather import, data checks),
            storage (profiles, projects and bug reports on disk), server, platform, main; fuel.hpp, json.hpp
web/        GUI: index.html, style.css, js/ (app, schema, charts, layout, forecastlab, equipment, electrical, sld,
            report, console, finance, home (sign-in, profiles, projects), reports (bug reports), tsimport (CSV import dialog, data
            checks), help, util), img/ (logo), vendor/ (Leaflet, Geoman, Plotly, tz-lookup, Geist fonts),
            examples/ (example project, PVGIS TMY embedded)
packaging/  build-mac.sh (.app + .dmg), build-windows.sh (.exe + .zip), make_icons.py
tests/      engine self-tests (make test)
LICENSE.md, TERMS.md, THIRD_PARTY_NOTICES.md   licence, terms of use and bundled-library licences (served to the app by /api/legal)
docs/       MANUAL.md (this file), FINANCE.md (finance formulas, lessons from two industry financial models), LITERATURE.md (review of the four papers),
            brand/ (logo and app icon as SVG and PNG: light, white, navy and tagline versions)
```

## Script console
Scripts are JavaScript with numeric helpers. Type `help()` in the console for the full list.
- **Workspace**: `P` (live inputs), `sim`, `hourly`, `opt`, `pvr`, `forecast`, `design`.
- **Numerics**: `linspace`, `colon`, `sum`/`mean`/`std`/`prctile`, `cumsum`, `diff`, `polyfit`/`polyval`, `interp1`, `trapz`, `mtimes`, `inv`, `mldivide`, `weibull`, `lognormal`.
- **Energy helpers**: `monthly`, `daily`, `duration`.
- **Engine calls**, executed in parallel by the C++ batch API:
  - `await simulate({...overrides})`
  - `await batch([...])`
  - `await sweep({'pv.capacity_kwp': [...], ...}, metricFn)`
  - `await montecarlo(n, sampler, metricFn)`
  - `await optimize({...})`
- **Output**: `disp`, `table`, `figure`, `plot`, `bar`, `scatter`, `hist`, `heatmap`; `exportCSV`, `exportXLSX`, `saveJSON`, `await readCSV()`.
- The engine ignores an override path it does not read, so the console prints a warning for a path that is not in the project (a typo) or that only the layout and the equipment library use.

Example scripts are included (load duration curve, PV × BESS sweep, Monte Carlo NPV, polyfit, monthly balance, Weibull wind). Scripts can be saved in the project.

## Limitations / next steps
- Single genset type per project (N identical units); mixed fleets would need merit-order commitment.
- The finance module is annual. Monthly or semi-annual debt periods, FX movements, and tax-equity partnership structures are not modelled.
- The load flow covers the radial plant network with balanced three-phase flow. Short-circuit and protection coordination are not computed.
- The hydrogen chain from the Chad paper (electrolyser, tank, fuel cell) is not modelled.
- Hourly time step: no sub-hourly ramps or frequency response; spinning reserve is the proxy. Forced outages and N-1 contingencies are not modelled.
- The predictive EMS applies the stored-energy limit on battery reserve only to the units of the chosen path. A DP whose hour costs depend on the stored energy would also let the SOC path keep reserve energy in the battery.
- Diffuse row shading and bifacial gain are not modelled. PVGIS weather is fetched with PVGIS's default `usehorizon=1`, so its beam irradiance already includes the terrain horizon; horizon shading is missing only for NASA POWER and CSV weather.
- The example's site coordinates (−2.5°, 115.5°) are a placeholder; set the real plant location before using the results.
