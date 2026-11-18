<!-- Short circuit and protection: the basis of the study, the fault levels at every bus, the warnings, then the devices -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { fmtNum, fmtPct } from '../../lib/format.js';
  import { hasHelp } from '../../lib/help/index.js';
  import { el, setBasis, protection, design } from '../../lib/equip/electrical.svelte.js';
  import ProtDevices from './ProtDevices.svelte';

  const PR = $derived(protection());
  const E = $derived.by(() => { design(); return W.P.electrical; });
  // E is the same object after every change, so what the page shows of it as a choice is derived on its own
  const earthing = $derived.by(() => { el.rev; design(); return W.P.electrical.mv_earthing; });
  const gridOn = $derived.by(() => { el.rev; design(); return W.P.electrical.grid_mva > 0; });
  // [key, label, unit, step]
  /** @type {[string, string, string, string | number][]} */
  const NUM = [['grid_mva', 'Utility short-circuit power (0 = isolated plant)', 'MVA', 'any'], ['grid_xr', 'Utility X/R ratio', '', 'any'],
    ['scr_min', 'Minimum short-circuit ratio (0 = no check)', '', 0.5], ['dip_max', 'Max dip on energising a transformer (0 = no check)', '%', 0.5],
    ['ubf_vpos', 'Unbalanced fault: grid V+ (0 = no screen)', 'pu', 0.05], ['ubf_vneg', 'Unbalanced fault: grid V−', 'pu', 0.05],
    ['ubf_imax', 'Converter current limit', 'pu', 0.05], ['ubf_kpos', 'Positive-sequence droop gain K+', '', 0.5],
    ['mv_earth_a', 'MV neutral resistor current', 'A', 1], ['grading_s', 'Grading margin', 's', 0.05], ['sc_t_max', 'Clearing time without overcurrent trip', 's', 0.1]];
  const EARTH = [['resistance', 'Resistance earthed (neutral resistor)'], ['solid', 'Solidly earthed'], ['isolated', 'Isolated']];
  const GRID_ONLY = ['grid_xr', 'scr_min', 'dip_max', 'ubf_vpos', 'ubf_vneg', 'ubf_imax', 'ubf_kpos'];
  const GF = [['auto', 'Auto (yes off-grid, no on-grid)'], ['yes', 'Yes, grid-forming'], ['no', 'No, grid-following']];
  const n1On = $derived.by(() => { el.rev; design(); return !!W.P.electrical.n1_check; });
  const pcsGf = $derived.by(() => { el.rev; design(); return W.P.electrical.pcs_grid_forming || 'auto'; });
  // weak-grid screening, the unbalanced fault (with a utility supply only) and the islanded N-1 screen of the design
  const G = $derived((design() || {}).weakGrid);
  const U = $derived((design() || {}).unbalanced);
  const I = $derived((design() || {}).islands);
  const pu = (x) => fmtNum(x, 3);
  const kA = (x) => (x == null ? '–' : fmtNum(x, x < 10 ? 2 : 1));
</script>

