<!-- The figures the user placed at the end of one section of the report (those whose section is not in it go to Additional figures) -->
<script>
  import Fig from './Fig.svelte';
  import { FIG_PLACES } from '../../lib/report/figures.js';
  let { D, place } = $props();
  const list = D.userFigs.filter((f) => (FIG_PLACES[f.place] ? f.place : 'appendix') === place);
</script>

{#each list as f}<Fig src={f.src} cap={f.caption || 'Figure supplied with the project.'} cls="user" />{/each}
