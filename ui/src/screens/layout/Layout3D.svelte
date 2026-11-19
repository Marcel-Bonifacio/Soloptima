<!-- The 3D view of the Site & layout page: the tables on their structures, buildings with their roofs, trees by crown shape,
     carports, PV areas on their ground, the plant's stations and the cable routes (lib/layout/scene.js), on the satellite
     image of the site when it can be had (lib/layout/ground.js), lit and shadowed by the sun on the 21st of a chosen month at a chosen solar hour. The app's GPU renderer draws it (src-tauri/src/view3d.rs);
     without a graphics adapter the canvas draws it farthest face first. Drag to turn it, shift-drag or the right button to pan,
     the wheel to zoom. A click selects an item for the inspector; its handles move it, turn it or size it, one undo step per
     drag, and the engine shades with the same shapes. -->
<script>
  import { addFigures } from '../../lib/report-figs.svelte.js';
  import { toast } from '../../lib/toast.js';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { call } from '../../lib/ipc.js';
  import { lay, P } from '../../lib/layout/map.svelte.js';
  import { sceneOf, sunOf, cameraOf, drawList, pickFace, meshOf } from '../../lib/layout/scene.js';
  import { groundBox, groundCorners, groundBody, fetchGround, drawGround, GROUND_CREDIT } from '../../lib/layout/ground.js';
  import { frameOf, sizeOf, moveItem, turnItem, slopeTurns, withSlope, resizeItem, canSlope } from '../../lib/layout/transform.js';
  import { inverterBlocks, blockColours } from '../../lib/equip/blocks.js';
  import { routeFactor } from '../../lib/equip/siteplan.js';
  import { design, el as elec } from '../../lib/equip/electrical.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { centroid } from '../../lib/layout/geometry.js';
  import { E as LE, select, updateItem, run } from '../../lib/layout/edit.svelte.js';
  import { SHADE_CLASSES } from '../../lib/layout/fill.js';
  import { kindName } from '../../lib/layout/stations.js';
  import { MONTHS } from '../../lib/series.js';
  import { fmtNum, fmtPct } from '../../lib/format.js';

  let canvas, over, wrap, month = $state(5), hour = $state(10), az = $state(200), el = $state(35), zoom = $state(1), w = $state(800), h = $state(640);
  let target = $state([0, 0, 0]), colour = $state('plain'), cables = $state(true), struts = $state(true), opts = $state(false), playing = $state(false), picked = $state(null);
  let tool = $state('move'), snap = $state(true), hover = $state(null), preview = $state.raw(null), dragK = $state(null), interacting = $state(false);
  // the graphics API of the GPU renderer once it has the scene (Metal, Direct3D 12, Vulkan); false: the canvas draws instead
  let gpu = $state(null), meshRev = $state(0);
  // the satellite image under the scene: on by default; img is the image of box once fetched, note says why there is none
  let mapOn = $state(true), ground = $state.raw(null), groundNote = $state(''), gErr = $state(false);
  // every page stays mounted: while the Site & layout page is hidden the view builds, sends and draws nothing, and does it all
  // again when the page shows
  const shown = $derived(ws.tab === 'site');
  const blocks = $derived.by(() => { if (!shown) return null; lay.rev; forms.rev; elec.rev; return inverterBlocks(P(), routeFactor(P().electrical || {})); });
  // while an item is dragged: the rest of the layout, sent once when the drag starts, and the item alone where it is going,
  // sent at every step (a PV area without its tables until it is filled again)
  const scene = $derived.by(() => { if (!shown) return null; lay.rev; return sceneOf(P(), dragK != null ? null : blocks, { skip: dragK ?? -1 }); });
  const moving = $derived.by(() => {
    if (!preview || !scene) return null;
    const p = P(), pol = (p.layout.polygons || []).slice();
    pol[preview.k] = preview.q;
    const result = preview.q.type === 'site' ? null : p.layout.result;
    return sceneOf({ ...p, layout: { ...p.layout, polygons: pol, result } }, null, { only: preview.k, pr: scene.pr });
  });
  const sun = $derived(sunOf(+P().location.lat || 0, month, hour));
  const colours = $derived(blocks ? blockColours(blocks.nodes.map((s) => s.latlng)) : []);
  // a table's own colour: its block, or its shade class (shade of the last yield calculation)
  const colourOf = $derived.by(() => {
    lay.rev;
    if (dragK != null) return null;
    if (colour === 'block' && blocks) return (f) => colours[blocks.tableNode[f.i]] || null;
    const sh = LE.shade;
    if (colour === 'shade' && sh && scene && sh.tables.length === scene.centres.length) return (f) => (SHADE_CLASSES.find(([lim]) => sh.tables[f.i] < lim) || [])[1] || null;
    return null;
  });
  const items = () => P().layout.polygons || [];
  const sel = $derived(lay.selected != null && items()[lay.selected] ? lay.selected : null);
  // the project's own extent: the centre and the half diagonal of everything drawn, which the view frames when it opens
  const fit = $derived.by(() => {
    if (!scene || !scene.faces.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = 0;
    for (const f of scene.faces) for (const p of f.pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); z1 = Math.max(z1, p[2]); }
    return { c: [(x0 + x1) / 2, (y0 + y1) / 2, 0], r: Math.max(15, Math.hypot(x1 - x0, y1 - y0) / 2, z1) };
  });
  const dist = () => (fit ? fit.r * 2.6 / zoom : scene ? scene.size * 2.4 / zoom : 1);
  const cam = () => cameraOf(az, el, dist(), w, h, target);

  // ---------------------------------------------------------------- drawing: the GPU renderer, else the canvas
  // meshes go one at a time, the latest of each kind after the one in flight, the scene before the moving item (a new scene
  // clears the moving item in the shell, so the item never shows twice or not at all)
  const pend = { scene: null, moving: null };
  let sending = false;
  async function send(kind, mesh) {
    pend[kind] = mesh;
    if (sending) return;
    sending = true;
    try {
      while (pend.scene || pend.moving) {
        const k = pend.scene ? 'scene' : 'moving', m = pend[k];
        pend[k] = null;
        const api = await call(k === 'scene' ? 'view3d_scene' : 'view3d_moving', m);
        if (k === 'scene') gpu = api;
        meshRev++;
      }
    } catch { gpu = false; } finally { sending = false; }
  }
  const mapShown = $derived(mapOn && !!ground && !!ground.img);
  $effect(() => {
    if (!shown || untrack(() => gpu) === false) return;
    send('scene', scene ? meshOf(scene, colourOf, cables, struts, true, mapShown && !gErr) : new Uint8Array(0));
  });

  // ---------------------------------------------------------------- the satellite image under the scene
  // fetched once per box (a square round the scene, snapped to a grid; lib/layout/ground.js), kept while an item is dragged
  $effect(() => {
    if (!shown || dragK != null) return;
    const box = mapOn && scene ? groundBox(scene) : null;
    untrack(() => {
      if (!box) { ground = null; groundNote = mapOn && scene ? 'No satellite image this close to a pole or across 180°.' : ''; return; }
      if (ground && ground.box.key === box.key) return;
      ground = { box, img: null };
      groundNote = 'Loading the satellite image...';
      fetchGround(box).then((img) => {
        if (!ground || ground.box.key !== box.key) return;
        ground = { box, img };
        groundNote = img ? '' : 'No satellite image (offline?): plain ground.';
      });
    });
  });
  // to the GPU: the image once, then only the corners as the scene's frame moves; nothing (it clears) without an image
  // gSent starts as unknown (true): the shell may still hold the image of a view shown before, so no image now clears it
  let gSent = /** @type {any} */ (true), gSending = false, gPend = null, gLast = '';
  async function sendGround(body, img, key = '') {
    gPend = { body, img, key };
    if (gSending) return;
    gSending = true;
    try {
      while (gPend) {
        const g = gPend;
        gPend = null;
        await call('view3d_ground', g.body);
        gSent = g.img;
        gLast = g.key;
        gErr = false;
        meshRev++;
      }
    } catch { gSent = null; gLast = ''; gErr = true; } finally { gSending = false; }
  }
  $effect(() => {
    if (!shown || gpu === false) return;
    const img = mapShown && scene ? ground.img : null;
    if (!img) { if (gSent || gSending) sendGround(new Uint8Array(0), null); return; }
    const corners = groundCorners(ground.box, scene.pr), key = corners.flat().join();
    untrack(() => {
      if (gSent === img && gLast === key && !gSending) return;
      sendGround(groundBody(corners, gSent === img && !gPend ? null : img), img, key);
    });
  });
  $effect(() => { if (moving && untrack(() => gpu) !== false) send('moving', meshOf(moving, null, false, struts, false)); });
  const frameView = () => {
    // at most 2.5 megapixels (1 while dragging, for speed): a full screen 4K view would hold about 330 MB on the GPU and copy
    // 33 MB a frame
    const k = Math.min(window.devicePixelRatio || 1, 4096 / Math.max(w, h), Math.sqrt((interacting ? 1e6 : 2.5e6) / (w * h))), portrait = P().layout.orientation !== 'landscape';
    return { w: Math.round(w * k), h: Math.round(h * k), az, el, dist: dist(), target: [...target], sun: sun.dir, day: sun.el > 0, cells: portrait ? [6, 12] : [12, 6] };
  };
  let busy = false, again = false;
  async function frame() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        const v = frameView(), px = await call('view3d_frame', v);
        if (!canvas) return;
        if (canvas.width !== v.w || canvas.height !== v.h) { canvas.width = v.w; canvas.height = v.h; }
        canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), v.w, v.h), 0, 0);
      } while (again);
    } catch { gpu = false; } finally { busy = false; }
  }
  $effect(() => { void meshRev; if (!shown) return; frameView(); if (gpu && canvas) frame(); });
  $effect(() => {
    const ctx = canvas && canvas.getContext('2d');
    if (!ctx || gpu !== false || !shown) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = sun.el > 0 ? '#bcd8ee' : '#4a5566';
    ctx.fillRect(0, 0, w, h);
    if (!scene) return;
    ctx.lineJoin = 'round';
    const c = cam(), map = mapShown ? ground : null;
    drawList(cables ? scene : { ...scene, lines: [] }, sun, c, colourOf, !!map).forEach((p, k) => {
      ctx.beginPath();
      p.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (p.line) { ctx.strokeStyle = p.fill; ctx.lineWidth = p.line === 'dc' ? 0.7 : 2; ctx.stroke(); ctx.lineWidth = 1; return; }
      ctx.closePath();
      ctx.globalAlpha = map && p.shadow ? 0.45 : 1;   // shadows let the image show through
      ctx.fillStyle = p.fill; ctx.fill();
      if (!p.shadow || !map) { ctx.strokeStyle = p.fill; ctx.stroke(); }   // closes the hairline gaps between faces
      ctx.globalAlpha = 1;
      // the first polygon is the plain ground: the image goes on it, under everything else
      if (k === 0 && map) drawGround(ctx, map.img.bitmap, groundCorners(map.box, scene.pr), c);
    });
  });

  // ---------------------------------------------------------------- the selected item's handles, on a canvas over the view
  const AXC = ['#e24b4a', '#639922', '#378add'];
  // the point the handles start from: the item's centre, at its table height for a PV area
  function pivot(g) {
    if (!scene || !g) return [0, 0, 0];
    const xy = scene.pr.fwd(g.center || centroid(g.latlngs || []));
    const z = g.type === 'site' ? (+g.base || 0) + (g.h0 != null ? +g.h0 : +P().pv.mount_height || 1.5) : 0;
    return [xy[0], xy[1], z];
  }
  // unit directions of the handles: east, north and up to move; the item's long axis, across it and up to size it
  function axes(g) {
    if (tool !== 'size') return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const a = frameOf(g).axis * Math.PI / 180;
    return [[Math.sin(a), Math.cos(a), 0], [Math.cos(a), -Math.sin(a), 0], [0, 0, 1]];
  }
  // which handles an item has: nothing leaves the ground but a PV area; only a PV area on the ground turns about the level axes
  function allowed(g, k) {
    if (tool === 'move') return k < 2 || g.type === 'site';
    if (tool === 'turn') return k === 2 || canSlope(g, P());
    return !(g.type === 'exclusion' && k === 2);
  }
  function handles(c) {
    // the selection can outlive its item (an area drawn again, an undo): no item, no handles
    const g = preview ? preview.q : sel != null ? items()[sel] : null;
    if (!g) return { o: [0, 0, 0], p0: c.to2d([0, 0, 0]), out: [], L: 0, A: [] };
    const o = pivot(g), L = dist() * 0.13, A = axes(g), out = [];
    A.forEach((d, k) => {
      if (!allowed(g, k)) return;
      if (tool !== 'turn') { out.push({ k, pts: [c.to2d(o), c.to2d(o.map((v, i) => v + d[i] * L))] }); return; }
      const u = A[(k + 1) % 3], v = A[(k + 2) % 3];
      out.push({ k, ring: true, pts: Array.from({ length: 49 }, (_, i) => { const t = i / 48 * 2 * Math.PI; return c.to2d(o.map((x, j) => x + L * (u[j] * Math.cos(t) + v[j] * Math.sin(t)))); }) });
    });
    return { o, p0: c.to2d(o), out, L, A };
  }
  function drawOver() {
    const ctx = over && over.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (over.width !== Math.round(w * dpr)) { over.width = Math.round(w * dpr); over.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!scene) return;
    const c = cam();
    // north, east and up in the corner
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((d, k) => {
      const a = c.to2d(target), b = c.to2d(target.map((v, i) => v + d[i] * dist() * 0.05)), n = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, x = (b[0] - a[0]) / n * 20, y = (b[1] - a[1]) / n * 20;
      ctx.strokeStyle = ctx.fillStyle = AXC[k]; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(30, h - 30); ctx.lineTo(30 + x, h - 30 + y); ctx.stroke();
      ctx.font = '600 11px sans-serif'; ctx.fillText(['E', 'N', 'Up'][k], 30 + x * 1.35 - 4, h - 30 + y * 1.35 + 4);
    });
    if (sel == null || !items()[sel]) return;
    // the dashed box round the item's faces
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const f of (moving || scene).faces) if (f.it === sel) for (const p of f.pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
    if (lo[0] < Infinity) {
      const P3 = (i, j, k) => c.to2d([[lo, hi][i][0], [lo, hi][j][1], [lo, hi][k][2]]);
      ctx.strokeStyle = '#ef9f27'; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]);
      for (const [a, b] of [[[0, 0, 0], [1, 0, 0]], [[0, 1, 0], [1, 1, 0]], [[0, 0, 1], [1, 0, 1]], [[0, 1, 1], [1, 1, 1]], [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]],
        [[0, 0, 1], [0, 1, 1]], [[1, 0, 1], [1, 1, 1]], [[0, 0, 0], [0, 0, 1]], [[1, 0, 0], [1, 0, 1]], [[0, 1, 0], [0, 1, 1]], [[1, 1, 0], [1, 1, 1]]]) {
        const p = P3(...a), q = P3(...b); ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    const { p0, out } = handles(c);
    for (const hd of out) {
      const on = (hover === hd.k) || (drag && drag.k === hd.k);
      ctx.strokeStyle = ctx.fillStyle = AXC[hd.k]; ctx.lineWidth = on ? 4 : 2.5;
      ctx.beginPath(); hd.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
      if (hd.ring) continue;
      const [a, b] = hd.pts, n = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, d = [(b[0] - a[0]) / n, (b[1] - a[1]) / n], q = [-d[1], d[0]];
      if (tool === 'size') ctx.fillRect(b[0] - 5, b[1] - 5, 10, 10);
      else { ctx.beginPath(); ctx.moveTo(b[0] + d[0] * 10, b[1] + d[1] * 10); ctx.lineTo(b[0] + q[0] * 5, b[1] + q[1] * 5); ctx.lineTo(b[0] - q[0] * 5, b[1] - q[1] * 5); ctx.fill(); }
    }
    ctx.fillStyle = '#faeeda'; ctx.strokeStyle = '#854f0b'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p0[0], p0[1], 4, 0, 7); ctx.fill(); ctx.stroke();
  }
  $effect(() => { void scene; void moving; void sel; void tool; void hover; void az; void el; void zoom; void w; void h; void target; drawOver(); });

  // ---------------------------------------------------------------- pointer: handles, turning and panning the view, picking
  let drag = null, rafPending = false, lastMove = null;
  const pos = (e) => { const r = over.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const segDist = (p, a, b) => { const ab = [b[0] - a[0], b[1] - a[1]], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2 || 1))); return Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1]); };
  function hitHandle(m) {
    if (sel == null || !scene) return null;
    let best = null, bd = 8;
    for (const hd of handles(cam()).out) for (let i = 0; i + 1 < hd.pts.length; i++) { const d = segDist(m, hd.pts[i], hd.pts[i + 1]); if (d < bd) { bd = d; best = hd.k; } }
    return best;
  }
  const snapTo = (v, s) => (snap ? Math.round(v / s) * s : v);
  // metres the pointer moved along a handle's direction d from point o
  function along(m, o, d) {
    const c = cam(), L = dist() * 0.13, a = c.to2d(o), b = c.to2d(o.map((v, i) => v + d[i] * L)), s = [b[0] - a[0], b[1] - a[1]];
    return ((m[0] - drag.m0[0]) * s[0] + (m[1] - drag.m0[1]) * s[1]) / (s[0] ** 2 + s[1] ** 2 || 1) * L;
  }
  function down(e) {
    over.focus();
    const m = pos(e), k = e.button === 0 && !e.shiftKey ? hitHandle(m) : null;
    over.setPointerCapture(e.pointerId);
    interacting = true;
    if (k != null) {
      const g = items()[sel], h0 = handles(cam());
      dragK = sel;
      drag = { k, m0: m, g, o: h0.o, d: h0.A[k], c0: h0.p0, last: Math.atan2(m[1] - h0.p0[1], m[0] - h0.p0[0]), turn: 0, s0: sizeOf(g, P()), t0: slopeTurns(g, P()) };
    } else drag = { view: e.button === 2 || e.shiftKey ? 'pan' : 'turn', m0: m, last: m, moved: false };
  }
  function move(e) {
    const m = pos(e);
    if (!drag) { const k = hitHandle(m); if (k !== hover) hover = k; over.style.cursor = k != null ? 'pointer' : 'grab'; return; }
    if (drag.view) {
      const dx = m[0] - drag.last[0], dy = m[1] - drag.last[1];
      drag.last = m;
      if (Math.abs(m[0] - drag.m0[0]) + Math.abs(m[1] - drag.m0[1]) > 4) drag.moved = true;
      if (!drag.moved) return;
      if (drag.view === 'turn') { az = (az - dx * 0.4 + 360) % 360; el = Math.min(89, Math.max(4, el + dy * 0.3)); }
      else {
        const c = cam(), k = dist() / (0.9 * Math.min(w, h)), fg = [c.eye[0] - target[0], c.eye[1] - target[1]], n = Math.hypot(...fg) || 1;
        const right = [-fg[1] / n, fg[0] / n];   // the camera's right on the ground
        target = [target[0] - dx * k * right[0] - dy * k * fg[0] / n, target[1] - dx * k * right[1] - dy * k * fg[1] / n, target[2]];
      }
      return;
    }
    lastMove = m;
    if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; if (drag && lastMove) dragTo(lastMove); }); }
  }
  // the item as the handle being dragged makes it
  function dragTo(m) {
    const { g, k } = drag, p = P();
    let q;
    if (tool === 'move') {
      const t = snapTo(along(m, drag.o, drag.d), 0.5);
      q = moveItem(g, p, k === 0 ? t : 0, k === 1 ? t : 0, k === 2 ? t : 0);
    } else if (tool === 'turn') {
      const a = Math.atan2(m[1] - drag.c0[1], m[0] - drag.c0[0]);
      let d = a - drag.last;
      d = ((d + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      drag.last = a;
      if (k === 2) { drag.turn += d * 180 / Math.PI; q = turnItem(g, p, snapTo(drag.turn, 5)); }
      else {   // about the east or north axis: the ground slope (right-handed turns; seen from the axis's tip they run anticlockwise)
        const c = cam(), toward = drag.d[0] * (c.eye[0] - drag.o[0]) + drag.d[1] * (c.eye[1] - drag.o[1]) + drag.d[2] * (c.eye[2] - drag.o[2]) > 0 ? -1 : 1;
        drag.turn += toward * d * 180 / Math.PI;
        const t = Math.max(-45, Math.min(45, snapTo(drag.turn, 1)));
        q = withSlope(g, drag.t0[0] + (k === 0 ? t : 0), drag.t0[1] + (k === 1 ? t : 0));
      }
    } else {
      const t = along(m, drag.o, drag.d) * (k === 2 ? 1 : 2);
      q = resizeItem(g, p, k, snapTo(Math.max(0.5, drag.s0[k] + t), 0.5));
    }
    preview = { k: sel, q };
  }
  function up(e) {
    const d = drag;
    drag = null;
    interacting = false;
    if (d && d.view && !d.moved && e.button === 0) { pick(...pos(e)); return; }
    if (d && d.k != null) {
      const p = preview;
      preview = null;
      dragK = null;
      if (p && updateItem(p.k, p.q) && p.q.type === 'site' && !lay.auto) run();
    }
  }
  function cancel() { drag = null; preview = null; dragK = null; interacting = false; }

  // what a click hit: an item to select (a table selects its PV area and says what it is), a station, or nothing
  function pick(x, y) {
    const f = scene && pickFace(scene, cam(), x, y);
    picked = null;
    if (!f) { select(null); return; }
    if (f.st != null) { const s = (P().layout.stations || [])[f.st]; picked = s ? { title: kindName(s.kind) + (s.name ? ': ' + s.name : '') } : null; select(null); return; }
    select(f.it >= 0 ? f.it : null);
    if (f.kind !== 'table') return;
    const out = { title: `Table ${f.i + 1}` }, j = blocks ? blocks.tableNode[f.i] : -1;
    if (j >= 0) {
      const node = blocks.nodes[j];
      out.block = (node.name || (blocks.mode === 'string' ? 'Inverter ' : 'PV station ') + (j + 1));
      const D = design(), x = D && D.blocks && D.blocks.list[j];
      out.cable = blocks.blocks[j].n ? blocks.blocks[j].dcSum / blocks.blocks[j].n : null;
      if (x) { out.loss = x.loss; out.dv = x.dvDc; }
      out.colour = colours[j];
    }
    const sh = LE.shade;
    if (sh && sh.tables.length === scene.centres.length) out.shade = sh.tables[f.i];
    picked = out;
  }
  const wheel = (e) => { e.preventDefault(); zoom = Math.min(40, Math.max(0.3, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); };
  const key = (e) => {
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 5], ArrowDown: [0, -5] }[e.key];
    if (step) { e.preventDefault(); az = (az + step[0] + 360) % 360; el = Math.min(89, Math.max(4, el + step[1])); }
    if (e.key === '+' || e.key === '=') zoom = Math.min(40, zoom * 1.15);
    if (e.key === '-') zoom = Math.max(0.3, zoom / 1.15);
    const t = { w: 'move', e: 'turn', r: 'size' }[e.key.toLowerCase()];
    if (t && !e.metaKey && !e.ctrlKey) tool = t;
    if (e.key === 'Escape') { if (drag || preview) cancel(); else select(null); }
  };
  // the view as it is now, as a figure of the report's PV section
  async function toReport() {
    if (!canvas) return;
    const blob = await new Promise((ok) => { try { canvas.toBlob(ok, 'image/png'); } catch { ok(null); } });
    if (!blob) { toast('The 3D view could not be copied.', true); return; }
    const when = `21 ${MONTHS[month]}, ${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')} solar time`;
    await addFigures([new File([blob], '3d-layout.png', { type: 'image/png' })], 'pv', `3D view of the layout and its shadows, ${when}.${mapShown ? ' ' + GROUND_CREDIT + '.' : ''}`);
    toast('Added to the report (PV section). The Figures card on the Report page lists it.');
  }
  const reset = () => { target = fit ? [...fit.c] : [0, 0, 0]; zoom = 1; az = 200; el = 35; };
  // framed on the project when it opens, for another project, and when the layout's size changes a lot (items moved in from
  // far away, a new site); never while an item is dragged. The wheel and the keys zoom from there.
  let framed = null;
  $effect(() => {
    const f = fit, id = P().id || '';
    if (!f || dragK != null) return;
    const was = untrack(() => framed);
    if (!was || was.id !== id || f.r > was.r * 4 || f.r < was.r / 4) { framed = { id, r: f.r }; untrack(() => { target = [...f.c]; zoom = 1; }); }
  });

  onMount(() => {
    // the canvases fill their box (web/style.css, .view3d) without sizing it, so this never feeds back into itself
    const ro = new ResizeObserver(() => { if (shown) { w = Math.max(200, wrap.clientWidth); h = Math.max(240, wrap.clientHeight); } });
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
  onDestroy(() => { clearInterval(timer); cancel(); });
</script>

<div class="view3d" bind:this={wrap}>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
  <canvas bind:this={over} class="view3d-over" tabindex="0"
    aria-label="3D view: drag or use the arrow keys to turn it, shift-drag to pan, the wheel or + and - to zoom; click an item to select it, then W, E or R to move, turn or size it"
    onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={cancel} onwheel={wheel} onkeydown={key} oncontextmenu={(e) => e.preventDefault()}></canvas>
  {#if sel != null}
    <div class="view3d-tools seg">
      {#each [['move', 'Move', 'W'], ['turn', 'Turn', 'E'], ['size', 'Size', 'R']] as [t, label, key] (t)}
        <button type="button" class:on={tool === t} aria-pressed={tool === t} title="{label} ({key})" onclick={() => (tool = t)}>{label}</button>
      {/each}
      <label class="inline"><input type="checkbox" bind:checked={snap}> snap</label>
    </div>
  {/if}
  <div class="view3d-bar">
    <button type="button" class="btn small ghost" aria-pressed={playing} aria-label={playing ? 'Pause the day' : 'Play the day'} onclick={play}>{playing ? '❚❚' : '▶'}</button>
    <select bind:value={month} aria-label="Month (the 21st)">{#each MONTHS as m, i (m)}<option value={i}>21 {m}</option>{/each}</select>
    <input type="range" min="5" max="19" step="0.25" bind:value={hour} aria-label="Solar hour">
    <span class="view3d-time">{fmtNum(Math.floor(hour), 0)}:{String(Math.round((hour % 1) * 60)).padStart(2, '0')}</span>
    <span class="hint">{sun.el > 0 ? `sun ${fmtNum(sun.el, 0)}° up, ${fmtNum(sun.az, 0)}° from north` : 'sun down'}</span>
    <span class="spacer"></span>
    {#if gpu}<span class="tag" title="Drawn on the GPU">{gpu}</span>{/if}
    <button type="button" class="btn small ghost" title="Back to the whole site" onclick={reset}>Reset view</button>
    <button type="button" class="btn small ghost" title="Put this view in the report's PV section, as it is now (the Figures card on the Report page lists it)" onclick={toReport}>Add to report</button>
    <button type="button" class="btn small ghost" aria-expanded={opts} onclick={() => (opts = !opts)}>View ▾</button>
    {#if opts}
      <div class="view3d-opts">
        <label>Tables <select bind:value={colour}><option value="plain">one colour</option><option value="block" disabled={!blocks}>by inverter block</option><option value="shade" disabled={!LE.shade}>by shade</option></select></label>
        <label class="inline"><input type="checkbox" bind:checked={struts}> mounting structures</label>
        <label class="inline"><input type="checkbox" bind:checked={cables}> cable routes</label>
        <label class="inline"><input type="checkbox" bind:checked={mapOn}> Map underneath</label>
        {#if mapOn && gErr && gpu}<span class="hint">The graphics card could not take the satellite image.</span>
        {:else if mapOn && groundNote}<span class="hint">{groundNote}</span>{/if}
      </div>
    {/if}
  </div>
  {#if mapShown && scene}<span class="view3d-credit">{GROUND_CREDIT}</span>{/if}
  {#if picked}
    <div class="view3d-pick" class:below={mapShown && scene}>{#if picked.colour}<i style:background={picked.colour}></i>{/if}<b>{picked.title}</b>
      {#if picked.block} · {picked.block}{/if}{#if picked.cable != null} · string cables {fmtNum(picked.cable, 0)} m average in the block{/if}
      {#if picked.loss != null} · block loss {fmtPct(picked.loss, 2)}{/if}{#if picked.dv != null}, ΔV {fmtNum(picked.dv * 100, 2)} %{/if}
      {#if picked.shade != null} · shade {fmtPct(picked.shade, 1)}{/if}</div>
  {/if}
  {#if !scene}<p class="view3d-empty hint">Draw PV areas, buildings or trees on the layout map first.</p>{/if}
</div>
