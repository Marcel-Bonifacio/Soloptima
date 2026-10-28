// Single-line diagram (SLD) generator: A3 landscape drawing sheet with IEC-style symbols, ratings, cable
// schedule labels, protection tags, notes and a title block. Built from the electrical design result.
'use strict';

const SLD = (() => {
  const W = 1680, H = 1188;               // A3 landscape, 4 px per mm
  let svgText = '', view = { x: 0, y: 0, w: W, h: H }, drag = null;
  window.addEventListener('mouseup', () => (drag = null));

  // ---------------------------------------------------------------- primitives (black on white, like a drawing)
  const ln = (x1, y1, x2, y2, w = 1.6, dash) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  const tx = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 11}" font-weight="${o.bold ? 700 : 400}" text-anchor="${o.anchor || 'start'}" fill="${o.color || '#111'}"${o.rot ? ` transform="rotate(${o.rot} ${x} ${y})"` : ''}>${escapeHtml(s)}</text>`;
  const multi = (x, y, lines, o = {}) => lines.filter(Boolean).map((l, i) => tx(x, y + i * ((o.size || 11) + 3), l, { ...o, bold: o.boldFirst && i === 0 })).join('');
  const sym = (title, body) => `<g class="sym"><title>${escapeHtml(title)}</title>${body}</g>`;

  // IEC 60617-style circuit breaker: switch blade with an "x" on the fixed contact, inside a frame.
  const cb = (x, y, tag) => sym(`Circuit breaker ${tag || ''}`, `${ln(x, y - 16, x, y - 8)}<rect x="${x - 9}" y="${y - 8}" width="18" height="18" fill="#fff" stroke="#111" stroke-width="1.6"/>` +
    `${ln(x - 5, y - 4, x + 5, y + 6, 1.4)}${ln(x + 5, y - 4, x - 5, y + 6, 1.4)}${ln(x, y + 10, x, y + 18)}` + (tag ? tx(x + 14, y + 5, tag, { size: 10 }) : ''));
  const disc = (x, y, tag) => sym(`Disconnector ${tag || ''}`, `${ln(x, y - 14, x, y - 6)}${ln(x - 4, y - 6, x + 4, y - 6, 1.6)}${ln(x, y + 8, x - 9, y - 4, 1.6)}${ln(x, y + 8, x, y + 16)}<circle cx="${x}" cy="${y + 8}" r="1.8" fill="#111"/>`);
  const ct = (x, y) => sym('Current transformer', `<circle cx="${x}" cy="${y}" r="7" fill="none" stroke="#111" stroke-width="1.3"/>${ln(x - 13, y, x - 7, y, 1.2)}`);
  const relay = (x, y, codes) => sym(`Protection relay ${codes}`, `<rect x="${x}" y="${y - 9}" width="${codes.length * 6 + 10}" height="18" rx="2" fill="#fff" stroke="#111" stroke-width="1.1"/>` + tx(x + 5, y + 4, codes, { size: 9 }) + ln(x - 14, y, x, y, 1, '3 2'));
  const trafo = (x, y, info) => sym(info.join(' · '), `<circle cx="${x}" cy="${y - 12}" r="16" fill="none" stroke="#111" stroke-width="1.6"/><circle cx="${x}" cy="${y + 12}" r="16" fill="none" stroke="#111" stroke-width="1.6"/>` +
    ln(x, y - 46, x, y - 28) + ln(x, y + 28, x, y + 46));
  const gen = (x, y, info) => sym(info.join(' · '), `<circle cx="${x}" cy="${y}" r="22" fill="#fff" stroke="#111" stroke-width="1.8"/>` + tx(x, y + 1, 'G', { size: 16, bold: true, anchor: 'middle' }) +
    `<path d="M ${x - 8} ${y + 11} q 4 -6 8 0 t 8 0" fill="none" stroke="#111" stroke-width="1.3"/>`);
  const inverter = (x, y, info) => sym(info.join(' · '), `<rect x="${x - 20}" y="${y - 20}" width="40" height="40" fill="#fff" stroke="#111" stroke-width="1.6"/>${ln(x - 20, y + 20, x + 20, y - 20, 1.2)}` +
    tx(x - 15, y - 6, '=', { size: 13 }) + `<path d="M ${x + 3} ${y + 12} q 3 -5 6 0 t 6 0" fill="none" stroke="#111" stroke-width="1.3"/>`);
  const pvArr = (x, y, info) => sym(info.join(' · '), `<rect x="${x - 26}" y="${y - 16}" width="52" height="32" fill="#fff" stroke="#111" stroke-width="1.6"/>${ln(x - 26, y + 16, x + 26, y - 16, 1.1)}` +
    `${ln(x - 9, y - 16, x - 9, y + 16, 0.8)}${ln(x + 9, y - 16, x + 9, y + 16, 0.8)}${ln(x - 26, y, x + 26, y, 0.8)}` +
    `${ln(x + 30, y - 30, x + 20, y - 20, 1.1)}<path d="M ${x + 20} ${y - 20} l 6 -1 l -5 -5 z" fill="#111"/>${ln(x + 40, y - 24, x + 30, y - 14, 1.1)}<path d="M ${x + 30} ${y - 14} l 6 -1 l -5 -5 z" fill="#111"/>`);
  const battery = (x, y, info) => sym(info.join(' · '), [0, 1, 2].map((i) => ln(x - 18, y - 12 + i * 10, x + 18, y - 12 + i * 10, 2) + ln(x - 9, y - 7 + i * 10, x + 9, y - 7 + i * 10, 3.2)).join('') +
    `<rect x="${x - 26}" y="${y - 20}" width="52" height="42" fill="none" stroke="#111" stroke-width="1.1" stroke-dasharray="4 3"/>` + tx(x - 30, y - 10, '+', { size: 11, anchor: 'end' }));
  const loadSym = (x, y, info) => sym(info.join(' · '), `${ln(x, y - 30, x, y)}<path d="M ${x - 12} ${y} L ${x + 12} ${y} L ${x} ${y + 20} Z" fill="#111"/>`);
  const meter = (x, y) => sym('Energy meter', `<circle cx="${x + 26}" cy="${y}" r="10" fill="#fff" stroke="#111" stroke-width="1.2"/>` + tx(x + 26, y + 4, 'kWh', { size: 7, anchor: 'middle' }) + ln(x, y, x + 16, y, 1, '3 2'));
  const badge = (x, y, s) => `<g><rect x="${x}" y="${y - 11}" width="${s.length * 7 + 10}" height="18" rx="9" fill="#111"/>${tx(x + 5, y + 2, s, { size: 10, bold: true, color: '#fff' })}</g>`;
  const cableLbl = (x, y1, y2, s, show) => ln(x, y1, x, y2) + (show && s ? tx(x - 8, (y1 + y2) / 2, s, { size: 9, anchor: 'middle', rot: -90 }) : '');

  // ---------------------------------------------------------------- drawing
  function build(D, P, showCables) {
    const E = P.electrical, cur = P.econ.currency;
    const cabTxt = (key) => {
      const c = D.circuits.find((x) => x.key === key);
      if (!c || !c.cab) return '';
      return `${c.runs > 1 ? c.runs + '× ' : ''}${c.cab.name.replace(/,.*$/, '')}, ${fmtNum(c.L)} m`;
    };
    const cols = [];
    const peak = P.load.kw ? maxOf(P.load.kw) : 0;
    if (peak > 0) cols.push({ type: 'load' });
    const nGenFeeders = E.gen_mv ? D.nG : D.nTrG;
    const repeat = (n, make) => {
      if (n <= 0) return;
      if (n <= 3) for (let i = 1; i <= n; i++) cols.push(make(i, n));
      else { cols.push(make(1, n)); cols.push({ type: 'dots', n }); cols.push(make(n, n)); }
    };
    repeat(nGenFeeders, (i, n) => ({ type: 'gen', i, n }));
    const pvFeeder = D.circuits.find((c) => c.key === 'mv_pv');
    const nFeed = pvFeeder ? pvFeeder.count : (D.nTrPV ? 1 : 0);
    repeat(nFeed, (i, n) => ({ type: 'pv', i, n }));
    if (P.bess.energy_kwh > 0 && P.bess.power_kw > 0) cols.push({ type: 'bess' });

    const x0 = 120, x1 = W - 90, span = x1 - x0;
    const step = cols.length > 1 ? span / cols.length : span;
    const busY = 200;
    let g = '';
    // frame & zones
    g += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;
    g += `<rect x="20" y="20" width="${W - 40}" height="${H - 40}" fill="none" stroke="#111" stroke-width="2.2"/>`;
    g += `<rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="#111" stroke-width="0.8"/>`;
    for (let i = 0; i < 8; i++) g += tx(30 + (W - 60) * (i + 0.5) / 8, 27, String(i + 1), { size: 9, anchor: 'middle' });
    // busbar
    const bx1 = x0 - 40, bx2 = x0 + step * cols.length - 40;
    g += `<line x1="${bx1}" y1="${busY}" x2="${Math.max(bx2, bx1 + 200)}" y2="${busY}" stroke="#111" stroke-width="6"/>`;
    g += multi(bx1, busY - 48, [`MV MAIN SWITCHBOARD  ${E.mv_kv} kV, 3-PHASE, 50 Hz`, `Single busbar · ${cols.filter((c) => c.type !== 'dots').length} feeders shown`], { size: 12, boldFirst: true });
    g += tx(bx1, busY - 12, 'MV-BUS-01', { size: 10 });

    cols.forEach((c, idx) => {
      const x = x0 + step * idx + step / 2 - 40;
      if (c.type === 'dots') {
        g += tx(x, busY + 120, '• • •', { size: 22, anchor: 'middle', bold: true }) + tx(x, busY + 150, `${c.n - 2} identical feeders`, { size: 10, anchor: 'middle' }) + tx(x, busY + 164, 'not drawn', { size: 10, anchor: 'middle' });
        return;
      }
      // common MV feeder head: disconnector, breaker, CT, relay
      g += ln(x, busY, x, busY + 18) + disc(x, busY + 32) + cb(x, busY + 74, `Q${idx + 1}`);
      g += ln(x, busY + 92, x, busY + 112) + ct(x, busY + 118) + relay(x + 20, busY + 118, c.type === 'load' ? '50/51 50N/51N 27/59' : c.type === 'gen' ? '50/51 87T 32 46' : '50/51 50N/51N 87T');
      const yC = busY + 125;
      if (c.type === 'load') {
        const trL = Equipment.find('transformer', E.trafo_load);
        g += cableLbl(x, yC, yC + 150, cabTxt('load'), showCables) + meter(x, yC + 60);
        let y = yC + 150;
        if (trL) { g += trafo(x, y + 46, [trL.name]) + multi(x + 26, y + 34, [`T-LOAD  ${fmtNum(trL.kva)} kVA`, `${trL.hv_kv}/${trL.lv_kv} kV ${trL.vector || ''}`, `Z = ${trL.z} %`], { size: 10 }); y += 92; }
        g += loadSym(x, y + 30, ['Plant load']) + multi(x - 60, y + 72, [P.name ? 'PLANT LOAD' : 'LOAD', `Peak ${fmtPower(peak)}`, `Annual ${fmtEnergy(sum(P.load.kw))}`, `PF ${E.pf_load}`], { size: 10, boldFirst: true });
      }
      if (c.type === 'gen') {
        const dg = Equipment.selected('genset');
        const trG = Equipment.find('transformer', E.trafo_gen);
        g += cableLbl(x, yC, yC + 120, cabTxt('mv_gen'), showCables);
        let y = yC + 120;
        if (!E.gen_mv && trG) {
          g += trafo(x, y + 46, [trG.name]) + multi(x + 26, y + 30, [`T-G${c.i}  ${fmtNum(trG.kva)} kVA`, `${trG.hv_kv}/${trG.lv_kv} kV ${trG.vector || ''}`, `Z = ${trG.z} %`], { size: 10 });
          y += 92;
          g += cb(x, y + 22, 'ACB') + cableLbl(x, y + 40, y + 120, cabTxt('lv_gen'), showCables);
          y += 120;
        }
        g += ln(x, y, x, y + 8) + gen(x, y + 30, [dg ? dg.name : 'Diesel generator']);
        if (D.gpt > 1 && !E.gen_mv) g += badge(x + 26, y + 12, `×${D.gpt} per transformer`);
        g += multi(x - 60, y + 72, [`G${c.i}${D.gpt > 1 && !E.gen_mv ? ' (group)' : ''}`, `${fmtNum(P.diesel.unit_kw)} kWe prime`, `${fmtNum(D.gKva)} kVA, ${dg ? dg.voltage : 400} V`, dg ? `PF ${dg.pf}` : ''], { size: 10, boldFirst: true });
        if (c.i === 1) g += badge(x + 14, yC + 46, `${D.nG} gensets total`);
      }
      if (c.type === 'pv') {
        const s = D.str, trPV = Equipment.find('transformer', E.trafo_pv);
        const trPerFeed = pvFeeder ? D.nTrPV / pvFeeder.count : D.nTrPV;
        g += cableLbl(x, yC, yC + 120, cabTxt('mv_pv'), showCables);
        let y = yC + 120;
        if (trPV) {
          g += trafo(x, y + 46, [trPV.name]) + multi(x + 26, y + 26, [`T-PV  ${fmtNum(trPV.kva)} kVA`, `${trPV.hv_kv}/${trPV.lv_kv} kV ${trPV.vector || ''}`, `Z = ${trPV.z} %`], { size: 10 });
          if (trPerFeed > 1) g += badge(x - 92, y + 46, `×${fmtNum(trPerFeed, trPerFeed % 1 ? 1 : 0)} on feeder`);
          y += 92;
        }
        g += cb(x, y + 22, 'ACB') + cableLbl(x, y + 40, y + 110, cabTxt('lv_pv'), showCables);
        y += 110;
        if (s) {
          g += ln(x, y, x, y + 10) + inverter(x, y + 30, [s.inv.name]) + badge(x + 26, y + 12, `×${D.invPerTr} per transformer`);
          g += multi(x + 26, y + 34, [`INV  ${fmtNum(s.inv.pac_kw)} kW`, `${s.inv.vac} V AC / ${s.inv.vdc_max} V DC`], { size: 10 });
          y += 50;
          g += cableLbl(x, y, y + 70, cabTxt('dc'), showCables);
          y += 70;
          g += pvArr(x, y + 18, [s.pv.name]) + multi(x - 60, y + 54, [`PV ARRAY (per inverter)`, `${fmtNum(s.spi, 1)} strings × ${s.ns} modules`, `${fmtNum(s.pv.pmax)} Wp ${s.pv.name.replace(/^Generic\s*/, '').split('(')[0]}`, `${fmtNum(s.kwp / s.nInv, 1)} kWp per inverter`], { size: 10, boldFirst: true });
          if (c.i === 1) g += badge(x + 14, yC + 46, `PV ${fmtNum(s.kwp / 1000, 2)} MWp · ${s.nInv} inverters`);
        }
      }
      if (c.type === 'bess') {
        const bat = Equipment.selected('battery'), trB = Equipment.find('transformer', E.trafo_bess);
        g += cableLbl(x, yC, yC + 120, cabTxt('mv_bess'), showCables);
        let y = yC + 120;
        if (trB) {
          g += trafo(x, y + 46, [trB.name]) + multi(x + 26, y + 26, [`T-BESS  ${fmtNum(trB.kva)} kVA`, `${trB.hv_kv}/${trB.lv_kv} kV ${trB.vector || ''}`, `Z = ${trB.z} %`], { size: 10 });
          if (D.nTrB > 1) g += badge(x - 70, y + 46, `×${D.nTrB}`);
          y += 92;
        }
        g += cb(x, y + 22, 'ACB') + cableLbl(x, y + 40, y + 110, cabTxt('lv_bess'), showCables);
        y += 110;
        g += ln(x, y, x, y + 10) + inverter(x, y + 30, ['Power conversion system']) + badge(x + 26, y + 12, `PCS ×${D.nB}`);
        y += 50;
        g += ln(x, y, x, y + 40, 1.6) + battery(x, y + 62, [bat ? bat.name : 'Battery']);
        g += multi(x - 60, y + 104, ['BESS', `${fmtNum(P.bess.energy_kwh)} kWh / ${fmtNum(P.bess.power_kw)} kW`, bat ? `${bat.chemistry || ''} ${bat.vdc ? bat.vdc + ' V DC' : ''}` : '', `RTE ${fmtPct(P.bess.rte, 0)}`], { size: 10, boldFirst: true });
      }
    });

    // notes, legend, title block
    const ny = H - 200;
    g += `<rect x="40" y="${ny}" width="620" height="160" fill="none" stroke="#111" stroke-width="0.8"/>`;
    g += multi(50, ny + 18, ['NOTES',
      '1. Ratings from the project equipment datasheets. Entries marked "Generic" are typical values, not manufacturer data.',
      '2. Cable sizes from the electrical design: current rating with derating ' + E.derate + ', voltage drop limits DC ' + E.dv_dc + ' % / LV ' + E.dv_lv + ' % / MV ' + E.dv_mv + ' %.',
      '3. Identical feeders are drawn once; badges (×n) give the number of identical items.',
      '4. Protection functions are indicative (ANSI codes). Earthing, auxiliary supplies and SCADA not shown.',
      `5. Diesel strategy: ${{ load_following: 'load following', cycle_charging: 'cycle charging', predictive: 'predictive EMS (forecast-based)' }[P.diesel.strategy]}; spinning reserve ${fmtPct(P.diesel.reserve_load, 0)} of load + ${fmtPct(P.diesel.reserve_pv, 0)} of PV and wind.`,
      `6. Cables and transformers (design estimate): ${fmtMoney(D.cost, cur)}.`], { size: 10, boldFirst: true });
    const lx = 680;
    g += `<rect x="${lx}" y="${ny}" width="450" height="160" fill="none" stroke="#111" stroke-width="0.8"/>` + tx(lx + 10, ny + 18, 'LEGEND', { size: 10, bold: true });
    const leg = [[cb(lx + 30, ny + 50, ''), 'Circuit breaker'], [disc(lx + 30, ny + 100, ''), 'Disconnector'], [trafo(lx + 150, ny + 75, ['']), 'Transformer'],
      [gen(lx + 270, ny + 70, ['']), 'Generator'], [inverter(lx + 370, ny + 70, ['']), 'Inverter / PCS']];
    leg.forEach(([s, l], i) => { g += s; g += tx([lx + 45, lx + 45, lx + 175, lx + 250, lx + 345][i], [ny + 55, ny + 110, ny + 140, ny + 120, ny + 120][i], l, { size: 9 }); });
    const tbx = W - 520, tby = H - 200;
    const date = new Date().toISOString().slice(0, 10);
    g += `<rect x="${tbx}" y="${tby}" width="480" height="160" fill="#fff" stroke="#111" stroke-width="1.6"/>`;
    const rowsTB = [['PROJECT', P.name || '–'], ['DRAWING', 'SINGLE LINE DIAGRAM: PV / BESS / DIESEL HYBRID PLANT'], ['LOCATION', `${(+P.location.lat).toFixed(5)}, ${(+P.location.lon).toFixed(5)}`],
      ['DWG NO.', 'SOL-E-SLD-001'], ['REV / DATE', `A  ·  ${date}`], ['SCALE / SHEET', 'NTS  ·  A3  ·  1 of 1'], ['PREPARED WITH', 'Soloptima (feasibility only, not for construction)']];
    rowsTB.forEach(([k, v], i) => {
      const y = tby + 22 * (i + 1) - 4;
      if (i) g += ln(tbx, tby + 22 * i, tbx + 480, tby + 22 * i, 0.6);
      g += tx(tbx + 8, y, k, { size: 9, bold: true }) + tx(tbx + 120, y, v.length > 58 ? v.slice(0, 57) + '…' : v, { size: 10, bold: i === 1 });
    });
    g += ln(tbx + 112, tby, tbx + 112, tby + 154, 0.6);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif">${g}</svg>`;
  }

  function render(D, P) {
    if (!D) return;
    const box = $('#sld');
    svgText = build(D, P, $('#sldCables').checked);
    box.innerHTML = svgText;
    const svg = box.querySelector('svg');
    svg.removeAttribute('width'); svg.removeAttribute('height');
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    // wheel zoom + drag pan
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect(), k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const mx = view.x + (e.clientX - r.left) / r.width * view.w, my = view.y + (e.clientY - r.top) / r.height * view.h;
      view.w = Math.min(W * 1.5, Math.max(200, view.w * k)); view.h = view.w * H / W;
      view.x = mx - (e.clientX - r.left) / r.width * view.w; view.y = my - (e.clientY - r.top) / r.height * view.h;
      svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    }, { passive: false });
    svg.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; });
    svg.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const r = svg.getBoundingClientRect();
      view.x = drag.vx - (e.clientX - drag.x) / r.width * view.w; view.y = drag.vy - (e.clientY - drag.y) / r.height * view.h;
      svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    });
    svg.addEventListener('dblclick', () => { view = { x: 0, y: 0, w: W, h: H }; svg.setAttribute('viewBox', `0 0 ${W} ${H}`); });
  }
  const fileBase = () => ((P && P.name) || 'project').replace(/[^\w\- ]+/g, '_');
  function exportSvg() { if (svgText) download(fileBase() + '_SLD.svg', svgText, 'image/svg+xml'); }
  function toPng(scale = 2) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = W * scale; c.height = H * scale;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/png'));
      };
      img.onerror = rej;
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
    });
  }
  async function exportPng() {
    if (!svgText) return;
    const url = await toPng();
    const a = document.createElement('a'); a.href = url; a.download = fileBase() + '_SLD.png'; a.click();
  }
  return { render, exportSvg, exportPng, get svg() { return svgText; } };
})();
