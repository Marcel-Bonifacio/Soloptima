<!-- The 3D view of the Site & layout page: the tables, buildings, trees and PV areas on their sloped ground (lib/layout/scene.js),
     lit and shadowed by the sun on the 21st of a chosen month at a chosen solar hour. Drag to turn it, the wheel to zoom. -->
<script>
  import { onMount } from 'svelte';
  import { lay, P } from '../../lib/layout/map.svelte.js';
  import { sceneOf, sunOf, cameraOf, drawList } from '../../lib/layout/scene.js';
  import { MONTHS } from '../../lib/series.js';
  import { fmtNum } from '../../lib/format.js';

  let canvas, wrap, month = $state(5), hour = $state(10), az = $state(200), el = $state(35), zoom = $state(1), w = $state(800), h = $state(640);
  const scene = $derived.by(() => { lay.rev; return sceneOf(P()); });
  const sun = $derived(sunOf(+P().location.lat || 0, month, hour));

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
    for (const p of drawList(scene, sun, cam)) {
      ctx.beginPath();
      p.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = p.fill;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.stroke();
    }
  });

  onMount(() => {
    const ro = new ResizeObserver(() => { w = Math.max(200, wrap.clientWidth); h = Math.max(240, wrap.clientHeight); });
    ro.observe(wrap);
    return () => ro.disconnect();
  });

  let drag = null;
  const down = (e) => { drag = [e.clientX, e.clientY, az, el]; canvas.setPointerCapture(e.pointerId); };
  const move = (e) => {
    if (!drag) return;
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
  <canvas bind:this={canvas} style="width:{w}px;height:{h}px" tabindex="0" aria-label="3D view of the layout: drag or use the arrow keys to turn it, the wheel or + and - to zoom"
    onpointerdown={down} onpointermove={move} onpointerup={() => (drag = null)} onwheel={wheel} onkeydown={key}></canvas>
  <div class="view3d-bar">
    <label>Sun on 21 <select bind:value={month}>{#each MONTHS as m, i (m)}<option value={i}>{m}</option>{/each}</select></label>
    <label>at <input type="range" min="5" max="19" step="0.25" bind:value={hour}> {fmtNum(Math.floor(hour), 0)}:{String(Math.round((hour % 1) * 60)).padStart(2, '0')} solar time</label>
    <span class="hint">{sun.el > 0 ? `sun ${fmtNum(sun.el, 0)}° high, ${fmtNum(sun.az, 0)}° from north` : 'sun below the horizon'}</span>
    {#if !scene}<span class="hint">Draw PV areas, buildings or trees on the layout map first.</span>{/if}
  </div>
</div>

<style>
  .view3d { position: relative; width: 100%; height: 640px; overflow: hidden; }
  .view3d canvas { display: block; cursor: grab; touch-action: none; }
  .view3d canvas:active { cursor: grabbing; }
  .view3d-bar { position: absolute; left: 8px; right: 8px; bottom: 8px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
    padding: 6px 10px; border-radius: 6px; background: var(--surface, #fff); opacity: 0.92; font-size: 13px; }
</style>
