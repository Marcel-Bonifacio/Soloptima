<!-- The 3D view of the Site & layout page: the tables, buildings, trees, PV areas on their sloped ground, the plant's stations and
     inverters and the cable routes between them (lib/layout/scene.js), lit and shadowed by the sun on the 21st of a chosen month at
     a chosen solar hour, which can play through the day. The tables can take the colour of their inverter block or of their shade.
     Drag to turn it, the wheel to zoom, click a table or a station to see what it is. -->
<script>
  import { onMount } from 'svelte';
  import { lay, P } from '../../lib/layout/map.svelte.js';
  import { sceneOf, sunOf, cameraOf, drawList, pickAt } from '../../lib/layout/scene.js';
  import { inverterBlocks, blockColours } from '../../lib/equip/blocks.js';
  import { routeFactor } from '../../lib/equip/siteplan.js';
  import { design, el as elec } from '../../lib/equip/electrical.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { E as LE } from '../../lib/layout/edit.svelte.js';
  import { SHADE_CLASSES } from '../../lib/layout/fill.js';
  import { kindName } from '../../lib/layout/stations.js';
  import { MONTHS } from '../../lib/series.js';
  import { fmtNum, fmtPct } from '../../lib/format.js';
  import { onDestroy } from 'svelte';

  let canvas, wrap, month = $state(5), hour = $state(10), az = $state(200), el = $state(35), zoom = $state(1), w = $state(800), h = $state(640);
  let colour = $state('plain'), cables = $state(true), playing = $state(false), picked = $state(null), list = [];
  // the blocks follow the layout and the Inverters setting of the electrical design basis
  const blocks = $derived.by(() => { lay.rev; forms.rev; elec.rev; return inverterBlocks(P(), routeFactor(P().electrical || {})); });
  const scene = $derived.by(() => { lay.rev; return sceneOf(P(), blocks); });
  const sun = $derived(sunOf(+P().location.lat || 0, month, hour));
  const colours = $derived(blocks ? blockColours(blocks.nodes.map((s) => s.latlng)) : []);
  // a table's own colour: its block, or its shade class (shade of the last yield calculation)
  const colourOf = $derived.by(() => {
    lay.rev;
    if (colour === 'block' && blocks) return (f) => colours[blocks.tableNode[f.i]] || null;
    const sh = LE.shade;
    if (colour === 'shade' && sh && scene && sh.tables.length === scene.centres.length) return (f) => (SHADE_CLASSES.find(([lim]) => sh.tables[f.i] < lim) || [])[1] || null;
    return null;
  });

  $effect(() => {
    const ctx = canvas && canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = sun.el > 0 ? '#bcd8ee' : '#4a5566';
    ctx.fillRect(0, 0, w, h);
    if (!scene) return;
    const cam = cameraOf(az, el, scene.size * 2.4 / zoom, w, h);
    ctx.lineJoin = 'round';
    list = drawList(cables ? scene : { ...scene, lines: [] }, sun, cam, colourOf);
    for (const p of list) {
      ctx.beginPath();
      p.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (p.line) { ctx.strokeStyle = p.fill; ctx.lineWidth = p.line === 'dc' ? 0.7 : 2; ctx.stroke(); ctx.lineWidth = 1; continue; }
      ctx.closePath();
      ctx.fillStyle = p.fill;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.stroke();
    }
  });

  onMount(() => {
    // the canvas fills its box (web/style.css, .view3d) without sizing it, so this never feeds back into itself
    const ro = new ResizeObserver(() => { w = Math.max(200, wrap.clientWidth); h = Math.max(240, wrap.clientHeight); });
    ro.observe(wrap);
    return () => ro.disconnect();
  });

  // the sun through the day: a quarter of an hour every 80 ms, from 5:00 to 19:00 and round again
  let timer = null;
  function play() {
    playing = !playing;
    clearInterval(timer);
    if (playing) timer = setInterval(() => { hour = hour >= 19 ? 5 : +(hour + 0.25).toFixed(2); }, 80);
  }
  onDestroy(() => clearInterval(timer));

  // what a click hit: a table (its block, string cable and losses) or a station
  function pick(x, y) {
    const f = pickAt(list, x, y);
    if (!f) { picked = null; return; }
    if (f.st != null) { const s = (P().layout.stations || [])[f.st]; picked = s ? { title: kindName(s.kind) + (s.name ? ': ' + s.name : '') } : null; return; }
    if (f.kind !== 'table') { picked = null; return; }
    const out = { title: `Table ${f.i + 1}` }, j = blocks ? blocks.tableNode[f.i] : -1;
    if (j >= 0) {
      const node = blocks.nodes[j];
      out.block = (node.name || (blocks.mode === 'string' ? 'Inverter ' : 'PV station ') + (j + 1));
      const D = design(), x = D.blocks && D.blocks.list[j];
      out.cable = blocks.blocks[j].n ? blocks.blocks[j].dcSum / blocks.blocks[j].n : null;
      if (x) { out.loss = x.loss; out.dv = x.dvDc; }
      out.colour = colours[j];
    }
    const sh = LE.shade;
    if (sh && sh.tables.length === scene.centres.length) out.shade = sh.tables[f.i];
    picked = out;
  }

  let drag = null;
  const down = (e) => { drag = [e.clientX, e.clientY, az, el, false]; canvas.setPointerCapture(e.pointerId); };
  const up = (e) => {
    if (drag && !drag[4]) { const r = canvas.getBoundingClientRect(); pick(e.clientX - r.left, e.clientY - r.top); }
    drag = null;
  };
  const move = (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag[0]) + Math.abs(e.clientY - drag[1]) > 4) drag[4] = true;
    if (!drag[4]) return;
    az = (drag[2] - (e.clientX - drag[0]) * 0.4 + 360) % 360;
    el = Math.min(89, Math.max(5, drag[3] + (e.clientY - drag[1]) * 0.3));
  };
  const wheel = (e) => { e.preventDefault(); zoom = Math.min(20, Math.max(0.3, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); };
  const key = (e) => {
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 5], ArrowDown: [0, -5] }[e.key];
    if (step) { e.preventDefault(); az = (az + step[0] + 360) % 360; el = Math.min(89, Math.max(5, el + step[1])); }
    if (e.key === '+' || e.key === '=') zoom = Math.min(20, zoom * 1.15);
    if (e.key === '-') zoom = Math.max(0.3, zoom / 1.15);
  };
