// The sun path chart as plain data: sun position, the horizon profiles and the traces (no DOM).
import { fmtNum } from './format.js';
import { MONTHS } from './series.js';

// Sun elevation and azimuth (deg, azimuth from north clockwise) at a latitude, declination and hour angle (deg).
// web/js/layout.js keeps its own copy for the row-spacing calculation.
export function sunAt(lat, decl, ha) {
  const r = Math.PI / 180;
  const el = Math.asin(Math.max(-1, Math.min(1, Math.sin(lat * r) * Math.sin(decl * r) + Math.cos(lat * r) * Math.cos(decl * r) * Math.cos(ha * r)))) / r;
  const az = Math.atan2(Math.sin(ha * r), Math.cos(ha * r) * Math.sin(lat * r) - Math.tan(decl * r) * Math.cos(lat * r)) / r + 180;
  return { el, az: (az + 360) % 360 };
}

const DAY21 = [20, 51, 79, 110, 140, 171, 201, 232, 263, 293, 324, 354];

// A profile h at equal azimuth steps from north, linear between them, sampled every 2 deg across the chart
export function profileXY(h, south) {
  const n = h.length, xs = [], ys = [];
  for (let x = south ? -180 : 0; x <= (south ? 180 : 360); x += 2) {
    const k = ((x % 360) + 360) % 360 * n / 360, i = Math.floor(k) % n;
    xs.push(x);
    ys.push(h[i] + (k - Math.floor(k)) * (h[(i + 1) % n] - h[i]));
  }
  return { xs, ys };
}

// Sun paths on the 21st of each month (solar time) over the terrain horizon (pv.horizon) and the near horizon of the objects as
// the tables see it (shade.median and shade.max), azimuths centred on the equator. Null without a latitude.
export function sunChart(lat, horizon, shade, c) {
  if (typeof lat !== 'number' || !isFinite(lat)) return null;
  const south = lat < 0, xOf = (az) => (south ? (az > 180 ? az - 360 : az) : az), traces = [];
  const profile = (h, name, colour, fill, dash) => {
    const { xs, ys } = profileXY(h, south);
    traces.push({ x: xs, y: ys, name, type: 'scatter', mode: 'lines', line: { color: colour, width: 1, dash }, fill: fill ? 'tozeroy' : 'none', fillcolor: fill, hoverinfo: 'skip' });
  };
  if (Array.isArray(horizon) && horizon.length) profile(horizon, 'Terrain horizon', c.muted, 'rgba(128,128,128,0.35)');
  if (shade && shade.median && shade.median.length) {
    profile(shade.median, 'Buildings and trees (median table)', '#8a5a2b', 'rgba(138,90,43,0.35)');
    profile(shade.max, 'Buildings and trees (most shaded table)', '#8a5a2b', null, 'dot');
  }
  [11, 0, 1, 2, 3, 4, 5].forEach((m) => {
    const decl = 23.45 * Math.sin(2 * Math.PI * (284 + DAY21[m] + 1) / 365), xs = [], ys = [], tx = [];
    for (let ha = -180; ha <= 180; ha += 1) {
      const s = sunAt(lat, decl, ha);
      if (s.el <= 0) continue;
      const x = xOf(s.az);
      if (xs.length && Math.abs(x - xs[xs.length - 1]) > 180) { xs.push(null); ys.push(null); tx.push(''); }
      xs.push(x); ys.push(s.el); tx.push(`${MONTHS[m]}${m !== 11 && m !== 5 ? ' / ' + MONTHS[10 - m] : ''} 21 · ${fmtNum(12 + ha / 15, 1)} h solar time`);
    }
    traces.push({ x: xs, y: ys, text: tx, hoverinfo: 'text', type: 'scatter', mode: 'lines', name: m === 5 ? 'Sun path, 21st of the month' : '',
      showlegend: m === 5, line: { color: c.pv, width: m === 11 || m === 5 ? 2 : 1 } });
  });
  const ticks = south ? [-180, -90, 0, 90, 180] : [0, 90, 180, 270, 360];
  return { traces, layout: { margin: { l: 48, r: 10, t: 8, b: 36 }, showlegend: true,
    xaxis: { range: south ? [-180, 180] : [0, 360], tickvals: ticks, ticktext: ticks.map((t) => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N', '-90': 'W', '-180': 'S' })[t]) },
    yaxis: { range: [0, 90], title: { text: 'Elevation (°)' } } } };
}

// Waterfall-style loss diagram: irradiance steps (kWh/m²) then energy steps (kWh/kWp), as horizontal bars
export function lossChart(losses, c) {
  const rows = losses.map((s, i) => {
    const prev = i > 0 && losses[i - 1].irradiance === s.irradiance ? losses[i - 1].value : null;
    return { name: s.name, v: s.value, d: prev == null ? null : (s.value - prev) / prev, irr: s.irradiance };
  });
  const rev = (f) => rows.map(f).reverse();
  return {
    traces: [{ type: 'bar', orientation: 'h', y: rev((r) => r.name), x: rev((r) => r.v), marker: { color: rev((r) => (r.irr ? c.pv : c.gen)), cornerradius: 4 },
      text: rev((r) => fmtNum(r.v, 0) + (r.irr ? ' kWh/m²' : ' kWh/kWp') + (r.d == null ? '' : `  (${r.d >= 0 ? '+' : ''}${(r.d * 100).toFixed(1)} %)`)),
      textposition: 'auto', insidetextanchor: 'start', textfont: { color: c.text, size: 11 }, hovertemplate: '%{y}<br>%{text}<extra></extra>' }],
    layout: { xaxis: { title: { text: 'kWh/m² (irradiance) · kWh/kWp (energy)' } }, yaxis: { automargin: true }, margin: { l: 10, r: 10, t: 10, b: 40 }, showlegend: false },
  };
}
