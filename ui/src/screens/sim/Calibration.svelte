<!-- Diesel-only baseline against the site's records -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import { res } from '../../lib/results.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { calibration, calFmt, calPct } from '../../lib/sim.svelte.js';
  import { calibrationFigure } from '../../lib/sim-extra.js';
  import { fmtNum } from '../../lib/format.js';

  // as text, so a keystroke elsewhere that changes nothing here does not redraw
  const json = $derived.by(() => { res.rev; forms.rev; return JSON.stringify(calibration()); });
  const K = $derived(JSON.parse(json));
</script>

{#if K}
  <div class="card" id="calCard"><h3>Diesel-only baseline against site records</h3>
    <p id="calBasis" class="hint">{K.basis}</p>
    <div id="calTable" class="table-wrap">
      {#if K.rows.length}
        <table class="data"><tbody><tr><th>Record</th><th>Site</th><th>Model</th><th>Difference</th></tr>
          {#each K.rows as x}
            <tr><td>{x.label} ({x.unit})</td><td>{calFmt(x.k, x.site)}</td><td>{calFmt(x.k, x.model)}</td>
              <td>{calPct(x.d)}<span class={x.flag ? 'why' : 'tol'}>{x.flag ? 'beyond' : 'within'} ±{fmtNum(x.tol * 100)} %</span></td></tr>
          {/each}</tbody></table>
      {/if}
    </div>
    {#if K.monthly}
      <div id="calMonthly"><Chart id="chCal" build={(c) => calibrationFigure(c, K)} /><p id="calMonthNote" class="hint">{K.monthNote}</p></div>
    {/if}
    <ul id="calDiag" class="cal-diag">{#each K.diag as t}<li>{t}</li>{/each}</ul></div>
{/if}
