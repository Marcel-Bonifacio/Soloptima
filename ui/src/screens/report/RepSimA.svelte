<!-- Energy simulation, first half: strategy, the three cases, the battery's own value, baseline check, energy flow, operating options -->
<script>
  import Tbl from './Tbl.svelte';
  import Fig from './Fig.svelte';
  import { fmtNum, fmtPct, fmtEnergy, fmtMoney } from '../../lib/format.js';
  import { fleetLabel } from '../../lib/fleet-view.js';
  let { D } = $props();
  const { P, SIM, OPTIONS, h, cur, IMG } = D;
  const R = SIM.result, B = SIM.baseline, y = R.years[0], b = B.years[0], V = SIM.pv_only, v = V ? V.years[0] : {}, CB = SIM.comparison_bess;
  const pvLbl = R.size.wind_units > 0 ? 'PV + wind only' : 'PV only', dsl = P.diesel;
  const strategy = { load_following: 'load following', cycle_charging: +dsl.cc_setpoint <= +P.bess.soc_min ? 'cycle charging with the setpoint at or below the minimum SOC, so the gensets never charge the battery (the same as load following)'
    : `cycle charging to ${fmtPct(Math.min(+dsl.cc_setpoint, +P.bess.soc_max), 0)} SOC (the battery runs down to the minimum SOC as in load following, then the running gensets recharge it to the setpoint before it discharges again)`, predictive: 'predictive EMS (forecast-based, dynamic programming)' }[dsl.strategy];
  const r3 = (l, d, p, hy) => (V ? [l, d, p, hy] : [l, d, hy]);
  const auxT = (x) => `${fmtNum((x.aux || 0) / 1000, 1)}${x.aux > 0 ? ` (${fmtPct(x.aux / (x.load - x.aux), 2)} of site load)` : ''}`;
  const cmp = [r3('Fuel (L/yr)', fmtNum(b.fuel_l), fmtNum(v.fuel_l), fmtNum(y.fuel_l)), r3('Diesel energy (MWh/yr)', fmtNum(b.gen_kwh / 1000), fmtNum(v.gen_kwh / 1000), fmtNum(y.gen_kwh / 1000)),
    r3('Genset run-hours', fmtNum(b.unit_hours), fmtNum(v.unit_hours), fmtNum(y.unit_hours)), r3('Genset starts', fmtNum(b.starts), fmtNum(v.starts), fmtNum(y.starts)),
    r3('CO₂ (t/yr)', fmtNum(b.co2_t), fmtNum(v.co2_t), fmtNum(y.co2_t)), r3('PV used (MWh/yr)', '–', fmtNum((v.pv_to_load + v.pv_to_bess) / 1000), fmtNum((y.pv_to_load + y.pv_to_bess) / 1000)),
    r3('PV curtailed (MWh/yr)', '–', fmtNum(v.pv_curtailed / 1000), fmtNum(y.pv_curtailed / 1000)), r3('Battery throughput (MWh/yr)', '–', '–', fmtNum(y.bess_dis / 1000)),
    r3('Auxiliary consumption (MWh/yr)', fmtNum((b.aux || 0) / 1000, 1), auxT(v), auxT(y))].concat(R.has_grid ? [
    r3('Grid import (MWh/yr)', fmtNum(b.grid_import / 1000), fmtNum(v.grid_import / 1000), fmtNum(y.grid_import / 1000)),
    r3('Grid export (MWh/yr)', fmtNum(b.grid_export / 1000), fmtNum(v.grid_export / 1000), fmtNum(y.grid_export / 1000)),
    r3(`Net grid cost (${cur}/yr)`, fmtNum(b.c_grid), fmtNum(v.c_grid), fmtNum(y.c_grid))] : []).concat(V ? [['Net present cost', fmtMoney(B.econ.npc, cur), fmtMoney(V.econ.npc, cur), fmtMoney(R.econ.npc, cur)]] : []);
  const K = h.calibration();
  const EF = h.energyFlow(R), wnd = y.wind_avail > 0, hasB = y.bess_ch > 0 || y.bess_dis > 0;
  const curt = y.pv_curtailed + y.wind_curtailed;
  const S = OPTIONS ? h.optionsSummary() : null, ok = S ? S.rows.filter((x) => !x.err) : [];
  const lbl = (x) => x.label + (x === S.best ? ' (lowest NPC)' : '') + (x.why ? ` (infeasible: ${x.why})` : '');
  const money = (m) => (m === 0 ? cur + ' 0' : fmtMoney(m, cur));
  const G = P.grid, base = R.has_grid ? 'Grid + diesel' : 'Diesel only';
  const gridAvail = !R.has_grid ? '' : G.availability === 'pattern' ? 'up by a daily pattern' : G.availability === 'random'
    ? `with about ${fmtNum(G.outages_per_year)} random outages a year of ${fmtNum(G.outage_hours)} h on average` : 'always up';
