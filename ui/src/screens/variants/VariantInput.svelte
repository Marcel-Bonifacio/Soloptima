<!-- The input of one change of a variant: a number, a choice or a tick box, as the project's own form shows it. The value is stored
     only when it is one the input can take (the message otherwise); the parent stores it. -->
<script>
  import { display, parse, inputAttrs } from '../../lib/field.js';
  import { toast } from '../../lib/toast.js';

  let { f, value, unit, onset } = $props();

  function typed(e) {
    const r = parse(f, e.currentTarget.value);
    if (r.error) { toast(r.error, true); e.currentTarget.value = display(f, value); return; }
    if ('v' in r) onset(r.v);   // blank is a value (the engine's default) only for an input that may be blank
    else e.currentTarget.value = display(f, value);   // blank or not a number: the value stays
  }
</script>

{#if f.t === 'chk'}
  <input type="checkbox" aria-label={f.name} checked={!!value} onchange={(e) => onset(e.currentTarget.checked)}>
{:else if f.t === 'sel'}
  <select aria-label={f.name} value={String(value)} onchange={(e) => onset(f.o.find(([x]) => String(x) === e.currentTarget.value)[0])}>
    {#each f.o as [x, label] (x)}<option value={String(x)}>{label}</option>{/each}
  </select>
{:else}
  <input {...inputAttrs(f)} aria-label={f.name} value={display(f, value)} onchange={typed}>
  {#if unit}<span class="unit">{unit}</span>{/if}
{/if}
