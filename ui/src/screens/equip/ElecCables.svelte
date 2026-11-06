<!-- The cable circuits of the electrical design: choice, parallel runs, length, loading, voltage drop, losses and cost -->
<script>
  import { legacy } from '../../lib/legacy.js';
  import { fmtNum, fmtPct } from '../../lib/format.js';
  import { cableClass } from '../../lib/equip/design.js';
  import { design, auto, setCable, setRuns, setLength } from '../../lib/equip/electrical.svelte.js';

  const D = $derived(design());
  const cur = $derived.by(() => { design(); return legacy.project().econ.currency; });
  const cables = $derived.by(() => { design(); return legacy.project().equipment.lib.cable; });
</script>

<div class="card">
  <div class="row space"><h3>Cables</h3><div class="row gap"><button class="btn small" onclick={auto}>Auto-size all cables</button></div></div>
  <div class="table-wrap">
    <table class="data">
      <thead><tr><th>Circuit</th><th>No.</th><th>Cable</th><th>Runs</th><th>Length m</th><th>I design A</th><th>Rating A</th><th>Use</th><th>ΔV %</th><th>Loss @ rated kW</th><th>Annual MWh</th><th>Cost {cur}</th></tr></thead>
      <tbody>
        {#each D.circuits as c (c.key)}
          <tr>
            <td>{c.name}</td><td>{fmtNum(c.count)}</td>
            <td><select aria-label="Cable for {c.name}" value={c.cab ? c.cab.id : ''} onchange={(e) => setCable(c.key, e.currentTarget.value)}>
              {#each cables.filter((x) => cableClass(x) === c.cls) as x (x.id)}<option value={x.id}>{x.name}</option>{/each}
            </select></td>
            <td><input type="number" min="1" step="1" style="width:56px" aria-label="Parallel runs" value={c.runs} onchange={(e) => setRuns(c.key, e.currentTarget.value)}></td>
            <td><input type="number" min="0" step="1" style="width:72px" aria-label="Length in metres" value={c.L ?? ''} onchange={(e) => setLength(c.key, e.currentTarget.value)}></td>
            <td>{fmtNum(c.I, 0)}</td><td>{c.amp ? fmtNum(c.amp, 0) : '–'}</td>
            <td style:color={c.util > 1 ? 'var(--danger)' : null}>{c.util != null ? fmtPct(c.util, 0) : '–'}</td>
            <td style:color={c.dv * 100 > c.lim ? 'var(--danger)' : null}>{c.dv != null ? (c.dv * 100).toFixed(2) : '–'}</td>
            <td>{c.ploss != null ? fmtNum(c.ploss * c.count, 1) : '–'}</td><td>{c.annual != null ? fmtNum(c.annual / 1000, 1) : '–'}</td><td>{fmtNum(c.cost || 0)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="hint">Resistance corrected to 70 °C conductor temperature. Current rating = datasheet value × derating × parallel runs. MV collector feeders with several transformers use the distributed-load factors for losses ((n+1)(2n+1)/6n²) and voltage drop ((n+1)/2n).</p>
</div>
