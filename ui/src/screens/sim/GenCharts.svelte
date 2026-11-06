<!-- Genset loading, units online and the battery state of charge by day and hour -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import { W } from '../../lib/ws/state.js';
  import { res, data } from '../../lib/results.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { jump } from '../../lib/sim.svelte.js';
  import { genLoadFigure, unitsDurationFigure, socHeatFigure, hasBattery } from '../../lib/sim-extra.js';

  // the genset values the loading chart uses; a string, so other edits do not redraw it
  const dsl = $derived.by(() => { forms.rev; const d = W.P.diesel; return JSON.stringify({ unit_kw: d.unit_kw, min_load: d.min_load }); });
</script>

<div class="grid-2">
  <div class="card"><h3>Genset loading (hours per band)</h3>
    <Chart id="chGenLoad" build={(c) => { res.rev; return data.sim && genLoadFigure(c, data.sim.result.hourly, JSON.parse(dsl)); }} /></div>
  <div class="card"><h3>Units online duration curve</h3>
    <Chart id="chUnitsDur" build={(c) => { res.rev; return data.sim && unitsDurationFigure(c, data.sim.result.hourly, data.sim.baseline_hourly); }} />
    <p class="hint">Gensets online in each hour of year 1, sorted from most to fewest. Firm capacity is set by the peak load and the reserve rule, not by PV. The gap between the curves is daytime unit-hours freed for maintenance, not units that can be retired: forced outages and N-1 are not modelled.</p></div>
</div>
<div class="card"><h3>Battery state of charge by day and hour</h3>
  <!-- a click on a day opens that week in the dispatch chart -->
  <Chart id="chSocHeat" build={(c) => { res.rev; return data.sim && W.P.bess.energy_kwh > 0 ? socHeatFigure(c, data.sim.result.hourly) : null; }} onclick={(pt) => jump((pt.x - 1) * 24)} /></div>
