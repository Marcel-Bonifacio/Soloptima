<!-- Design basis of the electrical design: voltages, temperatures, transformers, derating and voltage-drop limits -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { hasHelp } from '../../lib/help/index.js';
  import { forms } from '../../lib/state.svelte.js';
  import { el, setBasis, design } from '../../lib/equip/electrical.svelte.js';
  import { eq } from '../../lib/equip/equipment.svelte.js';

  const E = $derived.by(() => { forms.rev; el.rev; eq.rev; return W.P.electrical; });
  const trafos = $derived.by(() => { eq.rev; return W.P.equipment.lib.transformer; });
  const measured = $derived(design().circuits.filter((c) => c.fromLayout).map((c) => c.name));
  // E is the same object after every change, so what the page shows of it as a yes or no is derived on its own
  const fromLayout = $derived.by(() => { forms.rev; el.rev; return !!W.P.electrical.len_from_layout; });
  // [key, label, unit, step, placeholder]
  const NUM = {
    mv_kv: ['MV collector voltage', 'kV'], t_min: ['Site minimum temperature', '°C', 'any', 'from weather data'], t_cell_max: ['Max cell temperature', '°C'],
    modules_per_string: ['Modules per string (0 = auto)', '', 1], pv_per_feeder: ['PV transformers per MV feeder', '', 1], gens_per_trafo: ['Gensets per transformer', '', 1],
    pf_load: ['Load power factor', ''], derate: ['Cable derating factor', ''], dv_dc: ['Max voltage drop DC', '%'], dv_lv: ['Max voltage drop LV', '%'], dv_mv: ['Max voltage drop MV', '%'],
    route_factor: ['Route factor (cable ÷ straight line)', '', 0.05, '1.25'],
  };
  const TR = { trafo_pv: 'PV transformer', trafo_bess: 'BESS transformer', trafo_gen: 'Genset transformer', trafo_load: 'Load transformer' };
  const BOOL = { gen_mv: 'Gensets connected at MV', len_from_layout: 'Cable lengths from the layout map' };
  const ORDER = ['mv_kv', 't_min', 't_cell_max', 'modules_per_string', 'trafo_pv', 'pv_per_feeder', 'trafo_bess', 'gen_mv', 'trafo_gen', 'gens_per_trafo', 'trafo_load', 'pf_load', 'derate', 'dv_dc', 'dv_lv', 'dv_mv', 'len_from_layout', 'route_factor'];
  const help = (k, l) => hasHelp('el.' + k);
</script>

<div class="form">
  {#each ORDER as k (k)}
    {#if NUM[k]}
      {@const [l, u, step, ph] = NUM[k]}
      <label for="el_{k}">{l}{#if help(k)}<button type="button" class="info" data-k="el.{k}" data-title={l} aria-label="About {l}" aria-expanded="false">i</button>{/if}</label>
      <div class="field">
        <input id="el_{k}" type="number" step={step || 'any'} value={E[k] ?? ''} placeholder={ph || ''} disabled={k === 'route_factor' && !fromLayout}
          onchange={(e) => setBasis(k, e.currentTarget.value === '' ? null : +e.currentTarget.value)}>
        {#if u}<span class="unit">{u}</span>{/if}
      </div>
    {:else if TR[k]}
      <label for="el_{k}">{TR[k]}</label>
      <div class="field">
        <select id="el_{k}" value={E[k]} onchange={(e) => setBasis(k, e.currentTarget.value)}>
          {#if k === 'trafo_load'}<option value="">None (load at MV)</option>{/if}
          {#each trafos as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
        </select>
      </div>
    {:else}
      <label for="el_{k}">{BOOL[k]}{#if help(k)}<button type="button" class="info" data-k="el.{k}" data-title={BOOL[k]} aria-label="About {BOOL[k]}" aria-expanded="false">i</button>{/if}</label>
      <div class="field"><input id="el_{k}" type="checkbox" checked={!!E[k]} onchange={(e) => setBasis(k, e.currentTarget.checked)}></div>
    {/if}
  {/each}
</div>
{#if fromLayout}
  <p class="hint">
    {#if measured.length}Measured on the layout map: {measured.join(', ')}. The short LV runs inside a station stay typed in the cable table.
    {:else}Nothing is measured yet. On the Site &amp; layout page place the MV substation and the stations (the Plant buttons over the map): the string cables then follow the tables, the feeders the stations.{/if}
  </p>
{/if}
