<!-- Electrical load, PV system and energy yield -->
<script>
  import Tbl from './Tbl.svelte';
  import Fig from './Fig.svelte';
  import Quality from './Quality.svelte';
  import UserFigs from './UserFigs.svelte';
  import RepPvModels from './RepPvModels.svelte';
  import { fmtNum, fmtPct, fmtEnergy, fmtPower } from '../../lib/format.js';
  let { D } = $props();
  const { P, PVR, PVREF, design, h, IMG } = D;
  const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };
  const lkw = P.load.kw, lE = lkw ? sum(lkw) : 0, lPk = lkw ? maxOf(lkw) : 0;
  const eqPv = h.selected('pv'), eqInv = h.selected('inverter');
  const refText = PVREF ? h.pvRefText(PVREF) : [], warn = refText.filter((x) => x.startsWith('⚠')).map((x) => x.replace(/^⚠\s*/, ''));
  const PB = h.pvBalance(), kwp = P.pv.capacity_kwp, dE = kwp >= 1000 ? 0 : kwp >= 100 ? 1 : 2;
  const ST = design && design.str;
</script>

<h2>Electrical load</h2>
{#if lkw}
  <p>Annual energy {fmtEnergy(lE)}, average {fmtPower(lE / h.HOURS)}, peak {fmtPower(lPk)} (load factor {fmtPct(lE / h.HOURS / lPk)}). Source: {P.load.source === 'csv' ? 'measured profile' : 'synthetic profile from daily shape with variability'}{P.load.growth ? `, growth ${fmtPct(P.load.growth)}/yr` : ''}.</p>
  <Fig src={IMG.chLoadDaily} cap="Average daily load profile with min–max range." />
  <Quality {D} kind="load" />
{/if}
<h2>PV system and energy yield</h2>
<Tbl head={['Parameter', 'Value']} rows={[['DC capacity', fmtNum(P.pv.capacity_kwp) + ' kWp'], ['Mounting', P.pv.mount === 'fixed' ? `fixed, tilt ${P.pv.tilt}°` : 'single-axis tracker'], ['GCR', P.pv.gcr], ['DC/AC ratio', P.pv.dc_ac_ratio],
  ['Module', eqPv ? eqPv.name : `${P.pv.module_wp} Wp`], ['Inverter', eqInv ? eqInv.name : '–'],
  ...(PVR ? [['Specific yield', fmtNum(PVR.specific_yield) + ' kWh/kWp·yr'], ['Performance ratio', fmtPct(PVR.performance_ratio)]] : [])]} />
{#if PVR}
  <Fig src={IMG.chPvLoss} cap="PV loss diagram (year 1)." />
  <Fig src={IMG.chPvMonthly} cap="Monthly specific yield." />
{/if}
{#if PVREF}
  <p>{refText.filter((x) => !x.startsWith('⚠')).join(' ')}</p>
  {#if warn.length}<div class="warn">{warn.join(' ')}</div>{/if}
{/if}
{#if PB}
  <h3>Balances and main results</h3>
  <Tbl head={['Month', 'GlobHor kWh/m²', 'DiffHor kWh/m²', 'T_amb °C', 'GlobInc kWh/m²', 'GlobEff kWh/m²', 'EArray MWh', 'E_avail MWh', 'PR']}
    rows={PB.rows.map((x) => [x.label, fmtNum(x.ghi, 1), fmtNum(x.dhi, 1), fmtNum(x.tamb, 1), fmtNum(x.poa, 1), fmtNum(x.eff, 1), fmtNum(x.earray * kwp / 1000, dE), fmtNum(x.eavail * kwp / 1000, dE), fmtPct(x.pr)])} />
  <p>GlobInc is the irradiation on the module plane before shading and GlobEff after row shading, reflection (IAM) and soiling. EArray is the DC energy of the array, E_avail the energy available after the inverter, clipping, AC losses and availability, and PR = E_avail ÷ (GlobInc × kWp ÷ 1 kW/m²).
    In the normalised production the reference yield Yr (GlobInc per day) splits into the final yield Yf, the system losses Ls and the array capture losses Lc{PB.sim ? '; Lu is the PV energy curtailed in the simulation because neither the load nor the battery could take it, and the delivered PR counts only the PV energy used' : ''}.</p>
  <Fig src={IMG.chPvNorm} cap={`Normalised production per kWp and day (Yf, ${PB.sim ? 'Lu, ' : ''}Ls, Lc) and performance ratio by month.`} />
{/if}
{#if ST}
  {@const m = ST.pv}{@const iv = ST.inv}{@const area = m.length && m.width ? ST.nModules * m.length * m.width : null}
  <h3>Array characteristics</h3>
  <Tbl head={['Item', 'Value']} rows={[['Modules', `${fmtNum(ST.nModules)} × ${fmtNum(m.pmax)} Wp: ${m.name}`], ['Strings × modules in series', `${fmtNum(ST.nStrings)} × ${ST.ns}`],
    ['DC capacity (built)', fmtNum(ST.kwp, 1) + ' kWp'], ['Inverters', `${fmtNum(ST.nInv)} × ${fmtNum(iv.pac_kw)} kW: ${iv.name}; DC/AC ${ST.dcac.toFixed(3)}`],
    ['MPPT', `${iv.n_mppt} per inverter, window ${iv.vmppt_min}–${iv.vmppt_max} V; ${fmtNum(ST.spi, 1)} strings per inverter, up to ${ST.spm} per MPPT`],
    ['Vmp at max cell temperature', `${fmtNum(ST.vmpHot)} V at ${ST.tHot} °C`],
    ['Voc at site minimum', `${fmtNum(ST.vocMax)} V at ${design.tmin} °C (limit ${fmtNum(Math.min(iv.vdc_max, m.vsys || iv.vdc_max))} V)`],
    ['Module area', area == null ? '–' : fmtNum(area) + ' m²']]} />
{/if}
<RepPvModels {D} />
<UserFigs {D} place="pv" />
