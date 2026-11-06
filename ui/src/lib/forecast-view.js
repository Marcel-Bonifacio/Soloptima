// Forecast Lab: chart traces, the method table and the value of each method from the benchmark response (plain functions; ui/tests/forecast.test.js)
import { fmtNum, fmtPct, fmtMoney } from './format.js';
import { weekStart, dateOfHour } from './series.js';

// Fixed colour per method (identity is stable across PV / load and every chart).
const METHOD_COLOR = { smart_persistence: '#2a78d6', profile: '#2a78d6', ensemble: '#eb6834', ets: '#1baf7a', rls: '#eda100',
  analog: '#e87ba4', climatology: '#008300', persistence: '#6250d6', weekly: '#e34948', mlp: '#8a5a00' };
export const colorOf = (id, c) => (id === 'perfect' ? c.text2 : METHOD_COLOR[id] || c.muted);

export const METRICS = [['nmae', 'nMAE'], ['nrmse', 'nRMSE'], ['skill', 'Skill vs persistence'], ['bias', 'Bias']];
const METRIC_TITLE = { nmae: 'nMAE (%)', nrmse: 'nRMSE (%)', skill: 'Skill vs persistence', bias: 'Bias (%)' };

// Fuel, genset hours and NPC saved by a method against load following (year 1), or null without the value run.
export function valueOf(B, variable, id) {
  if (!B || !B.value) return null;
  const ref = B.value.find((v) => v.kind === 'reference'), v = B.value.find((x) => x.kind === variable && x.id === id);
  if (!ref || !v) return null;
  return { fuel: ref.fuel_l - v.fuel_l, hours: ref.unit_hours - v.unit_hours, npc: ref.npc - v.npc };
}

export function leadChart(B, variable, metric, inUse, c) {
  const leads = Array.from({ length: 48 }, (_, i) => i + 1), scale = metric === 'skill' ? 1 : 100, d = metric === 'skill' ? 3 : 1;
  const traces = B[variable].methods.filter((m) => m.id !== 'perfect' && !(metric === 'skill' && m.id === 'persistence')).map((m) => ({
    type: 'scatter', mode: 'lines', name: m.name, x: leads, y: m[metric].map((v) => v * scale),
    line: { color: colorOf(m.id, c), width: m.id === inUse ? 3.5 : 2, dash: m.id === 'noisy' ? 'dot' : 'solid' },
    hovertemplate: `%{x} h: %{y:.${d}f}${metric === 'skill' ? '' : ' %'}<extra>${m.name}</extra>`,
  }));
  return { traces, layout: { xaxis: { title: { text: 'Forecast horizon (hours after last measurement)' }, dtick: 6 },
    yaxis: { title: { text: METRIC_TITLE[metric] }, zeroline: true }, legend: { orientation: 'h', y: -0.25 }, hovermode: 'x unified' } };
}

export function valueChart(B, variable, c) {
  const vals = B[variable].methods.filter((m) => m.id !== 'noisy').map((m) => ({ m, v: valueOf(B, variable, m.id) })).filter((x) => x.v);
  if (!vals.length) return null;
  return { traces: [{ type: 'bar', orientation: 'h', y: vals.map((x) => x.m.name), x: vals.map((x) => x.v.fuel / 1000),
    marker: { color: vals.map((x) => colorOf(x.m.id, c)), cornerradius: 4 },
    text: vals.map((x) => `${fmtNum(x.v.fuel / 1000, 0)} kL · ${fmtNum(x.v.hours)} h`), textposition: 'auto', textfont: { color: c.text },
    hovertemplate: '%{y}<br>fuel saved %{x:,.0f} kL/yr vs load following<extra></extra>' }],
  layout: { xaxis: { title: { text: 'Fuel saved vs load following, year 1 (kL)' } }, yaxis: { autorange: 'reversed', automargin: true }, showlegend: false, margin: { l: 10, r: 10, t: 10, b: 44 } } };
}

export const TABLE_HEADS = ['Method', 'nMAE 1 h', 'nMAE 6 h', 'nMAE 24 h', 'Skill 24 h', 'Fuel saved kL/yr', 'Genset h saved', 'NPC saving'];

// One row per method: plain values; the page draws the tags and the button.
export function tableRows(B, variable, inUse, cur, c) {
  const blk = B[variable], best = blk.methods.filter((m) => m.id !== 'noisy' && m.id !== 'perfect').reduce((a, m) => (m.nrmse[23] < a.nrmse[23] ? m : a));
  return blk.methods.map((m) => {
    const v = valueOf(B, variable, m.id);
    return { id: m.id, name: m.name, description: m.description || '', color: colorOf(m.id, c), best: m.id === best.id, inUse: m.id === inUse,
      cells: [fmtPct(m.nmae[0]), fmtPct(m.nmae[5]), fmtPct(m.nmae[23]), m.skill[23].toFixed(3), v ? fmtNum(v.fuel / 1000, 1) : '–', v ? fmtNum(v.hours) : '–', v ? fmtMoney(v.npc, cur) : '–'],
      usable: !(m.id === inUse || m.id === 'perfect' || m.id === 'noisy') };
  });
}

export { weekStart };
export const weekLabel = (w) => { const s = weekStart(w); return `${dateOfHour(s)} to ${dateOfHour(s + 167)}`; };

export function seriesChart(B, variable, horizon, week, picked, c) {
  const blk = B[variable], s = weekStart(week), idx = Array.from({ length: 168 }, (_, i) => s + i), ticks = idx.filter((h) => h % 24 === 0);
  const tr = [{ type: 'scatter', mode: 'lines', name: 'Actual', x: idx, y: idx.map((h) => blk.actual[h]), line: { color: c.load, width: 3 } }];
  blk.methods.filter((m) => picked.includes(m.id)).forEach((m) => tr.push({ type: 'scatter', mode: 'lines', name: m.name, x: idx, y: idx.map((h) => m[horizon][h]),
    line: { color: colorOf(m.id, c), width: 1.8, dash: m.id === 'noisy' ? 'dot' : 'solid' } }));
  return { traces: tr.map((t) => ({ ...t, hovertemplate: '%{y:,.0f} kW<extra>' + t.name + '</extra>' })),
    layout: { hovermode: 'x unified', xaxis: { tickvals: ticks, ticktext: ticks.map(dateOfHour) }, yaxis: { title: { text: 'kW' }, rangemode: 'tozero' } } };
}
