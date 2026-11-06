<!-- The engineering report as a document body. Mounted away from the page by render.js and read back as HTML: every value goes
     through Svelte's escaping, so nothing a project holds (names, notes, imported text) can become markup. -->
<script>
  import RepIntro from './RepIntro.svelte';
  import RepSite from './RepSite.svelte';
  import RepPv from './RepPv.svelte';
  import RepElec from './RepElec.svelte';
  import RepSimA from './RepSimA.svelte';
  import RepSimB from './RepSimB.svelte';
  import RepEcon from './RepEcon.svelte';
  import RepFin from './RepFin.svelte';
  import RepMethod from './RepMethod.svelte';
  let { D } = $props();
</script>

<RepIntro {D} />
<RepSite {D} />
<RepPv {D} />
<RepElec {D} />
{#if D.SIM}<RepSimA {D} /><RepSimB {D} /><RepEcon {D} />{/if}
<RepFin {D} />
<RepMethod {D} />
