<!-- A modal <dialog> (class dlg of the style sheet), open while `open` is true. Escape or Close calls `onclose`. -->
<script>
  let { open, onclose, title, class: cls = '', label, children } = $props();
  let d;
  $effect(() => {
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  });
</script>

<dialog bind:this={d} class="dlg" aria-label={label || title} onclose={() => { if (open) onclose(); }}>
  {#if open}
    <div class="dlg-body {cls}">
      <div class="dlg-head"><h2>{title}</h2><button type="button" class="btn ghost small" onclick={onclose}>Close</button></div>
      {@render children()}
    </div>
  {/if}
</dialog>
