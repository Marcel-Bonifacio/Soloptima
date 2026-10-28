// Plotly wrappers with a consistent look; colours come from the CSS variables in style.css. Series colours have a fixed
// meaning everywhere: PV = amber, battery = green, wind = dark green, diesel = blue, curtailed = pink, unmet = red, SOC = violet, load = ink.
'use strict';

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let colours = null;
const COL = () => colours || (colours = {
  pv: css('--c-pv'), bess: css('--c-bess'), gen: css('--c-gen'), curt: css('--c-curt'), unmet: css('--c-unmet'),
  soc: css('--c-soc'), wind: css('--c-wind'), load: css('--c-load'), text: css('--text'), text2: css('--text-2'), muted: css('--muted'),
  border: css('--border'), surface: css('--surface'), surface2: css('--surface-2'), accent: css('--accent'),
});
const PLOT_CFG = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'] };

function baseLayout(extra = {}) {
  const c = COL();
  const ax = { gridcolor: c.surface2, linecolor: c.border, zerolinecolor: c.border, tickfont: { color: c.text2, size: 11 },
               title: { font: { color: c.text2, size: 12 } }, automargin: true };
  const lay = {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: '-apple-system, BlinkMacSystemFont, Segoe UI, Inter, sans-serif', color: c.text, size: 12 },
    margin: { l: 56, r: 16, t: 10, b: 40 },
    legend: { orientation: 'h', y: -0.18, x: 0, font: { color: c.text2, size: 11 } },
    hoverlabel: { bgcolor: c.surface, bordercolor: c.border, font: { color: c.text } },
    xaxis: { ...ax }, yaxis: { ...ax },
    bargap: 0.25,
  };
  for (const [k, v] of Object.entries(extra)) {
    if (k.startsWith('xaxis') || k.startsWith('yaxis')) lay[k] = { ...ax, ...v, title: { ...ax.title, ...(v.title || {}) } };
    else lay[k] = v;
  }
  return lay;
}
function plot(id, traces, layout) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return;
  Plotly.react(el, traces, baseLayout(layout), PLOT_CFG);
}
function resizeVisibleCharts() { $$('.tab.active .chart').forEach((el) => { if (el.data) Plotly.Plots.resize(el); }); }

// marks: day indices (0-364) to outline, e.g. the days the data checks flagged; runs of days share one outline.
function heatmap(id, z, title, colorscale, unit, marks) {
  const c = COL(), shapes = [], d = [...new Set((marks || []).filter((x) => x >= 0 && x < 365))].sort((a, b) => a - b);
  for (let k = 0; k < d.length;) {
    let e = k;
    while (e + 1 < d.length && d[e + 1] === d[e] + 1) e++;
    shapes.push({ type: 'rect', xref: 'x', yref: 'y', x0: d[k] + 0.5, x1: d[e] + 1.5, y0: -0.5, y1: 23.5, line: { color: c.unmet, width: 1.5 }, fillcolor: 'rgba(0,0,0,0)' });
    k = e + 1;
  }
  plot(id, [{ type: 'heatmap', z, x: Array.from({ length: 365 }, (_, i) => i + 1), y: Array.from({ length: 24 }, (_, i) => i),
              colorscale: colorscale || [[0, c.surface2], [0.25, '#9ec5f4'], [0.6, '#3987e5'], [1, '#104281']],
              colorbar: { title: { text: unit || '', side: 'right' }, thickness: 12, tickfont: { color: c.text2 } },
              hovertemplate: 'day %{x}, %{y}:00<br>%{z:,.0f} ' + (unit || '') + '<extra></extra>' }],
       { xaxis: { title: { text: 'Day of year' } }, yaxis: { title: { text: 'Hour' }, dtick: 6 }, margin: { l: 56, r: 10, t: 10, b: 40 }, shapes });
}

function monthlyBars(id, series, ytitle) {
  plot(id, series.map((s) => ({ type: 'bar', name: s.name, x: MONTHS, y: s.y, marker: { color: s.color, cornerradius: 4 },
                                hovertemplate: '%{x}: %{y:,.1f} ' + (s.unit || '') + '<extra>' + s.name + '</extra>' })),
       { yaxis: { title: { text: ytitle } },
         showlegend: series.length > 1 });
}

