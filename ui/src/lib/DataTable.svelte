<!-- A table of the shared `data` style. heads: header texts; rows: arrays of cell texts, or {cells, cls}. Cells are text, so escaped. -->
<script>
  let { heads, rows, cls = '', titles = {} } = $props();
</script>

<div class="table-wrap">
  <table class="data {cls}">
    <thead><tr>{#each heads as h, i}<th title={titles[i]}>{h}</th>{/each}</tr></thead>
    <tbody>
      {#each rows as r}
        {@const cells = Array.isArray(r) ? r : r.cells}
        <tr class={Array.isArray(r) ? '' : r.cls || ''}>{#each cells as c}<td>{c}</td>{/each}</tr>
      {/each}
    </tbody>
  </table>
</div>
