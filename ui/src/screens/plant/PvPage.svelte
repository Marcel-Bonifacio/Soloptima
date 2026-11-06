<!-- PV & wind page (tab 4): the model forms, the yield calculation and its results -->
<script>
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import Chart from '../../lib/Chart.svelte';
  import PvLoss from '../results/PvLoss.svelte';
  import PvBalance from './PvBalance.svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { pv, shown, calcPV, tiltScan, horizonFromPvgis, pvRefText } from '../../lib/pv.svelte.js';
  import { pvTiles, tiltFig, windPreview, windFig } from '../../lib/pv-view.js';
  import { monthlyBarsFig } from '../../lib/chart-kit.js';
  import { monthlySum } from '../../lib/series.js';

  // the yield tiles, the monthly chart and the PVGIS line follow the last yield calculation (W.PVR) and the project
  const R = $derived.by(() => { forms.rev; pv.rev; return W.PVR; });
  const tiles = $derived(R ? pvTiles(R, W.P.pv.capacity_kwp) : null);
  const refLine = $derived.by(() => { forms.rev; pv.rev; return W.PVREF && W.P ? pvRefText(W.PVREF).join(' ') : pv.refErr; });
  const wind = $derived.by(() => { forms.rev; pv.rev; return W.P ? windPreview(W.P) : { text: '', monthlyMwh: null }; });
</script>

<section id="tab-pv" class="tab" class:active={ws.tab === 'pv'}>
  <h1>PV &amp; wind</h1>
  <p class="lead">Module, mounting and loss assumptions. The yield model is an hourly loss chain (transposition, row shading, bifacial rear side, IAM, soiling, temperature, DC/AC losses, clipping).</p>
  <div class="grid-3">
    <div class="card"><h3>Array &amp; module</h3><div class="form"><SchemaForm name="pv-module" /></div></div>
    <div class="card"><h3>Mounting</h3><div class="form"><SchemaForm name="pv-mount" /></div>
      <button id="btnTilt" class="btn small ghost" disabled={pv.tiltBusy} onclick={tiltScan}>{pv.tiltBusy ? '… ' : ''}Scan tilt 0–45°</button>
      <button id="btnHorizon" class="btn small ghost" disabled={pv.horizonBusy} onclick={horizonFromPvgis}>{pv.horizonBusy ? '… ' : ''}Horizon from PVGIS</button></div>
    <div class="card"><h3>Losses &amp; inverter</h3><div class="form"><SchemaForm name="pv-loss" /></div></div>
  </div>
  <div class="card"><div class="row space"><h3>Wind turbines (optional)</h3><span class="hint inline">Power-law shear to hub height, then a cubic or linear power curve.</span></div>
    <div class="grid-2"><div class="form"><SchemaForm name="wind" /></div><div>
      <Chart id="chWind" cls="short" build={(c) => (wind.monthlyMwh ? windFig(wind.monthlyMwh, c) : null)} />
      <div id="windStats" class="hint">{wind.text}</div></div></div></div>
  <div class="row gap"><button id="btnPvCalc" class="btn primary" disabled={pv.busy} onclick={() => calcPV()}>{pv.busy ? '… ' : ''}Calculate yield</button>
    <span id="pvStatus" class="status inline {pv.kind}" role="status">{pv.status}</span></div>
  <div class="card"><div id="pvStats">{#if tiles}<Kpis items={tiles} />{/if}</div></div>
  <div class="grid-2">
    <div class="card"><h3>Loss diagram (year 1)</h3><PvLoss /><p id="pvRef" class="hint" hidden={!refLine}>{refLine}</p></div>
    <div class="card"><h3>Monthly specific yield</h3>
      <Chart id="chPvMonthly" build={(c) => (R ? monthlyBarsFig([{ name: 'Yield', y: monthlySum(R.ac_per_kwp), color: c.pv, unit: 'kWh/kWp' }], 'kWh/kWp') : null)} />
      <h3>Tilt scan</h3>
      <Chart id="chTilt" cls="short" build={(c) => { pv.rev; return shown.tilt ? tiltFig(shown.tilt, c) : null; }} /></div>
  </div>
  <PvBalance />
</section>
