# The interface (Svelte)

The interface is moving from the vanilla scripts of `web/js/` to Svelte 5 in `ui/`, one group of screens per session (rewrite
rows 3.1 to 3.11). Both run in the same page until the last screen is ported.

## Build

- `ui/` is an npm package: Svelte 5 and Vite, nothing else, pinned to exact versions by `ui/package.json` and
  `ui/package-lock.json`. Add a dependency only when a screen cannot reasonably do without it.
- `make ui` (`npm --prefix ui ci`, then `npm --prefix ui run build`) writes `web/ui/app.js` (one file, fixed name, not in git).
  `web/index.html` loads it as a module after the old scripts. `npm --prefix ui run watch` rebuilds on every change.
- `packaging/bundle.sh` builds it before `cargo tauri build`; the workflow installs Node 22. `cargo build` warns when
  `web/ui/app.js` is missing (the window then has no top bar).
- Tests: `node --test ui/tests/*.test.js`, part of `make test`. Keep logic that can be tested without a browser in plain
  `.js` modules (`field.js`, `markdown.js`) and test it there.

## How the two halves share the page

- `ui/src/main.js` runs before the old `DOMContentLoaded` handler (`web/js/app.js`). It mounts `App.svelte` into
  `<div id="ui-root" style="display:contents">`, mounts the schema forms placed in the old workspace, and provides
  `window.Home` (boot, autosave, current profile) that the old scripts call.
- Ported so far (3.1): top bar, sign-in and terms acceptance, profiles and the profile menu, the landing page with the project
  list, settings, the update dialog, the legal texts, and the Solar resource weather form (as the first schema form).
- Ported in 3.2-3.3: the project forms of site, load, PV, wind, battery, auxiliary loads, genset, dispatch, EMS, plant records,
  fuel and economics (`data-ui-form` in `web/index.html`), and the input rules for files on open (`ui/src/lib/migrate.js`,
  called by `migrate()` in `web/js/app.js` through `window.SoloptimaUI.migrate`). Forms of the
  optimiser, day-ahead and project finance screens still use `data-form` and `renderForms()`.
- Ported in 3.4: the results of the simulation (run bar, stale banner, headline tiles, indicators, supply chart and comparison,
  monthly chart and table, hourly dispatch with its week slider, lifetime cash flow, year table), the optimisation (run with job
  progress and cancel, tiles, search-space map, Pareto, convergence, ranked systems, sensitivity) and the project finance results
  (tiles, four charts, cash-flow table). `<div data-ui-view="name">` in `web/index.html` places one (the `VIEWS` map in
  `ui/src/main.js`); components are in `ui/src/screens/results/`. The weather-year (P50/P90) card is `ResourceYears.svelte`
  (store `resource-years.svelte.js`, figures in `ry-view.js`; its result stays in `project.resource_years.result`, and the old
  report reads it through `SoloptimaUI.ry`), the PV loss diagram is `PvLoss.svelte` and the sun path chart `SunPath.svelte`
  (`sun.js`; `calcPV` and `lib/layout/edit.svelte.js` hand over the losses and the near-horizon shade with `SoloptimaUI.setPvLosses` and
  `setSunShade`, held in `plant.svelte.js`). Still on the old screens: the diesel-only calibration, energy flow, operating
  options, genset charts, battery health and tornado cards of the simulation page.
