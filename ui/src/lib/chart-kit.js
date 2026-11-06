// Figures shared by several pages: each returns { traces, layout } for <Chart build={...}>.
import { MONTHS } from './series.js';

// marks: day indices (0-364) to outline, e.g. the days the data checks flagged; runs of days share one outline.
export function heatmapFig(c, z, colorscale, unit, marks) {
  const shapes = [], d = [...new Set((marks || []).filter((x) => x >= 0 && x < 365))].sort((a, b) => a - b);
  for (let k = 0; k < d.length;) {
    let e = k;
    while (e + 1 < d.length && d[e + 1] === d[e] + 1) e++;
    shapes.push({ type: 'rect', xref: 'x', yref: 'y', x0: d[k] + 0.5, x1: d[e] + 1.5, y0: -0.5, y1: 23.5, line: { color: c.unmet, width: 1.5 }, fillcolor: 'rgba(0,0,0,0)' });
    k = e + 1;
  }
  return {
    traces: [{ type: 'heatmap', z, x: Array.from({ length: 365 }, (_, i) => i + 1), y: Array.from({ length: 24 }, (_, i) => i),
      colorscale: colorscale || [[0, c.surface2], [0.25, '#9ec5f4'], [0.6, '#3987e5'], [1, '#104281']],
      colorbar: { title: { text: unit || '', side: 'right' }, thickness: 12, tickfont: { color: c.text2 } },
      hovertemplate: 'day %{x}, %{y}:00<br>%{z:,.0f} ' + (unit || '') + '<extra></extra>' }],
    layout: { xaxis: { title: { text: 'Day of year' } }, yaxis: { title: { text: 'Hour' }, dtick: 6 }, margin: { l: 56, r: 10, t: 10, b: 40 }, shapes },
  };
}

// series: [{ name, y, color, unit }] over the twelve months
export function monthlyBarsFig(series, ytitle) {
  return {
    traces: series.map((s) => ({ type: 'bar', name: s.name, x: MONTHS, y: s.y, marker: { color: s.color, cornerradius: 4 },
      hovertemplate: '%{x}: %{y:,.1f} ' + (s.unit || '') + '<extra>' + s.name + '</extra>' })),
    layout: { yaxis: { title: { text: ytitle } }, showlegend: series.length > 1 },
  };
}
