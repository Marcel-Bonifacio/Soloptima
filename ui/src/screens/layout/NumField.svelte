<!-- A number of the item editor, checked against [min, max]; blank (null) only where `blank` says what blank means.
     apply(v) takes a value that passed. -->
<script>
  import { untrack } from 'svelte';
  import { legacy } from '../../lib/legacy.js';
  let { text, unit, value, min, max, apply, blank = '' } = $props();
  const shown = (v) => (v == null ? '' : +(+v).toFixed(2));
  // the field starts from `value` and then keeps what was typed (the editor makes its fields again when values move)
  let last = untrack(() => value), input = $state(shown(last));

  function change() {
    const t = String(input ?? '').trim(), v = t === '' ? null : +t;
    if (v == null ? !blank : !(v >= min && v <= max)) {
      legacy.toast(`${text}: ${min} to ${max} ${unit}.`, true);
      input = shown(last);
      return;
    }
    last = v;
    apply(v);
  }
</script>

<label><span>{text}</span><input type="number" step="any" placeholder={blank || null} bind:value={input} onchange={change}>{unit}</label>
