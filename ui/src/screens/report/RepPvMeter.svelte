<!-- Metered PV output against the yield model, when the project has a meter and its comparison is up to date -->
<script>
  import Tbl from './Tbl.svelte';
  import Fig from './Fig.svelte';
  import { statRows, STAT_HEADS, monthRows, MONTH_HEADS, fitView, meterLine } from '../../lib/pvmeter-view.js';
  let { D } = $props();
  const R = $derived(D.h.pvMeter()), F = $derived(R ? fitView(R) : null), M = $derived(D.P.pv_meter), A = $derived(M && M.applied);
</script>

{#if R}
  <h3>Measured output against the model</h3>
  <p>{meterLine(M)} The metered AC output is compared with the modelled output in the hours present in both, in local standard time. MBE and RMSE are model − meter, as a share of the mean metered output; R² = 1 − Σ(model − meter)² ÷ Σ(meter − mean)². Running hours leave out the probable outages; the fitted columns use the soiling and availability that bring the model closest to the meter: soiling by least squares over the running hours (0 to 30 %), availability from the energy the model gives in the outage hours.</p>
  <Fig src={D.IMG.chPvMeter} cap="Monthly PV output on the hours compared: meter, model and the model with the fitted soiling and availability." />
  <Tbl head={STAT_HEADS} rows={statRows(R)} />
  <p>{F.lines.join(' ')}{A ? ` The fitted ${A.mode === 'monthly' ? 'monthly soiling' : 'soiling'} and availability were applied to the PV inputs of this project.` : ''}</p>
  {#if R.notes.length}<div class="warn">{R.notes.join(' ')}</div>{/if}
  <Tbl head={MONTH_HEADS} rows={monthRows(R)} />
{/if}
