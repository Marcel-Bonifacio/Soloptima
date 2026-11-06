<!-- Balances and main results of the PV page: monthly table and the normalised production chart (the report takes its picture of chPvNorm) -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import DataTable from '../../lib/DataTable.svelte';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { res } from '../../lib/results.svelte.js';
  import { pv } from '../../lib/pv.svelte.js';
  import { pvBalance, balanceRows, balanceFig, BAL_HEADS, BAL_NOTE_STALE } from '../../lib/pv-view.js';

  const B = $derived.by(() => { forms.rev; pv.rev; res.rev; return W.P ? pvBalance(W.PVR, W.SIM, W.P.pv.capacity_kwp) : null; });
  const rows = $derived(B ? balanceRows(B, W.P.pv.capacity_kwp) : []);
</script>

<div class="card" id="pvBalCard" hidden={!B}><h3>Balances and main results</h3>
  <div id="pvBalTable"><DataTable heads={BAL_HEADS} {rows} /></div>
  <Chart id="chPvNorm" build={(c) => (B ? balanceFig(B, c) : null)} />
  <p class="hint">GlobHor and DiffHor: global and diffuse horizontal irradiation. GlobInc: irradiation on the module plane before shading; GlobEff: after row shading, reflection (IAM) and soiling. EArray: DC energy of the array after mismatch, wiring, LID and quality; E_avail: energy available after the inverter, clipping, AC losses and availability. PR = E_avail ÷ (GlobInc × kWp ÷ 1 kW/m²).
    Normalised production per kWp and day: the reference yield Yr (GlobInc) splits into the final yield Yf (E_avail), the system losses Ls (EArray − E_avail) and the array capture losses Lc (GlobInc − EArray). After a simulation, Lu is the PV energy curtailed because neither the load nor the battery could take it, and PR delivered counts only the PV energy used.</p>
  <p id="pvBalNote" class="hint">{B && B.stale ? BAL_NOTE_STALE : ''}</p>
</div>