- Ported in 3.7-3.8: the Report & export page (`screens/report/ReportPage.svelte`, store `report.svelte.js`; figures for the report
  in `report-figs.svelte.js`) and everything behind it. The report is a Svelte document (`ReportDoc.svelte` and the `Rep*.svelte`
  sections): `report/render.js` mounts it on a detached element, copies it into a new HTML document (title, character set and
  style sheet set as elements), numbers the sections and figures and serialises it, so no HTML is built from strings and every
  project value is escaped by Svelte. The preview is a sandboxed iframe with no `allow-*` flags (no scripts); the HTML download
  and the workbook go through `saveFile` (`ipc.js`, `save_file`), printing through `print_report`. The logo and the single-line
  diagram arrive as SVG text and are parsed and cleaned by `report/svg-node.js` (no scripts, handlers or foreign links). The
  workbook is `report/sheets-a.js` and `sheets-b.js` (the sheets) over `report/xlsx.js` and `zip.js` (the writer, text always an
  inline string, never a formula); `SoloptimaUI.xlsx` serves the script console. `report/layout-geom.js` holds the site layout
  frame and the satellite image fetch, `figures.js` the rules for `P.report` (`SoloptimaUI.cleanReport` on file open).
  What the report still reads from cards not ported yet (the options, tornado, calibration, energy flow and battery health summaries,
  the data-quality summaries, the Forecast Lab result, the charts it takes pictures of) comes through `SoloptimaLegacy.report`
  (in `web/js/app.js`; `report/data.js`). The session that ports one of those cards replaces its entry there; when the object is
  empty it goes. The electrical design, the single-line diagram and the equipment library no longer come through it.