// Stacked supply above zero, battery charging below zero, load line (site load dotted when there are auxiliaries); SOC and units in their own panels.
function dispatchChart(id, H, start, len, opts = {}) {
  const c = COL();
  const idx = Array.from({ length: len }, (_, i) => start + i);
  const x = idx;
  const pick = (a) => idx.map((h) => (a ? a[h] : 0));
  const ticks = []; const labels = [];
  for (let h = start; h < start + len; h += 24) { ticks.push(h); labels.push(dateOfHour(h)); }
  const area = (name, y, color, stack) => ({ type: 'scatter', mode: 'lines', name, x, y, stackgroup: stack, line: { width: 0.5, color, shape: 'hv' },
    fillcolor: color, hovertemplate: '%{y:,.0f} kW<extra>' + name + '</extra>' });
  const traces = [
    area('PV → load', pick(H.pv_to_load), c.pv, 'sup'),
    ...(H.wind_avail && H.wind_avail.some((x) => x > 0) ? [area('Wind → load', pick(H.wind_to_load), c.wind, 'sup'), area('Wind → battery', idx.map((h) => -H.wind_to_bess[h]), c.wind + '99', 'chg')] : []),
    area('Battery → load', pick(H.bess_dis), c.bess, 'sup'),
    area('Diesel → load', pick(H.gen_to_load), c.gen, 'sup'),
    area('Unmet', pick(H.unmet), c.unmet, 'sup'),
    area('PV → battery', idx.map((h) => -H.pv_to_bess[h]), c.pv + '99', 'chg'),
    area('Diesel → battery', idx.map((h) => -H.gen_to_bess[h]), c.gen + '99', 'chg'),
    { type: 'scatter', mode: 'lines', name: 'Load', x, y: pick(H.load), line: { color: c.load, width: 2, shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>Load</extra>' },
    // the load above includes the auxiliary load; the site load alone is dotted
    ...(H.aux && H.aux.some((a) => a > 0) ? [{ type: 'scatter', mode: 'lines', name: 'Site load', x, y: idx.map((h) => H.load[h] - H.aux[h]), line: { color: c.load, width: 1.5, dash: 'dot', shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>Site load</extra>' }] : []),
    { type: 'scatter', mode: 'lines', name: 'PV available', x, y: pick(H.pv_avail), line: { color: c.pv, width: 1.5, dash: 'dot', shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>PV available</extra>' },
    { type: 'scatter', mode: 'lines', name: 'Battery SOC', x, y: idx.map((h) => H.soc[h] * 100), yaxis: 'y2', line: { color: c.soc, width: 2 }, hovertemplate: '%{y:.0f} %<extra>SOC</extra>' },
    { type: 'scatter', mode: 'lines', name: 'Gensets online', x, y: pick(H.gen_units), yaxis: 'y3', line: { color: c.gen, width: 2, shape: 'hv' }, hovertemplate: '%{y} units<extra>Gensets online</extra>' },
  ];
  if (opts.socTarget && H.soc_target) traces.push({ type: 'scatter', mode: 'lines', name: 'EMS SOC target', x, y: idx.map((h) => H.soc_target[h] * 100), yaxis: 'y2', line: { color: c.soc, width: 1.5, dash: 'dash' }, hovertemplate: '%{y:.0f} %<extra>SOC target</extra>' });
  plot(id, traces, {
    hovermode: 'x unified', showlegend: true, legend: { orientation: 'h', y: -0.08, x: 0, font: { size: 11, color: c.text2 } },
    xaxis: { tickvals: ticks, ticktext: labels, range: [start, start + len - 1], anchor: 'y3' },
    yaxis: { title: { text: 'Power (kW)' }, domain: [0.42, 1] },
    yaxis2: { title: { text: 'SOC (%)' }, domain: [0.2, 0.37], range: [0, 100] },
    yaxis3: { title: { text: 'Units' }, domain: [0, 0.15], rangemode: 'tozero' },
    margin: { l: 64, r: 16, t: 10, b: 60 },
  });
}

// Waterfall-style loss diagram: irradiance steps (kWh/m²) then energy steps (kWh/kWp).
function lossChart(id, losses) {
  const c = COL();
  const rows = [];
  for (let i = 0; i < losses.length; i++) {
    const s = losses[i];
    const prev = i > 0 && losses[i - 1].irradiance === s.irradiance ? losses[i - 1].value : null;
    rows.push({ name: s.name, v: s.value, d: prev == null ? null : (s.value - prev) / prev, irr: s.irradiance });
  }
  const y = rows.map((r) => r.name).reverse();
  plot(id, [{
    type: 'bar', orientation: 'h', y, x: rows.map((r) => r.v).reverse(),
    marker: { color: rows.map((r) => (r.irr ? c.pv : c.gen)).reverse(), cornerradius: 4 },
    text: rows.map((r) => fmtNum(r.v, 0) + (r.irr ? ' kWh/m²' : ' kWh/kWp') + (r.d == null ? '' : `  (${r.d >= 0 ? '+' : ''}${(r.d * 100).toFixed(1)} %)`)).reverse(),
    textposition: 'auto', insidetextanchor: 'start', textfont: { color: c.text, size: 11 },
    hovertemplate: '%{y}<br>%{text}<extra></extra>',
  }], { xaxis: { title: { text: 'kWh/m² (irradiance) · kWh/kWp (energy)' } }, yaxis: { automargin: true }, margin: { l: 10, r: 10, t: 10, b: 40 }, showlegend: false });
}
