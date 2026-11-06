<!-- Hourly dispatch of one week, with a slider and a list of weeks that stand out -->
<script>
  import { weekPicks } from '../../lib/sim.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import Chart from '../../lib/Chart.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { dispatchChart, weekStart } from '../../lib/sim-view.js';
  import { dateOfHour } from '../../lib/series.js';

  const PICKS = [['unmet', 'Highest unmet load'], ['units', 'Most gensets online'], ['re', 'Lowest renewable share'], ['curt', 'Highest curtailment'],
    ['soc', 'Lowest battery SOC'], ['lowload', 'Longest low-load run'], ['pv', 'Best PV week']];
  let goto = $state('');

  const start = $derived(weekStart(res.week));
  const picks = $derived.by(() => { res.rev; if (!data.sim) return []; const p = weekPicks(data.sim.result); return PICKS.filter(([k]) => p[k] != null).map(([k, l]) => [l, p[k]]); });
  const predictive = $derived.by(() => { res.rev; return W.P.diesel.strategy === 'predictive'; });
  const go = () => { if (goto !== '') res.week = Math.min(51, Math.floor(+goto / 168)); };
</script>

<div class="card">
  <div class="row space"><h3>Hourly dispatch</h3>
    <div class="row gap">
      <label>Week <input type="range" min="0" max="51" bind:value={res.week} oninput={() => (goto = '')} /></label>
      <span>{dateOfHour(start)} to {dateOfHour(start + 167)}</span>
      <select aria-label="Go to a week" bind:value={goto} onchange={go}>
        <option value="">Go to…</option>
        {#each picks as [label, hour]}<option value={hour}>{label}: {dateOfHour(hour)} to {dateOfHour(hour + 167)}</option>{/each}
      </select>
    </div>
  </div>
  <Chart id="chDispatch" cls="xtall" build={(c) => { res.rev; return data.sim && dispatchChart(data.sim.result.hourly, start, 168, predictive, c); }} />
</div>
