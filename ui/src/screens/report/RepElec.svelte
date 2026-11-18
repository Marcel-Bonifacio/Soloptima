<!-- Equipment schedule and electrical design (strings, transformers, cables, fault levels and protection, single-line diagram) -->
<script>
  import { devicesOf } from '../../lib/equip/protection.js';
  import Tbl from './Tbl.svelte';
  import UserFigs from './UserFigs.svelte';
  import { svgNode } from '../../lib/report/svg-node.js';
  import { fmtNum, fmtPct, fmtSig } from '../../lib/format.js';
  let { D } = $props();
  const { h, design: Dn, sld, prot: PR, tcc } = D;
  const kA = (x) => (x == null ? '–' : fmtNum(x, x < 10 ? 2 : 1));
  const sec = (t) => (isFinite(t) ? fmtNum(t, 2) + ' s' : 'no trip');
  const kinds = [['pv', 'PV module'], ['inverter', 'PV inverter'], ['battery', 'Battery system'], ['genset', 'Diesel generator']]
    .map(([t, label]) => ({ label, e: h.selected(t), t })).filter((x) => x.e)
    .map(({ label, e, t }) => ({ label, e, fields: h.eqTypes[t].fields.filter(([k]) => k !== 'name' && e[k] != null && e[k] !== '') }));
</script>

