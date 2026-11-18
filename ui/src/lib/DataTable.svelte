<!-- A table of the shared `data` style. heads: header texts; rows: arrays of cell texts, or {cells, cls}. Cells are text, so escaped.
     action: an optional snippet of the row, drawn in a last cell (an Apply button). -->
<script>
  let { heads, rows, cls = '', titles = {}, action = null } = $props();
</script>

<div class="table-wrap">
  <table class="data {cls}">
    <thead><tr>{#each heads as h, i}<th title={titles[i]}>{h}</th>{/each}</tr></thead>
    <tbody>
      {#each rows as r}
        {@const cells = Array.isArray(r) ? r : r.cells}
        <tr class={Array.isArray(r) ? '' : r.cls || ''}>{#each cells as c}<td>{c}</td>{/each}{#if action}<td>{@render action(r)}</td>{/if}</tr>
      {/each}
    </tbody>
  </table>
</div>
