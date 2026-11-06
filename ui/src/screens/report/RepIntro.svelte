<!-- Cover and executive summary -->
<script>
  import Tbl from './Tbl.svelte';
  import { svgNode } from '../../lib/report/svg-node.js';
  import { fmtNum, fmtPct, fmtEnergy, fmtMoney, fmtOffset } from '../../lib/format.js';
  let { D } = $props();
  const { P, SIM, cur, stale } = D;
</script>

<header class="cover">
  {#if D.logo}<div class="logo" use:svgNode={D.logo}></div>{/if}
  <div class="tag">TECHNO-ECONOMIC ASSESSMENT</div>
  <h1>{P.name || 'Hybrid power plant'}</h1>
  <p class="sub">PV{(SIM ? SIM.result.size.wind_units : P.wind && P.wind.units) > 0 ? ', wind' : ''}, battery storage and diesel generation: energy yield, dispatch, sizing, electrical design and economics</p>
  <table class="meta"><tbody>
    <tr><td>Location</td><td>{(+P.location.lat).toFixed(5)}, {(+P.location.lon).toFixed(5)} ({fmtOffset(P.location.utc_offset)}{P.location.tz ? ', ' + P.location.tz : ''})</td></tr>
    <tr><td>Date</td><td>{D.date}</td></tr>
    <tr><td>Prepared with</td><td>Soloptima (local engine, hourly chronological simulation)</td></tr>
  </tbody></table>
</header>

<h2>Executive summary</h2>
{#if SIM}
  {@const R = SIM.result}{@const C = SIM.comparison}{@const B = SIM.baseline}{@const y = R.years[0]}{@const CB = SIM.comparison_bess}{@const Z = R.size}
  {@const pvW = Z.wind_units > 0 ? 'PV and wind' : 'PV'}
  {#if stale.note}<div class="warn">{stale.note}</div>{/if}
  <p>The plant combines <b>{fmtNum(Z.pv_kwp)} kWp</b> of PV, a <b>{fmtNum(Z.bess_kwh)} kWh / {fmtNum(Z.bess_kw)} kW</b> battery{#if Z.wind_units > 0} and <b>{+Z.wind_units} × {fmtNum(P.wind.rated_kw)} kW</b> wind turbines{/if} with the existing diesel fleet of <b>{+P.diesel.units} × {fmtNum(P.diesel.unit_kw)} kW</b>.
    In year 1 renewables supply <b>{fmtPct(R.re_fraction)}</b> of the {fmtEnergy(y.served)} served. Diesel use falls by <b>{fmtNum(C.fuel_saved_l_y1)} L</b> ({fmtPct(C.fuel_saved_l_y1 / B.fuel_l_y1)}) and CO₂ emissions by {fmtNum(C.co2_saved_t_y1)} t.
    The levelised cost of electricity is <b>{cur} {fmtNum(R.econ.lcoe, 4)}/kWh</b> against {fmtNum(C.lcoe_base, 4)} for diesel only; the additional investment of {fmtMoney(R.econ.capex_total - B.econ.capex_total, cur)} returns an IRR of {fmtPct(C.irr)} with a payback of {C.payback_years == null ? 'more than the project life' : fmtNum(C.payback_years, 1) + ' years'} (NPV of savings {fmtMoney(C.npv_savings, cur)}).{#if CB}
    Against the same {pvW} without a battery, the battery's own NPV is <b>{fmtMoney(CB.npv_savings, cur)}</b>{CB.irr != null ? ` (IRR ${fmtPct(CB.irr)})` : ''}{CB.npv_savings < 0 ? ': at these inputs it does not pay for itself' : ''}.{/if}</p>
  <Tbl head={['Indicator', 'Value']} rows={[['Renewable fraction (yr 1)', fmtPct(R.re_fraction)], ['Fuel saved (yr 1)', fmtNum(C.fuel_saved_l_y1) + ' L'], ['LCOE hybrid / diesel only', `${fmtNum(R.econ.lcoe, 4)} / ${fmtNum(C.lcoe_base, 4)} ${cur}/kWh`],
    ['Net present cost hybrid / diesel only', `${fmtMoney(R.econ.npc, cur)} / ${fmtMoney(B.econ.npc, cur)}`], ['Capex', fmtMoney(R.econ.capex_total, cur)], ['IRR / payback', `${fmtPct(C.irr)} / ${C.payback_years == null ? '–' : fmtNum(C.payback_years, 1) + ' yr'}`],
    ['PV curtailment / unmet load', `${fmtPct(R.curtail_fraction)} / ${fmtPct(R.unmet_fraction, 3)}`]].concat(CB ? [['Battery NPV / IRR vs ' + pvW + ' only', `${fmtMoney(CB.npv_savings, cur)} / ${fmtPct(CB.irr)}`]] : [],
    R.metrics ? [['LPSP / SSSI / SSCI', `${fmtPct(R.metrics.lpsp, 3)} / ${fmtPct(R.metrics.sssi)} / ${fmtPct(R.metrics.ssci)}`]] : [])} />
{:else}
  <p>No simulation results yet.</p>
{/if}