<!-- an input's label with its info button when the help has the key -->
{#snippet label(k, l, title = l)}
  <label for="el_{k}">{l}{#if hasHelp('el.' + k)}<button type="button" class="info" data-k="el.{k}" data-title={title} aria-label="About {title}" aria-expanded="false">i</button>{/if}</label>
{/snippet}

<div class="card">
  <h3>Short circuit and protection</h3>
  <p class="hint">Fault levels by the IEC 60909-0 method: the equivalent voltage source c·Un/√3 at the fault (c = 1.10 MV / 1.05 LV for the maximum, 1.00 / 0.95 for the minimum), gensets behind X″d with K<sub>G</sub>, transformers with K<sub>T</sub>, inverters and PCS as current sources at their fault-current multiple. Maximum: all sources, conductors at 20 °C. Minimum: the gensets always online and the battery, no PV, conductors at 80 °C.</p>
  <div class="grid-2">
    <div class="form">
      {#each NUM as [k, l, u, step] (k)}
        {@render label(k, l)}
        <div class="field">
          <input id="el_{k}" type="number" min="0" {step} value={E[k] ?? ''} disabled={(GRID_ONLY.includes(k) && !gridOn) || (k === 'mv_earth_a' && earthing !== 'resistance')}
            onchange={(e) => setBasis(k, e.currentTarget.value === '' ? null : +e.currentTarget.value)}>
          {#if u}<span class="unit">{u}</span>{/if}
        </div>
      {/each}
      {@render label('mv_earthing', 'MV system earthing')}
      <div class="field">
        <select id="el_mv_earthing" value={earthing} onchange={(e) => setBasis('mv_earthing', e.currentTarget.value)}>
          {#each EARTH as [v, l]}<option value={v}>{l}</option>{/each}
        </select>
      </div>
      {@render label('n1_check', 'Islanded N-1 screen')}
      <div class="field"><input id="el_n1_check" type="checkbox" checked={n1On} onchange={(e) => setBasis('n1_check', e.currentTarget.checked)}></div>
      {@render label('pcs_grid_forming', 'Battery PCS forms the grid')}
      <div class="field">
        <select id="el_pcs_grid_forming" value={pcsGf} disabled={!n1On} onchange={(e) => setBasis('pcs_grid_forming', e.currentTarget.value)}>
          {#each GF as [v, l]}<option value={v}>{l}</option>{/each}
        </select>
      </div>
      {@render label('n1_pv_share', 'PV counted as firm in an island (0 to 1)', 'PV counted as firm in an island')}
      <div class="field">
        <input id="el_n1_pv_share" type="number" min="0" max="1" step="0.05" value={E.n1_pv_share ?? ''} disabled={!n1On}
          onchange={(e) => setBasis('n1_pv_share', e.currentTarget.value === '' ? null : +e.currentTarget.value)}>
      </div>
    </div>
    <div>
      {#if PR.notes.length}<p class="hint">{#each PR.notes as n, i}{#if i}<br>{/if}{n}{/each}</p>{/if}
      {#if G}
        <p class="hint">Short-circuit ratio at the MV bus <b>{G.scr != null ? fmtNum(G.scr, 1) : '–'}</b>: {fmtNum(G.ssc)} MVA against {fmtNum(G.pIbr / 1000, 1)} MW of inverters and PCS{G.scrMin > 0 ? ` (limit ${G.scrMin})` : ''}.
          {#if G.dip != null}Energising the largest transformer ({G.trafo}, {fmtNum(G.kva)} kVA, inrush {G.inrush} × rated{G.inrushTyp ? ', typical value' : ''}) dips the MV bus by about <b>{fmtPct(G.dip, 1)}</b>{G.dipMax > 0 ? ` (limit ${G.dipMax} %)` : ''}. A screening estimate: the fundamental of the inrush, half its first peak, drawn through the utility impedance, without its decay, so it errs high.{/if}</p>
      {/if}
      {#if U}
        <p class="hint">Unbalanced fault, grid at V+ {pu(U.vgPos)} and V− {pu(U.vgNeg)} pu, Z = {pu(U.z)} pu on {fmtNum(U.sBase)} kVA of converters: the MV bus holds V+ <b>{pu(U.vPos)}</b> and V− <b>{pu(U.vNeg)}</b> pu, an unbalance of <b>{fmtPct(U.vuf, 1)}</b> ({fmtPct(U.vuf0, 1)} without support).
          {U.cancel ? 'The converters cancel the negative sequence' : 'The current left cannot cancel the negative sequence'}: I+ {pu(U.iPos)} + I− {pu(U.iNeg)} pu within the {U.imax} pu limit{U.short ? `; the droop K+ = ${U.kPos} asks for more than the limit, so the positive sequence takes all of it` : ''}. A steady-state screen on one Thevenin source.</p>
      {/if}
      <p class="hint">Ik″ initial symmetrical, ip peak (κ by method B), Ib breaking current at 0.1 s (genset decay μ), Ik1 line-to-earth. LV buses of a transformer without an earthed star on that side (vector group Dy) are IT systems: a first earth fault draws no fault current.</p>
    </div>
  </div>

  {#if I}
    <h4>Islanded N-1 screen</h4>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Outage</th><th>Islands</th><th>Grid-forming in the load's island</th><th>Firm kW</th><th>Peak load kW</th><th>Shed kW</th><th>Critical shed kW</th></tr></thead>
        <tbody>
          {#each I.rows as r (r.outage)}
            <tr><td>{r.outage}</td><td>{r.islands}{r.other ? ` (other: ${r.other})` : ''}</td><td>{r.sources.length ? r.sources.join(', ') : 'none'}</td><td>{fmtNum(r.firm)}</td><td>{fmtNum(r.load)}</td>
              <td style:color={r.ok || r.own ? null : 'var(--danger)'}>{fmtNum(r.shed)}</td><td style:color={r.critShed > 0 && !r.own ? 'var(--danger)' : null}>{fmtNum(r.critShed)}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="hint">{I.noShed} of {I.outages} outages of a source branch or the utility shed no load{I.worst > 0 && I.rows[I.worst].shed > 0 ? `; the worst is the ${I.rows[I.worst].outage.toLowerCase()}, shedding ${fmtNum(I.rows[I.worst].shed)} kW` : ''}. Firm capacity: {I.onGrid ? `the utility import limit (${fmtNum(I.import)} kW), ` : ''}the gensets, the battery PCS {I.pcsGf ? '(grid-forming)' : '(grid-following: not counted)'} and {fmtPct(I.pvShare, 0)} of the PV, counted only with a grid-forming source in the island. Critical share {fmtPct(I.critShare, 0)}. The load feeder's own outage sheds the load whatever the sources; only a second feeder would keep it. A capacity screen at peak load: no islanded load flow, frequency or battery energy.</p>
  {/if}

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