</script>

<h2>Energy simulation</h2>
<p>Dispatch strategy: <b>{strategy}</b>; {fleetLabel(dsl)} gensets, minimum loading {[dsl, ...(dsl.more_groups || [])].map((g) => fmtPct(g.min_load, 0)).filter((x, i, a) => a.indexOf(x) === i).join(' / ')}, spinning reserve {fmtPct(dsl.reserve_load, 0)} of load + {fmtPct(dsl.reserve_pv, 0)} of PV and wind.</p>
{#if R.has_grid}
  <p>Grid connection: import up to {fmtNum(G.import_kw)} kW at {G.tariff === 'tou' ? 'a time-of-use tariff' : `${cur} ${fmtNum(G.import_price, 3)}/kWh`}{G.demand_charge > 0 ? ` plus ${cur} ${fmtNum(G.demand_charge, 2)}/kW of each month's highest import` : ''}, export up to {fmtNum(G.export_kw)} kW at {cur} {fmtNum(G.export_price, 3)}/kWh, {gridAvail}. In year 1 the grid is up {fmtNum(y.grid_up_h)} h with {fmtNum(y.grid_outages)} outages; it supplies {fmtEnergy(y.grid_import)} (highest import {fmtNum(y.grid_peak_kw)} kW) and takes {fmtEnergy(y.grid_export)} of PV and wind. While it is up and cheaper than genset energy it serves the load before the gensets, and its spare import counts as spinning reserve. The reference case is the grid with the gensets.</p>
{/if}
<Tbl rows={cmp} head={V ? ['Year 1', base, pvLbl, 'Hybrid'] : ['Year 1', base, 'Hybrid']} />
{#if CB}
  <p>The battery's own value is measured against {pvLbl === 'PV only' ? 'the same PV' : 'the same PV and wind'} without it: it saves {fmtNum(CB.fuel_saved_l_y1)} L of fuel in year 1 and has an NPV of <b>{fmtMoney(CB.npv_savings, cur)}</b>{CB.irr != null ? ` with an IRR of ${fmtPct(CB.irr)}` : ''} on its own capex, O&amp;M, replacements and salvage{CB.npv_savings < 0 ? `. At these inputs the battery does not pay for itself${SIM.comparison.npv_savings > 0 ? ', although the hybrid as a whole does better than diesel only' : ''}` : ''}. The case without a battery keeps the hybrid's PV capacity and curtails {fmtPct(V.curtail_fraction)} of the renewable energy; a design without a battery sized on its own is usually smaller and curtails less, so this comparison tends to overstate the value of the battery.</p>
{/if}
{#if K}
  <h3>Baseline against site records</h3>
  <p>{K.basis} Every result of this report is measured against this diesel-only case.</p>
  {#if K.rows.length}<Tbl head={['Record', 'Site', 'Model', 'Difference']} rows={K.rows.map((x) => [`${x.label} (${x.unit})`, h.calFmt(x.k, x.site), h.calFmt(x.k, x.model), `${h.calPct(x.d)} (${x.flag ? 'beyond' : 'within'} ±${fmtNum(x.tol * 100)} %)`])} />{/if}
  {#if K.monthly}<Fig src={IMG.chCal} cap="Monthly fuel of the site records and of the modelled diesel-only case (year 1)." /><p>{K.monthNote}</p>{/if}
  <ul>{#each K.diag as t}<li>{t}</li>{/each}</ul>
{/if}
<h3>Energy flow</h3>
<p>{EF.direct != null && hasB ? `In year 1, ${fmtPct(EF.direct)} of the ${wnd ? 'PV and wind' : 'PV'} energy used goes straight to the load; the rest is stored first.` : ''}{hasB
  ? ` The battery takes ${fmtEnergy(y.bess_ch)} and returns ${fmtEnergy(y.bess_dis)}; it loses ${fmtEnergy(EF.loss)} ${y.bess_ch > 0 ? `in conversion (${fmtPct(EF.loss / y.bess_ch)} of the energy charged)` : 'in conversion on discharge (nothing was charged)'}${y.self_discharge > 0 ? ` and ${fmtEnergy(y.self_discharge)} to self-discharge` : ''}, and its stored energy changes by ${fmtEnergy(EF.d_e)} over the year.` : ''}
  {[curt > 0 ? `${fmtEnergy(curt)} of renewable energy is curtailed` : 'No renewable energy is curtailed', y.gen_dump > 0 ? `${fmtEnergy(y.gen_dump)} of genset energy at minimum loading is dumped.` : 'no genset energy is dumped.'].join(' and ')}</p>
{#if Math.abs(EF.gap) > 1e-3 * y.load}<div class="warn">Inputs and outputs of the energy flow differ by {fmtEnergy(EF.gap)} ({fmtPct(EF.gap / y.load, 2)} of the load).</div>{/if}
<Fig src={IMG.chFlow} cap={`Energy flow in year 1 (MWh): sources on the left, ${hasB ? 'the battery and the load' : 'the load'}, and where the energy ends.${hasB ? ' Battery losses = charged − discharged − self-discharge − change in stored energy.' : ''}`} />
{#if S}
  <h3>Operating options</h3>
  {#if S.stale}<div class="warn">The inputs changed after this comparison was run. Run Compare options again on the Simulation results page for current figures.</div>{/if}
  <p>Each row simulates the project with one change: diesel only (no PV, battery or wind) as the reference, no battery, then every dispatch strategy with the battery, and the predictive EMS with perfect forecasts as a benchmark for better forecasting (not an option). {S.fast ? 'Year 1 is simulated and repeated over the project life, without PV degradation and load growth. ' : ''}Feasible options meet the sizing constraints (unmet load, loss-of-load and reserve shortfall hours, renewable fraction, curtailment, land and capex limits). {#if S.best}The lowest net present cost among them is <b>{S.best.label}</b> ({fmtMoney(S.best.npc, cur)}).{#if S.near.length} Within 0.5 % of it, which is within model accuracy: {S.near.map((x) => x.label).join('; ')}.{/if}{:else}No option meets the constraints.{/if}</p>
  <Tbl head={['Option (year 1)', 'Fuel kL', 'RE', 'Unit-h', 'Starts', 'Avg genset load', 'EFC', 'Repl.', 'Curtailed', 'Unmet']}
    rows={ok.map((x) => [lbl(x), fmtNum(x.fuel / 1000), fmtPct(x.re), fmtNum(x.uh), fmtNum(x.starts), fmtPct(x.load), fmtNum(x.efc), fmtNum(x.repl), fmtPct(x.curt), fmtPct(x.unmet, 3)])} />
  <Tbl head={['Option', 'Capex', 'NPC', 'LCOE ' + cur + '/kWh', 'NPV vs diesel only', 'IRR', 'Equity IRR', 'NPC change vs row above']}
    rows={ok.map((x) => [lbl(x), money(x.capex), money(x.npc), fmtNum(x.lcoe, 4), money(x.npv), fmtPct(x.irr), fmtPct(x.eqIrr),
      x.dnpc == null ? '–' : `${cur} ${x.dnpc < 0 ? '−' : '+'}${fmtMoney(Math.abs(x.dnpc), '').trim()}${x.close ? ' (within model accuracy)' : ''}`])} />
  {#if S.fall}<Fig src={IMG.chOptFall} cap="Net present cost from diesel only to the hybrid with its best strategy: PV first, then the battery with load following, then the best strategy. The split depends on this order." />{/if}
{/if}
