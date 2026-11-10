<!-- Short circuit and protection: the basis of the study, the fault levels at every bus, the warnings, then the devices -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { fmtNum } from '../../lib/format.js';
  import { hasHelp } from '../../lib/help/index.js';
  import { el, setBasis, protection, design } from '../../lib/equip/electrical.svelte.js';
  import ProtDevices from './ProtDevices.svelte';

  const PR = $derived(protection());
  const E = $derived.by(() => { design(); return W.P.electrical; });
  // E is the same object after every change, so what the page shows of it as a choice is derived on its own
  const earthing = $derived.by(() => { el.rev; design(); return W.P.electrical.mv_earthing; });
  const gridOn = $derived.by(() => { el.rev; design(); return W.P.electrical.grid_mva > 0; });
  // [key, label, unit, step]
  const NUM = [['grid_mva', 'Utility short-circuit power (0 = isolated plant)', 'MVA', 'any'], ['grid_xr', 'Utility X/R ratio', '', 'any'],
    ['mv_earth_a', 'MV neutral resistor current', 'A', 1], ['grading_s', 'Grading margin', 's', 0.05], ['sc_t_max', 'Clearing time without overcurrent trip', 's', 0.1]];
  const EARTH = [['resistance', 'Resistance earthed (neutral resistor)'], ['solid', 'Solidly earthed'], ['isolated', 'Isolated']];
  const kA = (x) => (x == null ? '–' : fmtNum(x, x < 10 ? 2 : 1));
</script>

<div class="card">
  <h3>Short circuit and protection</h3>
  <p class="hint">Fault levels by the IEC 60909-0 method: the equivalent voltage source c·Un/√3 at the fault (c = 1.10 MV / 1.05 LV for the maximum, 1.00 / 0.95 for the minimum), gensets behind X″d with K<sub>G</sub>, transformers with K<sub>T</sub>, inverters and PCS as current sources at their fault-current multiple. Maximum: all sources, conductors at 20 °C. Minimum: the gensets always online and the battery, no PV, conductors at 80 °C.</p>
  <div class="grid-2">
    <div class="form">
      {#each NUM as [k, l, u, step] (k)}
        <label for="el_{k}">{l}{#if hasHelp('el.' + k)}<button type="button" class="info" data-k="el.{k}" data-title={l} aria-label="About {l}" aria-expanded="false">i</button>{/if}</label>
        <div class="field">
          <input id="el_{k}" type="number" min="0" {step} value={E[k] ?? ''} disabled={(k === 'grid_xr' && !gridOn) || (k === 'mv_earth_a' && earthing !== 'resistance')}
            onchange={(e) => setBasis(k, e.currentTarget.value === '' ? null : +e.currentTarget.value)}>
          {#if u}<span class="unit">{u}</span>{/if}
        </div>
      {/each}
      <label for="el_mv_earthing">MV system earthing{#if hasHelp('el.mv_earthing')}<button type="button" class="info" data-k="el.mv_earthing" data-title="MV system earthing" aria-label="About MV system earthing" aria-expanded="false">i</button>{/if}</label>
      <div class="field">
        <select id="el_mv_earthing" value={earthing} onchange={(e) => setBasis('mv_earthing', e.currentTarget.value)}>
          {#each EARTH as [v, l]}<option value={v}>{l}</option>{/each}
        </select>
      </div>
    </div>
    <div>
      {#if PR.notes.length}<p class="hint">{#each PR.notes as n, i}{#if i}<br>{/if}{n}{/each}</p>{/if}
      <p class="hint">Ik″ initial symmetrical, ip peak (κ by method B), Ib breaking current at 0.1 s (genset decay μ), Ik1 line-to-earth. LV buses of a transformer without an earthed star on that side (vector group Dy) are IT systems: a first earth fault draws no fault current.</p>
    </div>
  </div>

  <h4>Fault levels</h4>
  <div class="table-wrap">
    <table class="data">
      <thead><tr><th>Bus</th><th>kV</th><th>Ik″ max kA</th><th>ip kA</th><th>Ib kA</th><th>Ik1 kA</th><th>R/X</th><th>Ik″ min kA</th><th>Ik2 min kA</th><th>From gensets / converters{gridOn ? ' / grid' : ''} kA</th></tr></thead>
      <tbody>
        {#each PR.F.buses as b (b.id)}
          <tr><td>{b.name}</td><td>{fmtNum(b.kv, b.kv < 1 ? 2 : 0)}</td><td><b>{kA(b.max.ik3)}</b></td><td>{kA(b.max.ip)}</td><td>{kA(b.max.ib)}</td>
            <td>{b.max.ik1 > 0 ? kA(b.max.ik1) : ''} <span class="cell-sub">{b.max.earth}</span></td><td>{b.max.rx != null ? fmtNum(b.max.rx, 2) : '–'}</td>
            <td>{b.min ? kA(b.min.ik3) : '–'}</td><td>{b.min ? kA(b.min.ik2) : '–'}</td>
            <td>{kA(b.max.src.gen)} / {kA(b.max.src.conv)}{gridOn ? ` / ${kA(b.max.src.grid)}` : ''}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if PR.warn.length}<div class="warnbox mt">{#each PR.warn as w, i}{#if i}<br>{/if}⚠ {w}{/each}</div>{/if}
  <ProtDevices />
</div>
