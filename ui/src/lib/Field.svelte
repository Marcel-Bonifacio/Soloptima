<!-- One input of a schema form (an entry `f` of FORMS in web/js/schema.js), bound to `project` at f.k. The project is the
     old workspace's object, not Svelte state: `rev` changes when it was edited elsewhere, and the field reads it again.
     `onchange(key, value)` stores the value and tells the rest of the app. -->
<script>
  import { getPath } from './path.js';
  import { display, parse, sliderRange, inputAttrs } from './field.js';
  import { legacy } from './legacy.js';
  import { hasHelp } from './help/index.js';

  let { f, form, project, rev = 0, onchange } = $props();

  const id = $derived(`f_${form}_${f.k.replace(/\./g, '_')}`);
  const value = $derived.by(() => { rev; return getPath(project, f.k); });
  const shown = $derived.by(() => { rev; return !f.show || f.show(project); });
  const help = $derived(hasHelp(f.k));
  const attrs = $derived(inputAttrs(f));
  const range = $derived(f.sl ? sliderRange(f, value) : null);
  let slideTimer;

  function commit(el, raw) {
    const r = parse(f, raw);
    if (r.error) legacy.toast(r.error, true);
    if (!('v' in r)) {   // refused: the input shows the stored value again
      if (f.t === 'chk') el.checked = !!value; else el.value = display(f, value);
      return;
    }
    onchange(f.k, r.v);
  }
  // dragging the slider changes the value live, as a normal change after a short pause
  function slide(e) {
    const v = e.currentTarget.value;
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => commit(document.getElementById(id), v), 150);
  }
</script>

{#if shown}
  <label for={id}>{f.l}{#if help}<button type="button" class="info" data-k={f.k} data-title={f.l} aria-label="About {f.l}" aria-expanded="false">i</button>{/if}</label>
  <div class="field">
    {#if f.t === 'sel'}
      <select {id} data-k={f.k} data-t={f.t} value={display(f, value)} onchange={(e) => commit(e.currentTarget, e.currentTarget.value)}>
        {#each f.o as [v, t] (v)}<option value={v}>{t}</option>{/each}
      </select>
    {:else if f.t === 'chk'}
      <input {id} {...attrs} data-k={f.k} data-t={f.t} checked={display(f, value)} onchange={(e) => commit(e.currentTarget, e.currentTarget.checked)}>
    {:else}
      <input {id} {...attrs} data-k={f.k} data-t={f.t} value={display(f, value)} onchange={(e) => commit(e.currentTarget, e.currentTarget.value)}>
    {/if}
    {#if f.u}<span class="unit">{f.u}</span>{/if}
  </div>
  {#if range}
    <div class="slider-row">
      <input type="range" min={range.min} max={range.max} step={range.step} value={range.x ?? range.min} aria-label="{f.l} slider" oninput={slide}>
    </div>
  {/if}
{/if}
