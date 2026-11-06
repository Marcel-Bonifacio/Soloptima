<!-- Tariff components of the Revenue card: the table, or the note that replaces it for host-owned and diesel-discount tariffs -->
<script>
  import { forms } from '../../lib/state.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { fin, editComp, addComp, delComp } from '../../lib/finance.svelte.js';
  import { revenueMode, pctText } from '../../lib/finance-view.js';

  const F = $derived.by(() => { forms.rev; fin.rev; return W.P && W.P.finance; });
  const mode = $derived(F ? revenueMode(F) : 'host');
  const st2 = $derived(!!F && F.stage2_year > 0);
  const cur = $derived.by(() => { forms.rev; return W.P ? W.P.econ.currency : ''; });
  const edit = (i, f) => (e) => editComp(i, f, e.currentTarget.value);
</script>

<div id="finComps">
  {#if F && mode === 'host'}
    <p class="hint">Revenue of a host-owned plant is the avoided diesel cost: fuel, genset O&amp;M and carbon cost of the diesel-only case minus what remains with the hybrid, taken year by year from the simulation.</p>
  {:else if F && mode === 'discount'}
    <p class="hint">Tariff each year = (1 − discount) × the diesel-only fuel + genset O&amp;M cost per kWh, so it follows the fuel price escalation.</p>
  {:else if F}
    <table class="data comp-table" style="margin-top:12px">
      <thead><tr><th>Component</th><th>Stage 1 {cur}/kWh</th>{#if st2}<th>Stage 2</th>{/if}<th>Index %/yr</th><th>% of fixed</th><th></th></tr></thead>
      <tbody>{#each F.components as c, i (c)}
        <tr>
          <td><input class="name" aria-label="Component name" value={c.name} onchange={edit(i, 'name')}></td>
          <td><input type="number" step="0.0001" aria-label="Stage 1 tariff" value={+c.v1} disabled={c.pct > 0} onchange={edit(i, 'v1')}></td>
          {#if st2}<td><input type="number" step="0.0001" aria-label="Stage 2 tariff" value={+c.v2} disabled={c.pct > 0} onchange={edit(i, 'v2')}></td>{/if}
          <td><input type="number" step="0.1" aria-label="Index" value={pctText(c.idx)} onchange={edit(i, 'idx')}></td>
          <td><input type="number" step="1" aria-label="Percent of fixed" value={pctText(c.pct)} onchange={edit(i, 'pct')}></td>
          <td><button type="button" class="btn ghost small" title="Remove" aria-label="Remove component" onclick={() => delComp(i)}>✕</button></td>
        </tr>
      {/each}</tbody>
    </table>
    <div class="row gap"><button type="button" class="btn small" id="compAdd" onclick={addComp}>+ Component</button>
      <span class="hint inline" style="margin:0">"% of fixed" makes an adder on the sum of the fixed components, e.g. PLN component F = 60 % × (A + B).</span></div>
  {/if}
</div>