</script>

<div class="view3d" bind:this={wrap}>
  <canvas bind:this={canvas} tabindex="0" aria-label="3D view of the layout: drag or use the arrow keys to turn it, the wheel or + and - to zoom"
    onpointerdown={down} onpointermove={move} onpointerup={up} onwheel={wheel} onkeydown={key}></canvas>
  <div class="view3d-bar">
    <label>Sun on 21 <select bind:value={month}>{#each MONTHS as m, i (m)}<option value={i}>{m}</option>{/each}</select></label>
    <label>at <input type="range" min="5" max="19" step="0.25" bind:value={hour}> {fmtNum(Math.floor(hour), 0)}:{String(Math.round((hour % 1) * 60)).padStart(2, '0')} solar time</label>
    <button type="button" class="btn small ghost" class:on={playing} aria-pressed={playing} onclick={play}>{playing ? 'Pause' : 'Play the day'}</button>
    <span class="hint">{sun.el > 0 ? `sun ${fmtNum(sun.el, 0)}° high, ${fmtNum(sun.az, 0)}° from north` : 'sun below the horizon'}</span>
    <label>Tables <select bind:value={colour}><option value="plain">one colour</option><option value="block" disabled={!blocks}>by inverter block</option><option value="shade" disabled={!LE.shade}>by shade</option></select></label>
    <label class="inline"><input type="checkbox" bind:checked={cables}> cables</label>
    {#if picked}
      <span class="view3d-pick">{#if picked.colour}<i style:background={picked.colour}></i>{/if}<b>{picked.title}</b>
        {#if picked.block} · {picked.block}{/if}{#if picked.cable != null} · string cables {fmtNum(picked.cable, 0)} m average in the block{/if}
        {#if picked.loss != null} · block loss {fmtPct(picked.loss, 2)}{/if}{#if picked.dv != null}, ΔV {fmtNum(picked.dv * 100, 2)} %{/if}
        {#if picked.shade != null} · shade {fmtPct(picked.shade, 1)}{/if}</span>
    {/if}
    {#if !scene}<span class="hint">Draw PV areas, buildings or trees on the layout map first.</span>{/if}
  </div>
</div>

