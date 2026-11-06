<!-- Inter-annual variability and P50/P90 card of the Solar resource page: inputs, run, chart, table and the debt-sizing factor -->
<script>
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import Chart from '../../lib/Chart.svelte';
  import DataTable from '../../lib/DataTable.svelte';
  import { forms } from '../../lib/state.svelte.js';
  import { ry, runRy, cancelRy, setBasis, applyRy } from '../../lib/resource-years.svelte.js';
  import { legacy } from '../../lib/legacy.js';
  import { summary, tableRows, notes, factorText, chart, HEADS } from '../../lib/ry-view.js';

  // read again after every change of the open project (forms.rev), which also covers a run, a new project and the debt factor
  const view = $derived.by(() => {
    forms.rev;
    const P = legacy.project(), X = P && P.resource_years && P.resource_years.result;
    if (!X) return null;
    const S = summary(X, P.resource_years.applied, P.finance.p90_factor, legacy.ryKey()), cur = P.econ.currency;
    return { S, cur, basis: P.resource_years.basis === 10 ? '10' : '1', rows: tableRows(S, cur), notes: notes(S, P.wind ? P.wind.units : 0), factor: factorText(S) };
  });
</script>

<div class="card"><h3>Inter-annual variability and P50/P90</h3>
  <div class="grid-2">
    <div><div class="form"><SchemaForm name="resource-years" /></div>
      <div class="row gap"><button id="btnRy" class="btn primary" disabled={ry.busy} onclick={runRy}>Run weather years</button>
        {#if ry.busy}<button id="btnRyCancel" class="btn ghost" onclick={cancelRy}>Cancel</button>
          <div class="progress" id="ryProg"><div style:width="{(ry.progress * 100).toFixed(1)}%"></div></div>{/if}</div>
      <div id="ryStatus" class="status {ry.kind}" role="status">{ry.status}</div></div>
    <div><p class="hint">Simulates year 1 of the plant once with each historical weather year, sizes and settings unchanged, and gives P50, P75, P90 and P99 of the specific yield, fuel saved, renewable fraction, revenue and fuel used. Fuel saved and revenue vary less than the PV yield when gensets run at minimum loading, the battery is full or a take-or-pay floor applies, so each result gets its own spread.</p>
      <p class="hint">The spread is used only as ratios: P50 stays on the project's weather above. The systematic uncertainty (root-sum-square of the three inputs) is scaled by each result's sensitivity to irradiance, found by running the project's weather with its irradiance raised and lowered by that amount. With wind turbines, each weather year also brings its own wind speeds, but the systematic uncertainty and the elasticity cover irradiance only, so the P90 leaves out the uncertainty of the long-term wind resource. PVGIS serves ERA5 reanalysis over most of Indonesia, so cross-check it against NASA POWER. The years are downloaded once per session (PVGIS about a minute, NASA POWER about 20 s per three years) and are not saved in the project.</p></div>
  </div>
  {#if view}
    <Chart id="chRy" build={(c) => chart(view.S, c, view.cur)} />
    <DataTable heads={HEADS} rows={view.rows} />
    <div class="row gap"><label class="hint inline">Debt sizing on
        <select id="ryBasis" aria-label="P90 used for debt sizing" value={view.basis} onchange={(e) => setBasis(+e.currentTarget.value)}>
          <option value="1">P90 of one year</option><option value="10">P90 of a 10-year average</option></select>
        <button type="button" class="info" data-k="resource_years.basis" data-title="P90 for debt sizing" aria-label="About P90 for debt sizing" aria-expanded="false">i</button></label>
      <button id="btnRyUse" class="btn small primary" onclick={applyRy}>Use for debt sizing</button><span id="ryFactor" class="hint inline">{view.factor}</span></div>
    <p id="ryNote" class="hint">{view.notes.join(' ')}</p>
  {/if}
</div>
