# The interface (Svelte)

The interface is Svelte 5 in `ui/` (rewrite rows 3.1 to 3.12). The old vanilla scripts of `web/js/` are gone.

## Build

- `ui/` is an npm package: Svelte 5 and Vite, nothing else, pinned to exact versions by `ui/package.json` and
  `ui/package-lock.json`. Add a dependency only when a screen cannot reasonably do without it.
- `make ui` (`npm --prefix ui ci`, then `npm --prefix ui run build`) writes `web/ui/app.js` (one file, fixed name, not in git).
  `web/index.html` loads it as a module. `npm --prefix ui run watch` rebuilds on every change.
- `packaging/bundle.sh` builds it before `cargo tauri build`; the workflow installs Node 22. `cargo build` warns when
  `web/ui/app.js` is missing (the window then has no top bar).
- Tests: `node --test ui/tests/*.test.js`, part of `make test`. Keep logic that can be tested without a browser in plain
  `.js` modules (`field.js`, `markdown.js`) and test it there.

## The workspace

- `ui/src/main.js` makes the placeholder project, mounts `App.svelte` into `<div id="ui-root">` and starts the workspace and the
  profiles. `web/index.html` is only that root, the toast element and the scripts (`web/vendor/` and the built `ui/app.js`).
- `screens/workspace/Workspace.svelte` is the open project's shell: the side navigation (`Nav.svelte`, marks from `lib/ws/checks.js`), the
  pages and the back and next buttons (`StepNav.svelte`). A page is a component with its whole `<section id="tab-x" class="tab">`:
  site (`layout/`), resource and load (`screens/data/`), PV, battery, diesel and costs (`screens/plant/`), equipment and electrical
  (`screens/equip/`), simulation (`screens/sim/`), optimisation and EMS (`screens/plan/`), finance (`screens/finance/`), script console
  and report. The open page is `ws.tab` (`lib/ws/tabs.svelte.js`, `showTab`).
- The open project and the last results are `W` in `lib/ws/state.js` (`W.P`, `W.PVR`, `W.SIM`, `W.OPT`, ...): plain objects edited in
  place, not Svelte state. A page that edits the project calls `onFieldChange(key)` (`lib/ws/project.js`: other forms, autosave,
  recalculation, the live simulation); everything else is refreshed through `refreshForms()` (`forms.rev`) and the stores' own `rev`.
  `lib/ws/core.js` has `engineProject`, `requireInputs` and `autosave`; `lib/ws/keys.js` the fingerprints that tell a result is stale;
  `lib/ws/diff.js` the list of changed inputs; `project.js` also opens a project (`setProject`, which resets every store), makes the
  badges of the project list (`meta`), the copy for disk (`saveCopy`) and the exported file (`exportProject`).
- Each area has a store (`lib/data.svelte.js`, `pv.svelte.js`, `sim.svelte.js`, `options.svelte.js`, `tornado.svelte.js`, `plan.svelte.js`,
  `finance.svelte.js`) with a `reset()` that `setProject` calls, and plain view modules (`data-view.js`, `pv-view.js`, `diesel-view.js`,
  `sim-extra.js`, `options-view.js`, `tornado-view.js`, `plan-view.js`, `finance-view.js`) that `ui/tests/` covers. Charts are
  `<Chart>` components, drawn whenever they are mounted, also on hidden pages, because the report takes its pictures from them.
- The report reads the open project and the cards through `lib/report/inputs.js`.
- Short notices: `toast()` (`lib/toast.js`). Info buttons: `lib/infopop.js`. Bug reports: `screens/reports/`, `lib/reports/`.
- The top bar renders the project's name, export and run while a project is open.

## UI pattern (sessions 3.2 and later)

**Engine calls.** Only `call(command, args)` from `ui/src/lib/ipc.js`, with the command names and arguments of
`docs/ipc.md`: query parameters as named arguments, the request body as `body`. It throws an `Error` with the engine's
message (`internal` marks defects, which also go to the bug-report log). Never `fetch` an engine route, never
`window.__TAURI__` outside `ipc.js`.

**State.** One `$state` object, `app` in `ui/src/lib/state.svelte.js`: screen, profiles, project list, open dialog, save state.
Components read it; they change it only through the functions of the store modules (`session.svelte.js`,
`projects.svelte.js`, `update.svelte.js`), which also make the engine calls. A new group of screens adds its own module
(`results.svelte.js`, ...) with its own `$state` and functions, under about 8k tokens per file.

**The open project.** The project object (`W.P`, see "The workspace") is edited in place, so it is not Svelte state (a proxy around it
would also slow the engine code). Svelte reads it again when `forms.rev` changes (`refreshForms()`). After a change made in a
component, call `onFieldChange(key)`, which updates the other forms, the autosave and the recalculations.

**Forms from the schema.** `FORMS` in `ui/src/lib/schema/` (`index.js`; `forms-a.js`, `forms-b.js`, `consts.js`, `project.js` for the default project) stays the single description of the inputs (label, unit, type,
limits, step, placeholder, options, slider, `show` condition). `SchemaForm.svelte` renders one form by name;
`Field.svelte` renders one entry, and `field.js` holds its value rules (percent fields, integer rounding, lists, limits,
blank for an optional value). A page writes `<SchemaForm name="pv" />`. Fields keep the ids (`f_<form>_<path>`), `data-k`, the class names of `style.css` and the
ⓘ help buttons (texts in `ui/src/lib/help/`, popup in `infopop.js`).

**Results and charts.** `results.svelte.js` runs `simulate` and `optimize` through `call` (the optimisation polls `job` and can
`job_cancel`) and holds the results as raw objects (`data.sim`, `data.opt`; hourly arrays are not proxied); `res.rev` is bumped
after each run and every component that shows a result reads it. The report, the finance inputs and the tornado read `W.SIM` and `W.OPT`, so the store hands each result over with `setSim` / `setOpt`. What a screen shows is built by
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

**Messages.** Short notices go to `toast(text, isError)` (`lib/toast.js`); inline status next to a button
is a `<span class="status inline {kind}" role="status">` bound to the component's state.

**Files.** Screens in `ui/src/screens/`, shared components and stores in `ui/src/lib/`. Keep each file under about
8k tokens; split a screen into child components before it grows past that.

## Other modules

- Inputs: `lib/schema/` (default project, forms, constants) and `lib/help/` (the ⓘ texts). The ⓘ popup is `lib/infopop.js` (text nodes only).
- File rules: `lib/migrate-project.js` is the whole of `migrate()` (form rules, then `cleanQc`, `cleanResourceYears`, `cleanLayout`,
  equipment and report figures); `ui/tests/migrate.test.js` covers the qc, resource_years and layout rules.
- Bug reports: the dialogs are `screens/reports/` (store `lib/reports.svelte.js`); the documents (Markdown, redaction, signature, issue
  address) are `lib/reports/doc.js`, the automatic capture of script errors and engine defects `lib/reports/capture.js`
  (`ui/tests/reports.test.js`). Delete asks twice inline instead of a `confirm()` box.
