<!-- The overcurrent devices: breakers and settings (suggested, or typed over), grading checks, cable withstand and the time-current chart -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { fmtNum } from '../../lib/format.js';
  import { svgNode } from '../../lib/report/svg-node.js';
  import { CURVES } from '../../lib/equip/protection.js';
  import { protection, tccText, setBreaker, setProt, design } from '../../lib/equip/electrical.svelte.js';

  const PR = $derived(protection());
  const devs = $derived(Object.values(PR.dev));
  const breakers = $derived.by(() => { design(); return W.P.equipment.lib.breaker || []; });
  const tcc = $derived.by(() => { protection(); return tccText(); });
  const sec = (t) => (t == null || !isFinite(t) ? 'no trip' : fmtNum(t, 2) + ' s');
  const amps = (x) => fmtNum(x, 0);
  const fits = (b, d) => (d.kv > 1 ? b.ur_kv > 1 : b.ur_kv <= 1) && b.ur_kv >= d.kv;
</script>

<h4>Overcurrent devices</h4>
<div class="table-wrap">
  <table class="data">
    <thead><tr><th>Device</th><th>V</th><th>Full load A</th><th>Breaker</th><th>Curve</th><th>Pickup A</th><th>TMS</th><th>I&gt;&gt; A</th><th>Min fault A</th><th>Max fault A</th><th>Clearing s</th></tr></thead>
    <tbody>
      {#each devs as d (d.key)}
        <tr>
          <td>{d.name}</td><td>{fmtNum(d.kv * 1000)}</td><td>{amps(d.In)}</td>
          <td><select aria-label="Breaker of the {d.name}" value={d.auto || !d.brk ? '' : d.brk.id} onchange={(e) => setBreaker(d.key, e.currentTarget.value)}>
            <option value="">Auto{d.auto && d.brk ? `: ${d.brk.name}` : ''}</option>
            {#each breakers.filter((b) => fits(b, d)) as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
          </select>
            {#if d.chk && d.chk.length}<span class="cell-sub" style:color="var(--danger)">{d.chk.length} duty check{d.chk.length > 1 ? 's' : ''} failed</span>{/if}</td>
          <td><select aria-label="Curve of the {d.name}" value={d.o.curve || ''} onchange={(e) => setProt(d.key, 'curve', e.currentTarget.value)}>
            <option value="">{d.sug.curve} (suggested)</option>
            {#each Object.entries(CURVES) as [k, c] (k)}<option value={k}>{c.label}</option>{/each}
          </select></td>
          <td><input type="number" min="0" step="any" style="width:76px" aria-label="Pickup of the {d.name}" value={d.o.pickup ?? ''} placeholder={String(d.sug.pickup)} onchange={(e) => setProt(d.key, 'pickup', e.currentTarget.value)}></td>
          <td><input type="number" min="0" step="0.025" style="width:64px" aria-label="Time multiplier of the {d.name}" value={d.o.tms ?? ''} placeholder={String(d.sug.tms)} onchange={(e) => setProt(d.key, 'tms', e.currentTarget.value)}></td>
          <td><input type="number" min="0" step="any" style="width:76px" aria-label="Instantaneous pickup of the {d.name} (0 = off)" value={d.o.inst ?? ''} placeholder={d.sug.inst ? String(d.sug.inst) : 'off'} onchange={(e) => setProt(d.key, 'inst', e.currentTarget.value)}></td>
          <td style:color={d.minFault > 0 && d.minFault < 1.5 * d.set.pickup ? 'var(--danger)' : null}>{amps(d.minFault)}</td><td>{amps(d.maxFault)}</td><td>{d.tClear != null ? fmtNum(d.tClear, 2) : '–'}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
<p class="hint">Blank cells use the suggestion shown in grey: pickup 1.25 × full-load current, the smallest time multiplier that keeps the grading margin above the downstream device, an instantaneous stage on transformer feeders above 1.3 × the LV through-fault. Min fault: two-phase at the end of the device's zone with the fewest sources. Clearing: relay time at the largest current it carries plus 50 ms breaker time.</p>

<h4>Grading</h4>
<div class="table-wrap">
  <table class="data">
    <thead><tr><th>Case</th><th>Downstream</th><th>I A</th><th>t</th><th>Upstream</th><th>I A</th><th>t</th><th>Margin</th></tr></thead>
    <tbody>
      {#each PR.grading as r (r.down + r.up)}
        <tr><td>{r.label}</td><td>{PR.dev[r.down].name}</td><td>{amps(r.Id)}</td><td>{sec(r.td)}</td><td>{PR.dev[r.up].name}</td><td>{amps(r.Iu)}</td><td>{sec(r.tu)}</td>
          <td style:color={r.ok ? 'var(--good)' : 'var(--danger)'}>{r.margin != null ? fmtNum(r.margin, 2) + ' s' : r.ok ? 'upstream does not trip' : 'not cleared'}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<h4>Cable short-time withstand</h4>
<div class="table-wrap">
  <table class="data">
    <thead><tr><th>Circuit</th><th>Cable</th><th>Ik″ kA</th><th>Ith kA</th><th>Clearing s</th><th>Withstand kA</th><th>Min mm² per run</th></tr></thead>
    <tbody>
      {#each PR.cables as c (c.key)}
        <tr><td>{c.name}</td><td>{c.runs > 1 ? c.runs + ' × ' : ''}{c.cab.name}</td><td>{fmtNum(c.ik, 2)}</td><td>{fmtNum(c.ith, 2)}</td>
          <td>{fmtNum(c.t, 2)}{c.cleared ? '' : ' (no trip)'}</td><td style:color={c.ok ? null : 'var(--danger)'}>{fmtNum(c.adm, 1)}</td><td>{fmtNum(c.sMin, 0)}</td></tr>
      {/each}
    </tbody>
  </table>
</div>
<p class="hint">Adiabatic withstand k·S/√t with XLPE insulation (k = 143 copper, 94 aluminium, 90 → 250 °C). Ith includes the DC component (IEC 60909 factor m). A circuit whose device does not trip uses the clearing time without overcurrent trip.</p>

<h4>Time-current coordination</h4>
<div class="tcc-wrap" use:svgNode={tcc}></div>
<p class="hint">Circles: the operating points of the grading checks (red when the margin is short). Currents of LV devices are referred to the MV voltage.</p>
