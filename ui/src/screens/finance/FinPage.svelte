<!-- Project finance page: ownership structure, presets, the term forms, the run button and the results -->
<script>
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import Stale from '../results/Stale.svelte';
  import FinResults from '../results/FinResults.svelte';
  import FinComps from './FinComps.svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { fin, setModel, applyPreset, runFin } from '../../lib/finance.svelte.js';
  import { res } from '../../lib/results.svelte.js';
  import { MODELS, PRESET_LIST, p90Note } from '../../lib/finance-view.js';

  const model = $derived.by(() => { forms.rev; fin.rev; return W.P && W.P.finance.model; });
  const note = $derived.by(() => { forms.rev; fin.rev; res.rev; return W.P ? p90Note(W.P) : ''; });
</script>

<section id="tab-fin" class="tab" class:active={ws.tab === 'fin'}>
  <h1>Project finance</h1>
  <p class="lead">An annual after-tax cash-flow model, driven by the simulated energy and costs of every project year. Pick the ownership structure, then the revenue, debt and tax terms.</p>
  <div class="model-cards" id="finModels">
    {#each MODELS as [v, title, text] (v)}
      <button type="button" class="model-card" class:on={model === v} data-v={v} onclick={() => setModel(v)}><b>{title}</b><span>{text}</span></button>
    {/each}
  </div>
  <div class="row gap"><span class="hint inline" style="margin:0">Presets</span>
    {#each PRESET_LIST as [id, label] (id)}<button type="button" class="btn small" data-fpreset={id} onclick={() => applyPreset(id, label)}>{label}</button>{/each}</div>
  <div class="grid-3">
    <div class="card"><h3>Timeline &amp; capital cost</h3><div class="form"><SchemaForm name="fin-cap" /></div></div>
    <div class="card"><h3>Revenue</h3><div class="form"><SchemaForm name="fin-rev" /></div>
      <FinComps /></div>
    <div class="card"><h3>Debt</h3><div class="form"><SchemaForm name="fin-debt" /></div>{#if note}<p id="finP90Src" class="hint">{note}</p>{/if}</div>
  </div>
  <div class="grid-2">
    <div class="card"><h3>Tax &amp; depreciation</h3><div class="form"><SchemaForm name="fin-tax" /></div></div>
    <div class="card"><h3>Operating costs, working capital &amp; end of term</h3><div class="form"><SchemaForm name="fin-op" /></div></div>
  </div>
  <div class="grid-2">
    <div class="card"><h3>Currency</h3><div class="form"><SchemaForm name="fin-fx" /></div></div>
    {#if model === 'flip'}<div class="card" id="finFlip"><h3>Tax equity partnership</h3><div class="form"><SchemaForm name="fin-flip" /></div></div>{/if}
  </div>
  <div class="row gap"><button type="button" id="btnFin" class="btn primary" onclick={runFin}>Run financial analysis</button></div>
  <Stale />
  <FinResults />
</section>
