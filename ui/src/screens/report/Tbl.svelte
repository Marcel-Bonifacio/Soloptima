<!-- A report table: optional head, text cells (a missing value shows as a dash), numbers right-aligned from the second column -->
<script>
  let { rows, head = null } = $props();
</script>

<table><tbody>
  {#if head}<tr>{#each head as c}<th>{c}</th>{/each}</tr>{/if}
  {#each rows as r}<tr>{#each r as c, i}<td class={i ? 'n' : undefined}>{c == null ? '–' : String(c)}</td>{/each}</tr>{/each}
</tbody></table>
