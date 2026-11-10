<!-- The Simulation results page (tab-sim) -->
<script>
  import { untrack } from 'svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { res } from '../../lib/results.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { checkStale, checkStaleLater, hasSim } from '../../lib/sim.svelte.js';
  import SimBar from '../results/SimBar.svelte';
  import Stale from '../results/Stale.svelte';
  import SimKpis from '../results/SimKpis.svelte';
  import SimMetrics from '../results/SimMetrics.svelte';
  import SimMix from '../results/SimMix.svelte';
  import SimMonthly from '../results/SimMonthly.svelte';
  import SimDispatch from '../results/SimDispatch.svelte';
  import SimCash from '../results/SimCash.svelte';
  import SimYears from '../results/SimYears.svelte';
  import WhatIf from './WhatIf.svelte';
  import Calibration from './Calibration.svelte';
  import EnergyFlow from './EnergyFlow.svelte';
  import GenCharts from './GenCharts.svelte';
  import SimGroups from '../results/SimGroups.svelte';
  import BessHealth from './BessHealth.svelte';
  import OptionsCard from './OptionsCard.svelte';
  import TornadoCard from './TornadoCard.svelte';

  // the box was checked from the start; the parent's onFieldChange reads it
  ws.live = true;

  // The stale banners of this page and of Project finance follow every edit. The check stringifies the project, so it runs 300 ms
  // after the last edit, and at once when the page opens or a run ends.
  let lastTab = null, lastRev = -1;
  $effect(() => {
    forms.rev; const rev = res.rev, tab = ws.tab;
    if (tab !== 'sim' && tab !== 'fin') { lastTab = tab; return; }
    const now = tab !== lastTab || rev !== lastRev;
    lastTab = tab; lastRev = rev;
    untrack(() => (now ? checkStale() : checkStaleLater()));
  });
</script>

<section id="tab-sim" class="tab" class:active={ws.tab === 'sim'}>
  <h1>Simulation results</h1>
  <SimBar />
  <WhatIf />
  {#if !hasSim()}
    <div id="simEmpty" class="empty">Run a simulation to see results.</div>
  {:else}
    <div id="simBody">
      <Stale />
      <SimKpis />
      <Calibration />
      <SimMetrics />
      <SimMix />
      <EnergyFlow />
      <OptionsCard />
      <SimMonthly />
      <SimDispatch />
      <GenCharts />
      <SimGroups />
      <BessHealth />
      <SimCash />
      <TornadoCard />
      <SimYears />
    </div>
  {/if}
</section>