- Ported in 3.5-3.6: the Site & layout page (`screens/layout/`, mounted by `data-ui-view="layout"` on the page's `.map-grid`): the map
  card with search, imagery, drawing, shade objects, tables and files, the Location and Layout parameters forms (`SchemaForm`
  `site` and `layout`), the site information, the layout figures and the sun path. The map is Leaflet with Geoman
  (`web/vendor/`, globals); its stores are `lib/layout/map.svelte.js` (map, imagery, location, address, full screen, popups),
  `edit.svelte.js` (drawn items as Leaflet layers, editing, undo and redo, the fill, tables taken out, shade) and
  `tools.svelte.js` (KML, KMZ and GeoJSON files, OpenStreetMap buildings, the user's own image, roof tracing, Ctrl+click roof
  layout). What needs no map is plain modules under test: `geometry.js` (`tests/layout_geometry.test.js`), `items.js`,
  `fill.js` and `coords.js` (`ui/tests/layout.test.js`), and the moved `geodata.js`, `ortho.js` and `rooftrace.js`. The item
  editor and the OpenStreetMap choice are Svelte components mounted into Leaflet popups (`popup()` in `map.svelte.js`); tooltips
  and the site popup get text nodes, never HTML strings. The old workspace calls the page through `SoloptimaUI.layout`
  (reload, moveMarker, refreshInfo, scheduleRelayout, setShade, layoutUsed, cleanItem, cleanRemoved, invalidate,
  exitFullScreen); the page reaches `syncForms` and the time-zone lookup of `util.js` through `legacy.syncForms`, `siteZone` and
  `zoneCheck`.
- Ported in 3.9-3.10: the Equipment datasheets and Electrical design pages (`screens/equip/`, stores `lib/equip/equipment.svelte.js`
  and `electrical.svelte.js`). The logic is plain modules covered by `ui/tests/equip.test.js`: `library.js` (built-in datasheets,
  checks, JSON and CSV import and export with the formula guard, applying the datasheets to the model), `design.js` (string sizing,
  transformers, cables, losses, auto-size, apply losses), `loadflow.js` (the radial sweep) and `sld.js` (the diagram as SVG text,
  every text escaped). The design is computed from the project, `legacy.pvr()` (the last PV yield) and the last simulation, and
  cached until `forms.rev`, `res.rev`, the equipment or electrical edits, or `SoloptimaUI.pvChanged()` change; `tabShown` makes
  the two pages compute only while open. The diagram is shown as parsed elements (`report/svg-node.js`, never `innerHTML`) with
  wheel zoom and drag pan; SVG and PNG go through `saveFile`. Old scripts reach the library through `SoloptimaUI.defaultLibrary`
  and `migrateEquipment`, the script console and the report through `SoloptimaUI.design()`, `sldText()` and `equipment`.
- Ported in 3.11 (the last screens): the Forecast Lab, the script console and the CSV import with its data checks. After this row
  `web/js/` holds only the workspace itself (`app.js`, `charts.js`, `util.js`, `finance.js`).
  - Forecast Lab: `screens/forecast/ForecastLab.svelte`, store `lib/forecast.svelte.js` (run, result, picks), `lib/forecast-view.js`
    (traces, table, value of each method; `ui/tests/forecast.test.js`). The result is not saved; the report and the console read it
    through `SoloptimaUI.forecast()`. "Use in EMS" goes through `legacy.useForecast`, the request through `legacy.engineProject(true)`.
  - Script console: `screens/console/ConsolePage.svelte`, store `lib/console/console.svelte.js`, output and figures in
    `console/output.svelte.js` (plain arrays and a counter, drawn as elements: nothing a script prints is markup), the numeric library
    `console/numeric.js` (`ui/tests/console.test.js`), the plot, file and engine functions `console/env.js`, the examples and help
    text. The user's JavaScript runs only on Run (button or Ctrl+Enter), with the numeric library, `env.js` and the workspace names `P`,
    `project`, `sim`, `opt`, `hourly`, `pvr`, `forecast`, `equipment`, `design`, `MONTHS`, `HOURS`. Files go through `saveFile`; saved
    scripts are `project.scripts`, named in an inline field (no `prompt()`).
  - CSV import: `lib/tsimport.svelte.js` (dialog session, `check`, `use`, `runQc`, `fixWeather`), plain modules `tsimport/guess.js`
    (preview lines, column and unit guesses, engine options, the zone's clock changes via `lib/zone.js`) and `tsimport/texts.js` (report
    rows, unit hints, timing verdicts, notes, the quality rows of the report, the workbook rows, the timing fixes;
    `ui/tests/tsimport.test.js`). The dialog is `screens/tsimport/TsImportDialog.svelte` with `TsOptions` and `TsField`; the Data checks
    blocks under the weather summary and the load statistics are `QcBlock.svelte` (mounted into `#wxQc` and `#loadQc`). Qc values, flag
    names, file names and cells are shown with `{...}` only (never `{@html}`). The file text and the engine's answer stay out of the
    `$state` proxy. After a change of the data, `legacy.dataApplied(kind, status, full)` redraws the old pages; the old `drawWeather` and
    `drawLoad` call `SoloptimaUI.qcRefresh()` to redraw the blocks. `SoloptimaUI.tsQuality` and `tsRows` feed the report.
- The old workspace (`.shell` in `web/index.html`) shows while `app.screen` is `workspace`; `show()` in
  `state.svelte.js` keeps the body classes `home-mode` and `signin-mode` that its style sheet and scripts rely on.
- The Svelte side reaches the old screens only through `window.SoloptimaLegacy` (`web/js/app.js`), wrapped by
  `ui/src/lib/legacy.js`. A session that ports a screen moves what it needs out of the old script and deletes the entry on
  both sides; when the object is empty, the old scripts are gone.
- The top bar renders `#projName`, `#btnSave` and `#btnRunTop` with the ids the old workspace wires. They move into Svelte
  with the workspace.

## UI pattern (sessions 3.2 and later)

**Engine calls.** Only `call(command, args)` from `ui/src/lib/ipc.js`, with the command names and arguments of
`docs/ipc.md`: query parameters as named arguments, the request body as `body`. It throws an `Error` with the engine's
message (`internal` marks defects, which also go to the bug-report log). Never `fetch` an engine route, never
`window.__TAURI__` outside `ipc.js`.

**State.** One `$state` object, `app` in `ui/src/lib/state.svelte.js`: screen, profiles, project list, open dialog, save state.
Components read it; they change it only through the functions of the store modules (`session.svelte.js`,
`projects.svelte.js`, `update.svelte.js`), which also make the engine calls. A new group of screens adds its own module
(`results.svelte.js`, ...) with its own `$state` and functions, under about 8k tokens per file.

**The open project.** The project object belongs to the old workspace and is edited in place, so it is not Svelte state
(a proxy around it would also slow the old code). Read it with `legacy.project()`. Svelte reads it again when `forms.rev`
changes: `SoloptimaUI.refresh()` bumps it after every change made by the old screens. After a change made in
Svelte, call `legacy.onFieldChange(key)`, which updates the old forms, the autosave and the recalculations. When the
workspace is ported, the project moves into a store and `rev` goes.

**Forms from the schema.** `FORMS` in `ui/src/lib/schema/` (`index.js`; `forms-a.js`, `forms-b.js`, `consts.js`, `project.js` for the default project) stays the single description of the inputs (label, unit, type,
limits, step, placeholder, options, slider, `show` condition). `SchemaForm.svelte` renders one form by name;
`Field.svelte` renders one entry, and `field.js` holds its value rules (percent fields, integer rounding, lists, limits,
blank for an optional value). A ported screen writes `<SchemaForm name="pv" />` where the old page had
`<div class="form" data-form="pv">`; until then, `<div class="form" data-ui-form="pv">` in `web/index.html` has `main.js`
mount it into the old page. Fields keep the old ids (`f_<form>_<path>`), `data-k`, the class names of `style.css` and the
ⓘ help buttons (texts in `ui/src/lib/help/`, popup in `infopop.js`).

**Results and charts.** `results.svelte.js` runs `simulate` and `optimize` through `call` (the optimisation polls `job` and can
`job_cancel`) and holds the results as raw objects (`data.sim`, `data.opt`; hourly arrays are not proxied); `res.rev` is bumped
after each run and every component that shows a result reads it. The old scripts still read `SIM` and `OPT` (report, finance
inputs, tornado), so the store hands each result over with `legacy.setSim` / `legacy.setOpt`. What a screen shows is built by
plain modules (`sim-view.js`, `opt-view.js`, `fin-view.js`: tiles, tables, chart traces) that `ui/tests/results.test.js`
covers; `Chart.svelte` only draws them with Plotly (`web/vendor/plotly.min.js`, global) in the shared look of `chart.js`. A chart
keeps its element id and Plotly's `data`, because the report takes its pictures from those elements. A chart drawn on a hidden
page is resized when the page opens.

**Escaping.** Every value goes through Svelte's `{...}` text and attribute bindings, which escape. No `{@html}`, no
`innerHTML`, no HTML built in strings, anywhere in `ui/`. Markdown (terms, release notes, reports) goes through
`Markdown.svelte`, which renders the tokens of `markdown.js` as elements; links open with `openExternal` (http and https
only). Profile pictures are shown only when they are a `data:image/png|jpeg|webp;base64` URL (`profile.js`).

**Markup and style.** Components reuse the class names of `web/style.css` (`btn`, `card`, `dlg`, `status`, `hint`, ...), so
ported screens look as before; add a component `<style>` only for what the shared sheet does not cover. Modal dialogs use
`Dialog.svelte` (open while a condition holds, `onclose` clears it); only one is open at a time (`app.dialog`).

**Messages.** Short notices go to `legacy.toast(text, isError)` until the toast is ported; inline status next to a button
is a `<span class="status inline {kind}" role="status">` bound to the component's state.

**Files.** Screens in `ui/src/screens/`, shared components and stores in `ui/src/lib/`. Keep each file under about
8k tokens; split a screen into child components before it grows past that.

## Moved out of `web/js` (row 3.12)

- Inputs: `lib/schema/` (default project, forms, constants) and `lib/help/` (the ⓘ texts) are ES modules; `main.js` still puts them on
  `window` for the old scripts until `app.js` is ported. The ⓘ popup is `lib/infopop.js` (text nodes only).
- File rules: `lib/migrate-project.js` is the whole of `migrate()` (form rules, then `cleanQc`, `cleanResourceYears`, `cleanLayout`,
  equipment and report figures); `ui/tests/migrate.test.js` covers the qc, resource_years and layout rules.
- Bug reports: the dialogs are `screens/reports/` (store `lib/reports.svelte.js`); the documents (Markdown, redaction, signature,
  issue address) are `lib/reports/doc.js`, the automatic capture of script errors and engine defects `lib/reports/capture.js`
  (`ui/tests/reports.test.js`). Delete asks twice inline instead of a `confirm()` box.
