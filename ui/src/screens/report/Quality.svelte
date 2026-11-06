<!-- Data quality of the weather or a measured load (the import and the data checks of the old import dialog) -->
<script>
  import Tbl from './Tbl.svelte';
  let { D, kind } = $props();
  const Q = D.h.quality(kind), weather = kind === 'weather';
</script>

{#if Q}
  <h3>Data quality</h3>
  <p>{weather
    ? 'The data checks flag hours that are physically impossible or look stuck, copied or infilled, and compare the timing of the clear days with the sun.'
    : 'The data checks flag outages, stuck values, linear infill, spikes, level shifts and unit errors of the measured load.'} The flags are for information only: the data are used unchanged.</p>
  <Tbl rows={Q.rows} head={['Item', 'Value']} />
  {#if Q.flags.length}<Tbl rows={Q.flags.map((f) => (weather ? f : f.slice(0, 3)))} head={weather ? ['Flag', 'Hours', 'Days', 'Share of GHI'] : ['Flag', 'Hours', 'Days']} />{/if}
  {#each Q.notes as n}<p>{n}</p>{/each}
  {#if !Q.timingOk}<div class="warn">The timing check of the weather needs attention; see Timing above.</div>{/if}
{/if}
