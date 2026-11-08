<!-- A saved project on the landing page. The cover is generated: sky gradient, sun and PV rows, tinted per project so cards
     are recognisable at a glance. The sun is a layer of its own so it can cross the sky (style.css); the negative delay
     starts each project at its own time of day. -->
<script>
  import { openProject, duplicateProject, deleteProject, exportProject } from '../lib/projects.svelte.js';
  import { fmtNum, fmtPct, hash, relTime } from '../lib/format.js';

  let { p } = $props();
  const h = $derived(hash(p.id)), hue = $derived(h % 360), t = $derived(-((h >>> 8) % 400) / 10);
  const cur = $derived(p.currency || 'USD');
  const open = () => openProject(p.id);
</script>

<!-- the card opens the project (click or Enter) and holds buttons of its own, so it cannot be a button itself -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<article class="pcard" tabindex="0" aria-label="Open {p.name}"
  onclick={(e) => { if (!(e.target instanceof Element && e.target.closest('button'))) open(); }}
  onkeydown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
  <div class="cover">
    <svg viewBox="0 0 100 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><linearGradient id="g{h}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl({hue},38%,42%)"/><stop offset="1" stop-color="hsl({(hue + 40) % 360},45%,28%)"/></linearGradient></defs>
      <rect width="100" height="92" fill="url(#g{h})"/></svg>
    <span class="sun" style:--t="{t}s" aria-hidden="true"><i></i></span>
    <svg viewBox="0 0 100 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M0 64 Q30 52 60 60 T100 56 V92 H0z" fill="rgba(0,0,0,.18)"/>
      {#each [0, 1, 2, 3, 4] as i (i)}<path d="M{-10 + i * 6} {70 + i * 5}h{120 - i * 4}" stroke="rgba(255,255,255,{0.22 + i * 0.07})" stroke-width="3"/>{/each}</svg>
    <span class="loc">{p.lat != null ? `${(+p.lat).toFixed(3)}, ${(+p.lon).toFixed(3)}` : ''}</span>
  </div>
  <div class="body"><h3>{p.name || 'Untitled'}</h3>
    <div class="specs"><span><b>{fmtNum((p.pv_kwp || 0) / 1000, 2)}</b> MWp PV</span><span><b>{fmtNum((p.bess_kwh || 0) / 1000, 1)}</b> MWh BESS</span>
      <span><b>{fmtNum(p.gensets || 0)} × {fmtNum(p.genset_kw || 0)}</b> kW diesel</span>{#if p.wind_units}<span><b>{fmtNum(p.wind_units)}</b> wind</span>{/if}</div>
    <div class="res">
      {#if p.re != null}<span>RE <b>{fmtPct(p.re, 1)}</b></span>{/if}
      {#if p.lcoe != null}<span>LCOE <b>{fmtNum(p.lcoe, 3)}</b> {cur}/kWh</span>{/if}
      {#if p.equity_irr != null}<span>Equity IRR <b>{fmtPct(p.equity_irr, 1)}</b></span>{/if}
      {#if p.re == null}<span>Not simulated yet</span>{/if}
    </div></div>
  <div class="foot"><time datetime={p.updated || ''}>Edited {relTime(p.updated)}</time>
    <button class="btn ghost small" onclick={() => duplicateProject(p.id)}>Duplicate</button>
    <button class="btn ghost small" title="Download .json" onclick={() => exportProject(p.id)}>Export</button>
    <button class="btn ghost small danger" onclick={() => deleteProject(p)}>Delete</button></div>
</article>
