<!-- Reliability, self-sufficiency, environment and social indicators -->
<script>
  import { W } from '../../lib/ws/state.js';
  import Kpis from '../../lib/Kpis.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { indicatorTiles } from '../../lib/sim-view.js';

  const tiles = $derived.by(() => { res.rev; forms.rev; const P = W.P; return data.sim ? indicatorTiles(data.sim, P, P.econ.currency) : []; });
</script>

<div class="card"><h3>Reliability, self-sufficiency, environment &amp; social indicators</h3>
  <Kpis items={tiles} />
  <details class="defs"><summary>How these indicators are defined</summary>
    <dl>
      <dt>LPSP</dt><dd>Unmet energy ÷ load.</dd>
      <dt>REP</dt><dd>100 × (1 − LPSP).</dd>
      <dt>SSCI</dt><dd>Σmin(load, RE) ÷ ΣRE: the share of PV and wind used directly.</dd>
      <dt>SSSI</dt><dd>Σmin(load, RE) ÷ Σload: the share of the load met directly by PV and wind.</dd>
      <dt>HDI</dt><dd>From electricity per person: 0.0978 ln(E/person) − 0.0319.</dd>
      <dt>TAC</dt><dd>NPC × CRF.</dd>
      <dt>COE</dt><dd>TAC ÷ energy served to the site (auxiliary consumption excluded, as in the LCOE).</dd>
      <dt>Loss of load</dt><dd>Hours with more than 0.1 % of the load unserved. An event is a run of such hours.</dd>
      <dt>Reserve shortfall</dt><dd>Hours in which the genset headroom and the battery reserve left after dispatch do not cover the spinning-reserve rule. Normally zero with enough units for the peak load and its reserve; it matters for questions such as one unit fewer for maintenance, a few large units or load growth.</dd>
      <dt>Low-load running</dt><dd>Hours with every online genset at minimum loading (wet-stacking risk).</dd>
    </dl>
  </details>
</div>
