<!-- One Plotly chart. `build(c)` returns {traces, layout} for the colours c; it runs again when the state it reads changes.
     The element keeps its id and Plotly's `data`, which the report reads to take pictures of the charts (lib/report/data.js). -->
<script>
  import { colours, baseLayout, PLOT_CFG } from './chart.js';
  import { onDestroy } from 'svelte';

  let { id, build, cls = '', onclick = null } = $props();
  let el = $state(null);
  let clickBound = false;

  $effect(() => {
    if (!el || !window.Plotly) return;
    const c = colours();
    const out = build(c);
    if (!out) { window.Plotly.purge(el); return; }
    const { traces, layout } = out;
    window.Plotly.react(el, traces, baseLayout(c, layout), PLOT_CFG);
    if (onclick && !clickBound && el.on) { clickBound = true; el.on('plotly_click', (ev) => onclick(ev.points[0])); }
  });

  // a chart drawn while its page is hidden gets its size when the page opens
  $effect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (el.data && el.clientWidth > 0) window.Plotly.Plots.resize(el); });
    ro.observe(el);
    return () => ro.disconnect();
  });

  onDestroy(() => { if (el && window.Plotly) window.Plotly.purge(el); });
</script>

<div {id} class="chart {cls}" bind:this={el}></div>
