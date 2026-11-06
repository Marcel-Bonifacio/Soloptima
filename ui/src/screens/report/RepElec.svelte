<!-- Equipment schedule and electrical design (strings, transformers, cables, single-line diagram) -->
<script>
  import Tbl from './Tbl.svelte';
  import UserFigs from './UserFigs.svelte';
  import { svgNode } from '../../lib/report/svg-node.js';
  import { fmtNum, fmtPct, fmtSig } from '../../lib/format.js';
  let { D } = $props();
  const { h, design: Dn, sld } = D;
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
  <h3>Cable schedule</h3>
  <Tbl head={['Circuit', 'No.', 'Cable', 'Runs', 'Length m', 'I A', 'Rating A', 'ΔV', 'Loss MWh/yr']}
    rows={Dn.circuits.map((c) => [c.name, c.count, c.cab ? c.cab.name : '–', c.runs, fmtNum(c.L), fmtNum(c.I), c.amp ? fmtNum(c.amp) : '–', c.dv != null ? (c.dv * 100).toFixed(2) + ' %' : '–', c.annual != null ? fmtNum(c.annual / 1000, 1) : '–'])} />
  {#if Dn.warn.length}<div class="warn">{#each Dn.warn as w, i}{#if i}<br>{/if}{w}{/each}</div>{/if}
  {#if sld}<figure class="sld"><div use:svgNode={sld}></div><figcaption>Single-line diagram.</figcaption></figure>{/if}
  <UserFigs {D} place="electrical" />
{/if}
