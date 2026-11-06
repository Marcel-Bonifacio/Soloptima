<!-- Economics: capex, cash flow, what drives the result (tornado) and the year-by-year table -->
<script>
  import Tbl from './Tbl.svelte';
  import Fig from './Fig.svelte';
  import { fmtNum, fmtPct, fmtMoney } from '../../lib/format.js';
  let { D } = $props();
  const { P, SIM, TORNADO, h, cur, IMG } = D;
  const R = SIM.result;
  const S = TORNADO ? h.tornadoSummary(P.tornado.metric) : null, ok = S ? S.rows.filter((x) => !x.err) : [], top = ok[0];
  const f = (v) => (S ? h.tornadoFmt(S.metric, v) : '');
</script>

<h2>Economics</h2>
<Tbl head={['Capex', 'Amount']} rows={[['PV', fmtMoney(R.econ.capex_pv, cur)], ['Battery', fmtMoney(R.econ.capex_bess, cur)], ['Wind', fmtMoney(R.econ.capex_wind || 0, cur)], ['Gensets', fmtMoney(R.econ.capex_diesel, cur)], ['Development / EPC', fmtMoney(R.econ.capex_other, cur)], ['Total', fmtMoney(R.econ.capex_total, cur)]]} />
<Fig src={IMG.chCash} cap="Lifetime cash flow (nominal)." />
{#if S}
  <h3>What drives the result</h3>
  {#if S.stale}<div class="warn">The inputs changed after this tornado was run. Run it again on the Simulation results page for current figures.</div>{/if}
  <p>The design above was simulated again with one input at a time set to a low and a high value, everything else unchanged{S.fast ? ' (year 1 simulated and repeated over the project life, so PV degradation and load growth are left out)' : ''}{S.together ? '; the battery energy capex moves the power capex and the replacement price with it' : ''}.
    The base {S.name} is {f(S.base)}.{top && top.swing > 0 ? ` ${top.label} moves it the most: ${f(top.vLo)} at ${top.vals[0]} and ${f(top.vHi)} at ${top.vals[1]}.` : ''}
    Cycle life and calendar fade move the battery replacement year in whole-year steps, so their bars can be lumpy and asymmetric.</p>
  <Fig src={IMG.chTornado} cap={`${S.name}: change from the base value at the low and the high value of each input, largest swing on top.`} />
  <Tbl head={['Input', 'Low value', 'High value', S.name + ' at low', S.name + ' at high', 'Swing']}
    rows={S.rows.map((x) => [x.label, x.vals[0], x.vals[1]].concat(x.err ? [x.err, '', ''] : [h.tornadoFmt(S.metric, x.vLo), h.tornadoFmt(S.metric, x.vHi), S.base == null || (x.vLo == null && x.vHi == null) ? '–' : h.tornadoSwing(S.metric, x.swing)]))} />
{/if}
<h3>Year-by-year</h3>
<Tbl head={['Year', 'Load MWh', 'Fuel kL', 'RE', 'BESS SOH', 'EFC', 'Repl.', 'Cost ' + cur]}
  rows={R.years.map((x) => [x.year, fmtNum(x.load / 1000), fmtNum(x.fuel_l / 1000), fmtPct(x.re_fraction), fmtNum(x.bess_soh * 100, 1) + ' %', fmtNum(x.bess_efc), x.bess_replaced ? 'yes' : '', fmtNum(x.c_total)])} />
