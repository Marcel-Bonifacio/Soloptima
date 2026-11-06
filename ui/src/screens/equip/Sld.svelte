<!-- The single-line diagram: drawn from the design as parsed SVG elements, zoom with the wheel, pan by dragging, double-click resets -->
<script>
  import { cleanSvg } from '../../lib/report/svg-node.js';
  import { SLD_W as W, SLD_H as H } from '../../lib/equip/sld.js';
  import { el, sldText, exportSvg, exportPng, design } from '../../lib/equip/electrical.svelte.js';

  let box = $state(null), view = { x: 0, y: 0, w: W, h: H }, drag = null;
  const text = $derived.by(() => { design(); return sldText(el.cables); });
  const svg = () => box && box.querySelector('svg');
  const show = () => { const s = svg(); if (s) s.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`); };

  // the drawing as parsed elements; when the design changes it is replaced and the zoom and pan are kept
  function draw(node, t) {
    const put = (txt) => {
      const root = cleanSvg(txt);
      node.replaceChildren(...(root ? [document.importNode(root, true)] : []));
      const s = node.querySelector('svg');
      if (s) { s.removeAttribute('width'); s.removeAttribute('height'); s.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`); }
    };
    put(t);
    return { update: put };
  }

  function wheel(e) {
    const s = svg();
    if (!s) return;
    e.preventDefault();
    const r = s.getBoundingClientRect(), k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const mx = view.x + (e.clientX - r.left) / r.width * view.w, my = view.y + (e.clientY - r.top) / r.height * view.h;
    view.w = Math.min(W * 1.5, Math.max(200, view.w * k)); view.h = view.w * H / W;
    view.x = mx - (e.clientX - r.left) / r.width * view.w; view.y = my - (e.clientY - r.top) / r.height * view.h;
    show();
  }
  function move(e) {
    const s = svg();
    if (!drag || !s) return;
    const r = s.getBoundingClientRect();
    view.x = drag.vx - (e.clientX - drag.x) / r.width * view.w; view.y = drag.vy - (e.clientY - drag.y) / r.height * view.h;
    show();
  }
  const attachWheel = (node) => { node.addEventListener('wheel', wheel, { passive: false }); return { destroy: () => node.removeEventListener('wheel', wheel) }; };
</script>

<svelte:window onmouseup={() => (drag = null)} />

<div class="card">
  <div class="row space"><h3>Single-line diagram</h3>
    <div class="row gap">
      <label class="hint inline"><input type="checkbox" bind:checked={el.cables}> cable data</label>
      <button class="btn small ghost" onclick={exportSvg}>Export SVG</button><button class="btn small ghost" onclick={exportPng}>Export PNG</button>
    </div>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sld-wrap" bind:this={box} use:draw={text} use:attachWheel
    onmousedown={(e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; }} onmousemove={move}
    ondblclick={() => { view = { x: 0, y: 0, w: W, h: H }; show(); }}></div>
</div>
