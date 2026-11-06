<!-- Project finance, sizing optimisation, forecasting and energy management -->
<script>
  import Tbl from './Tbl.svelte';
  import Fig from './Fig.svelte';
  import { fmtNum, fmtPct, fmtMoney } from '../../lib/format.js';
  let { D } = $props();
  const { P, SIM, OPT, forecast: FB, cur, IMG } = D;
  const fin = SIM && SIM.finance ? SIM.finance : null;
  const f = P.finance, host = fin && fin.model === 'host', m = fin && fin.metrics;
  const names = { host: 'host-owned (avoided diesel cost as revenue)', ppa: 'single owner selling energy under a PPA', tpo: 'third-party ownership (developer PPA / lease to the host)' };
  const keys = [['revenue', host ? 'Avoided cost' : 'Revenue'], ['opex', 'Operating cost'], ['ebitda', 'EBITDA'], ['tax', 'Income tax'], ['cfads', 'CFADS'], ['debt_service', 'Debt service'], ['dscr', 'DSCR'], ['equity_cf', 'Equity cash flow']];
  const best = OPT && OPT.best;
</script>

{#if fin}
  <h2>Project finance</h2>
  <p>Structure: <b>{names[fin.model]}</b>. Annual after-tax cash flow over {m.term} years, using the simulated energy and costs of each year. Debt {fmtPct(m.debt_fraction, 1)} of total installed cost ({{ min: 'lower of gearing and DSCR sculpting', dscr: 'DSCR sculpting' }[f.sizing] || 'gearing'}), {fmtPct(f.interest)} over {Math.min(+f.tenor, m.term)} years, {{ annuity: 'annuity', equal: 'equal-principal' }[f.repayment] || 'sculpted'} repayment{f.p90_factor < 1 ? `, sized on revenue × ${+f.p90_factor} (P90 ÷ P50${P.resource_years.applied && P.resource_years.applied.p90_factor === f.p90_factor ? ' of revenue from the inter-annual variability run' : ''})` : ''}; income tax {fmtPct(f.tax_rate)}{f.sme_31e ? ' with the Art. 31E reduced rate' : ''}; depreciation {f.dep_method === 'db' ? 'declining balance' : 'straight line'} over {+f.dep_life} years (battery {+f.dep_life_bess}).</p>
  <Tbl head={['Metric', 'Value']} rows={[['Equity IRR (after tax)', fmtPct(m.equity_irr, 2)], ['Project IRR (after tax)', fmtPct(m.project_irr, 2)],
    ['Equity NPV', fmtMoney(m.equity_npv, cur)], ['Project NPV', fmtMoney(m.project_npv, cur)], [host ? 'Avoided cost, year 1' : 'Tariff, year 1', `${cur} ${fmtNum(m.tariff_y1, 4)}/kWh`],
    ...(host ? [] : [['Levelised PPA price (nominal / real)', `${fmtNum(m.lppa_nominal, 4)} / ${fmtNum(m.lppa_real, 4)} ${cur}/kWh`]]),
    ['LCOE, unlevered pre-tax (nominal / real)', `${fmtNum(m.lcoe_nominal, 4)} / ${fmtNum(m.lcoe_real, 4)} ${cur}/kWh`],
    ['Minimum / average DSCR, LLCR', m.dscr_min == null ? 'no debt' : `${fmtNum(m.dscr_min, 2)} / ${fmtNum(m.dscr_avg, 2)}, ${fmtNum(m.llcr, 2)}`],
    ['Total installed cost (incl. IDC, fees, DSRA)', fmtMoney(m.total_installed_cost, cur)], ['Debt / equity', `${fmtMoney(m.debt, cur)} / ${fmtMoney(m.equity, cur)}`],
    ['Equity payback', m.equity_payback == null ? 'not reached' : fmtNum(m.equity_payback, 1) + ' years'],
    ...(host ? [] : [['Host saving vs diesel only', `${fmtPct(m.host_saving_pct, 1)} (NPV ${fmtMoney(m.host_npv_savings, cur)})`]])]} />
  {#if fin.solved && fin.solved.ok}<p>The tariff was solved for a {fmtPct(f.target_irr)} {f.solve_for} IRR.</p>{/if}
  <Fig src={IMG.chFinCash} cap="After-tax cash flow to equity." />
  <Fig src={IMG.chFinCum} cap="Cumulative cash flow." />
  <Fig src={IMG.chFinDscr} cap="Debt service cover ratio by year." />
  <Fig src={IMG.chFinHost} cap={host ? 'Avoided diesel cost vs cost of the new assets.' : 'Host energy cost with and without the plant.'} />
  <h3>Annual cash flow (summary)</h3>
  <Tbl head={['Year', ...keys.map((k) => k[1])]} rows={fin.years.map((y) => [y.year, ...keys.map(([k]) => (y[k] == null ? '' : k === 'dscr' ? fmtNum(y[k], 2) : fmtNum(y[k])))])} />
{/if}
{#if best}
  <h2>Sizing optimisation</h2>
  <p>{fmtNum(OPT.n_evaluated)} configurations were simulated over the full project life ({OPT.settings.algorithm || 'grid search + pattern search'}); {fmtNum(OPT.n_feasible)} met the constraints. Optimum: <b>{fmtNum(best.pv_kwp)} kWp PV, {fmtNum(best.bess_kwh)} kWh / {fmtNum(best.bess_kw)} kW BESS</b>{best.wind_units ? `, ${best.wind_units} wind turbines` : ''} (NPC {fmtMoney(best.npc, cur)}, LCOE {fmtNum(best.lcoe, 4)} {cur}/kWh, RE {fmtPct(best.re)}).</p>
  <Fig src={IMG.chOptHeat} cap="Search-space map." />
  <Fig src={IMG.chPareto} cap="Cost vs renewable fraction." />
  <Fig src={IMG.chSens} cap="Sensitivity of the optimum." />
  <Tbl head={['#', 'PV kWp', 'BESS kWh', 'NPC', 'LCOE', 'RE']} rows={OPT.ranked.slice(0, 10).map((r, i) => [i + 1, fmtNum(r.pv_kwp), fmtNum(r.bess_kwh), fmtMoney(r.npc, cur), fmtNum(r.lcoe, 4), fmtPct(r.re)])} />
{/if}
{#if FB}
  <h2>Forecasting and energy management</h2>
  <p>Every method except "Perfect forecast" and "Perfect + random error" uses only data available before the forecast issue time. Errors are normalised by the mean actual value; skill = 1 − nRMSE / nRMSE of persistence.</p>
  {#each ['pv', 'load'] as v}
    <h3>{v === 'pv' ? 'PV' : 'Load'}</h3>
    <Tbl head={['Method', 'nMAE 1 h', 'nMAE 24 h', 'Skill 24 h']} rows={FB[v].methods.map((mm) => [mm.name, fmtPct(mm.nmae[0]), fmtPct(mm.nmae[23]), mm.skill[23].toFixed(3)])} />
  {/each}
  <Fig src={IMG.chBenchLead} cap="Forecast error vs horizon." />
{/if}