<h2>Equipment schedule</h2>
{#each kinds as k}
  <h3>{k.label}: {k.e.name}</h3>
  <Tbl rows={k.fields.map(([key, l, , u]) => [l, `${typeof k.e[key] === 'number' ? fmtSig(k.e[key]) : k.e[key]} ${u || ''}`])} />
{/each}
{#if Dn}
  <h2>Electrical design</h2>
  {#if Dn.str}
    {@const s = Dn.str}
    <p>Strings of <b>{s.ns}</b> modules (allowed {s.nMin}–{Math.min(s.nMax, s.nMppt)}; Voc at {+Dn.tmin} °C = {fmtNum(s.vocMax)} V). {fmtNum(s.nStrings)} strings on {fmtNum(s.nInv)} inverters, DC/AC {s.dcac.toFixed(3)}, {fmtNum(s.kwp, 1)} kWp built.</p>
    <p>Vmp at {+s.tHot} °C cell temperature = {fmtNum(s.vmpHot)} V and at {+Dn.tmin} °C = {fmtNum(s.vmpCold)} V, against the MPPT window {s.inv.vmppt_min}–{s.inv.vmppt_max} V. Vmp temperature coefficient {fmtNum(s.bVmp, 3)} %/°C ({s.bVmpSrc}){s.tModel != null ? `; the thermal model's 99.9th percentile cell temperature is ${fmtNum(s.tModel, 1)} °C` : ''}.</p>
  {/if}
  <h3>Transformers</h3>
  <Tbl head={['Role', 'Units', 'Type', 'Rating', 'Peak loading', 'Losses MWh/yr']} rows={Dn.trafos.map((t) => [t.role, t.n, t.t.name, fmtNum(t.t.kva) + ' kVA', fmtPct(t.loading, 0), t.annual_kwh != null ? fmtNum(t.annual_kwh / 1000, 1) : '–'])} />
  {#if Dn.reactive}
    {@const R = Dn.reactive}
    <h3>Reactive capability</h3>
    <p>At power factor {R.pf} at the point of connection the inverters and PCS must carry S ≥ √(P² + Q²) with Q = {fmtNum(R.tan, 4)} × P at rated active power (IEEE 2800 asks at least 0.3287 × P). Losses between the units and the connection are not included.</p>
    <Tbl head={['Units', 'Installed', 'Rated P kW', 'S needed kVA', 'Q at rated P kvar', 'Margin', 'Units needed']}
      rows={[['PV inverters', R.pv], ['Battery PCS', R.bess]].filter(([, x]) => x).map(([l, x]) => [l, `${fmtNum(x.units)} × ${fmtNum(x.kva)} kVA`, fmtNum(x.p), fmtNum(x.sReq), fmtNum(x.q), fmtPct(x.margin, 1), fmtNum(x.nReq)])} />
  {/if}
  {#if Dn.weakGrid}
    {@const G = Dn.weakGrid}
    <h3>Grid strength</h3>
    <p>Short-circuit ratio at the MV bus {G.scr != null ? fmtNum(G.scr, 1) : '–'}: {fmtNum(G.ssc)} MVA utility short-circuit power against {fmtNum(G.pIbr / 1000, 1)} MW of inverters and PCS{G.scrMin > 0 ? ` (limit ${G.scrMin})` : ''}.{#if G.dip != null} Energising the largest transformer ({G.trafo}, {fmtNum(G.kva)} kVA, inrush {G.inrush} × rated{G.inrushTyp ? ', typical value' : ''}) dips the MV bus by about {fmtPct(G.dip, 1)}{G.dipMax > 0 ? ` (limit ${G.dipMax} %)` : ''}. This is a screening estimate that errs high; a value near the limit needs a switching study.{/if}</p>
    {#if Dn.unbalanced}
      {@const U = Dn.unbalanced}
      <p>Unbalanced fault at the MV bus, with the utility at {fmtNum(U.vgPos, 2)} pu positive and {fmtNum(U.vgNeg, 2)} pu negative sequence behind {fmtNum(U.z, 3)} pu (on {fmtNum(U.sBase)} kVA of converters): the converters hold the droop K+ = {U.kPos} and give the current left of their {U.imax} pu limit to the negative sequence. The bus then holds {fmtNum(U.vPos, 3)} pu and {fmtNum(U.vNeg, 3)} pu, an unbalance factor of {fmtPct(U.vuf, 1)} against {fmtPct(U.vuf0, 1)} without support; the negative sequence is {U.cancel ? '' : 'not '}cancelled (I+ {fmtNum(U.iPos, 3)} pu, I− {fmtNum(U.iNeg, 3)} pu).</p>
    {/if}
  {/if}
  {#if Dn.islands}
    {@const I = Dn.islands}
    <h3>Islanded N-1 screen</h3>
    <p>Each single branch outage, and the island that keeps the load: its grid-forming sources, firm capacity ({I.onGrid ? `the utility import limit, ` : ''}gensets, the battery PCS {I.pcsGf ? 'as grid-forming' : 'not counted, as grid-following'}, {fmtPct(I.pvShare, 0)} of the PV) and the load shed at the peak, with a critical share of {fmtPct(I.critShare, 0)}. {I.noShed} of {I.outages} outages of a source branch or the utility shed no load. The load feeder's own outage sheds the load whatever the sources. A capacity screen: no islanded load flow.</p>
    <Tbl head={['Outage', 'Islands', 'Grid-forming', 'Firm kW', 'Peak load kW', 'Shed kW', 'Critical shed kW']}
      rows={I.rows.map((r) => [r.outage, r.islands, r.sources.length ? r.sources.join(', ') : 'none', fmtNum(r.firm), fmtNum(r.load), fmtNum(r.shed), fmtNum(r.critShed)])} />
  {/if}
  <h3>Cable schedule</h3>
  <Tbl head={['Circuit', 'No.', 'Cable', 'Runs', 'Length m', 'I A', 'Rating A', 'ΔV', 'Loss MWh/yr']}
    rows={Dn.circuits.map((c) => [c.name, c.count, c.cab ? c.cab.name : '–', c.runs, fmtNum(c.L), fmtNum(c.I), c.amp ? fmtNum(c.amp) : '–', c.dv != null ? (c.dv * 100).toFixed(2) + ' %' : '–', c.annual != null ? fmtNum(c.annual / 1000, 1) : '–'])} />
  {#if Dn.warn.length}<div class="warn">{#each Dn.warn as w, i}{#if i}<br>{/if}{w}{/each}</div>{/if}
  {#if PR}
    <h3>Fault levels</h3>
    <p>Short-circuit currents by the IEC 60909-0 method (equivalent voltage source c·Un/√3 at the fault; c = 1.10 MV / 1.05 LV for the maximum, 1.00 / 0.95 for the minimum). Maximum: every source online; minimum: {PR.F.online} genset(s) and the battery, without PV. Inverters and PCS contribute their limited fault current.</p>
    <Tbl head={['Bus', 'kV', 'Ik″ max kA', 'ip kA', 'Ib kA', 'Ik1 kA', 'Ik″ min kA']}
      rows={PR.F.buses.map((b) => [b.name, fmtNum(b.kv, b.kv < 1 ? 2 : 0), kA(b.max.ik3), kA(b.max.ip), kA(b.max.ib), b.max.ik1 > 0 ? kA(b.max.ik1) : b.max.earth, b.min ? kA(b.min.ik3) : '–'])} />
    <h3>Protection settings</h3>
    <Tbl head={['Device', 'V', 'Breaker', 'Curve', 'Pickup A', 'TMS', 'I>> A', 'Breaker duty']}
      rows={devicesOf(PR).map((d) => [d.name, fmtNum(d.kv * 1000), d.brk ? d.brk.name : '–', d.set.curve, fmtNum(d.set.pickup), d.set.tms, d.set.inst ? fmtNum(d.set.inst) : '–', d.chk && d.chk.length ? 'not met' : 'met'])} />
    <Tbl head={['Grading case', 'Downstream', 't', 'Upstream', 't', 'Margin']}
      rows={PR.grading.map((r) => [r.label, PR.dev[r.down].name, sec(r.td), PR.dev[r.up].name, sec(r.tu), r.margin != null ? fmtNum(r.margin, 2) + ' s' + (r.ok ? '' : ' (short)') : isFinite(r.td) ? 'upstream does not trip' : isFinite(r.tu) ? 'upstream trips first' : 'not cleared'])} />
    <Tbl head={['Cable circuit', 'Ith kA', 'Clearing', 'Withstand kA']} rows={PR.cables.map((c) => [c.name, kA(c.ith), sec(c.t), fmtNum(c.adm, 1) + (c.ok ? '' : ' (too small)')])} />
    {#if PR.warn.length}<div class="warn">{#each PR.warn as w, i}{#if i}<br>{/if}{w}{/each}</div>{/if}
    {#if tcc}<figure class="sld"><div use:svgNode={tcc}></div><figcaption>Time-current coordination (IEC 60255-151 inverse-time curves, currents referred to {D.P.electrical.mv_kv} kV), grading margin {PR.margin} s.</figcaption></figure>{/if}
  {/if}
  {#if sld}<figure class="sld"><div use:svgNode={sld}></div><figcaption>Single-line diagram.</figcaption></figure>{/if}
  <UserFigs {D} place="electrical" />
{/if}
