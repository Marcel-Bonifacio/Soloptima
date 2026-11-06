<!-- A modal <dialog> (class dlg of the style sheet), open while `open` is true. Escape or Close calls `onclose` (`noclose` leaves the Close button out, for a dialog with its own Cancel). -->
<script>
  let { open, onclose, title, class: cls = '', wide = false, label, noclose = false, children } = $props();
  let d;
  $effect(() => {
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  });
</script>

<dialog bind:this={d} class="dlg" class:wide aria-label={label || title} onclose={() => { if (open) onclose(); }}>
  {#if open}
    <div class="dlg-body {cls}">
      <div class="dlg-head"><h2>{title}</h2>{#if !noclose}<button type="button" class="btn ghost small" onclick={onclose}>Close</button>{/if}</div>
      {@render children()}
    </div>
  {/if}
</dialog>
