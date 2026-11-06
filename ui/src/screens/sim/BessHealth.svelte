<!-- Battery health: tiles, state of health and the capacity lost each year -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { hasBattery, bessHealthOf, bessTiles, sohFigure, sohLossFigure } from '../../lib/sim-extra.js';

  // the figures of the last simulation (the engine computes them with the battery inputs of that run)
  const H = $derived.by(() => {
    res.rev;
    if (!data.sim || !hasBattery(data.sim.result)) return null;
    const R = data.sim.result, h = bessHealthOf(R);
    return { R, h, tiles: bessTiles(R, h) };
  });
</script>

{#if H}
  <div class="card" id="bessHealth"><h3>Battery health</h3><Kpis items={H.tiles} />
    <div class="chart-row"><Chart id="chSoh" build={(c) => sohFigure(c, H.R, H.h)} /><Chart id="chSohLoss" build={(c) => sohLossFigure(c, H.R)} /></div>
    <p class="hint">State of health at each year boundary, with the replacement threshold and the replacements (left), and the capacity lost each year to calendar and cycle fade (right). Cycles per year count AC discharge ÷ nameplate energy (check the counting basis of the warranty); the DC value (÷ one-way efficiency) drives the cycle fade. Expected life of a new battery = (100 % − threshold) ÷ year-1 fade.</p></div>
{/if}
