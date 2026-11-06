// Plain logic of the simulation page that needs no browser: the monthly balance, the energy flow,
// the diesel-only check against the site's records, the battery health figures, the dispatch weeks that stand out, the hourly
// CSV and the figures of the cards that are not in sim-view.js. Everything takes the project parts it needs as arguments, so
// `ui/tests/sim-extra.test.js` covers it; `sim.svelte.js` binds it to the open project.
import { fmtNum, fmtPct, fmtEnergy } from './format.js';
import { HOURS, MONTHS, monthlySum, sum } from './series.js';
import { heatmapFig } from './chart-kit.js';

const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };

// 24 x 365 matrix for heatmaps (rows = hour, columns = day)
function dayHourMatrix(arr, scale = 1) {
  const z = Array.from({ length: 24 }, () => new Array(365));
  for (let d = 0; d < 365; d++) for (let h = 0; h < 24; h++) z[h][d] = arr[d * 24 + h] * scale;
  return z;
}

// ---------------------------------------------------------------- monthly balance and energy flow
// Monthly energy balance of year 1 (kWh, fuel in L), 12 months and the year: load = PV + wind + battery + diesel to the load
// + unmet; RE fraction as the engine computes it. Shared by the Monthly energy supply card, the report and the workbook.
export function monthBalance(R) {
  const H = R.hourly, z = new Array(HOURS).fill(0), ms = (a) => monthlySum(a || z);
  const k = { load: ms(H.load), pv: ms(H.pv_to_load), wind: ms(H.wind_to_load), bess: ms(H.bess_dis), gen: ms(H.gen_to_load), gch: ms(H.gen_to_bess), unmet: ms(H.unmet),
              curt: ms(H.pv_curtailed.map((v, i) => v + (H.wind_curtailed ? H.wind_curtailed[i] : 0))), dump: ms(H.gen_dump), fuel: ms(H.fuel_l) };
  const row = (label, f) => {
    const x = { label };
    for (const [key, a] of Object.entries(k)) x[key] = f(a);
    const served = x.load - x.unmet;
    x.re = served > 0 ? Math.min(1, Math.max(0, 1 - (x.gen + x.gch) / served)) : 0;
    return x;
  };
  return MONTHS.map((m, i) => row(m, (a) => a[i])).concat([row('Year', sum)]);
}

// Year-1 energy flow (Sankey): sources, the battery and the load, and where the energy ends. Battery losses close the battery's
// own balance: charged − discharged − self-discharge − change in stored energy. Shared by the Energy flow card and the report.
export function energyFlow(y) {
  const dE = y.e_end - y.e_start, loss = y.bess_ch - y.bess_dis - y.self_discharge - dE, aux = y.aux || 0;
  const thru = y.bess_ch + y.bess_dis, showDE = Math.abs(dE) > 1e-3 * thru, reUsed = y.pv_to_load + y.pv_to_bess + y.wind_to_load + y.wind_to_bess;
  const inp = y.pv_avail + y.wind_avail + y.gen_kwh + y.unmet - Math.min(0, dE);
  const out = y.load + y.pv_curtailed + y.wind_curtailed + y.gen_dump + loss + y.self_discharge + Math.max(0, dE);
  return { dE, loss, aux, thru, showDE, inp, out, gap: inp - out, direct: reUsed > 0 ? (y.pv_to_load + y.wind_to_load) / reUsed : null };
}

// The Sankey of year 1 for the colours c: { traces, layout }
export function flowFigure(c, y) {
  const F = energyFlow(y), wind = y.wind_avail > 0;
  const S = { pv: ['PV available', c.pv], wind: ['Wind available', c.wind], gen: ['Gensets', c.gen], unmet: ['Unmet (not served)', c.unmet], drawn: ['Drawn from storage', c.soc],
              bess: ['Battery', c.bess], load: ['Load', c.load], curt: ['Curtailed', c.curt], dump: ['Genset dump (minimum loading)', c.curt], loss: ['Battery losses', c.bess + '99'],
              sd: ['Self-discharge', c.bess + '99'], stored: ['Added to storage', c.soc], site: ['Site load', c.load], aux: ['Auxiliaries', c.load + '99'] };
  const nodes = [], idx = {}, links = [];
  const node = (k) => { if (idx[k] == null) { idx[k] = nodes.length; nodes.push({ label: S[k][0], color: S[k][1] }); } return idx[k]; };
  const L = (a, b, v) => { if (v > 1e-6 * Math.max(1, y.load)) links.push([node(a), node(b), v / 1000]); };
  L('pv', 'load', y.pv_to_load); L('pv', 'bess', y.pv_to_bess); L('pv', 'curt', y.pv_curtailed);
  if (wind) { L('wind', 'load', y.wind_to_load); L('wind', 'bess', y.wind_to_bess); L('wind', 'curt', y.wind_curtailed); }
  L('gen', 'load', y.gen_to_load); L('gen', 'bess', y.gen_to_bess); L('gen', 'dump', y.gen_dump);
  L('unmet', 'load', y.unmet);
  if (F.showDE && F.dE < 0) L('drawn', 'bess', -F.dE);
  L('bess', 'load', y.bess_dis); L('bess', 'loss', F.loss); L('bess', 'sd', y.self_discharge);
  if (F.showDE && F.dE > 0) L('bess', 'stored', F.dE);
  if (F.aux > 0) { L('load', 'site', y.load - F.aux); L('load', 'aux', F.aux); }
  return {
    traces: [{ type: 'sankey', arrangement: 'snap', valueformat: ',.0f', valuesuffix: ' MWh',
      node: { label: nodes.map((n) => n.label), color: nodes.map((n) => n.color), pad: 16, thickness: 16, line: { width: 0 },
              hovertemplate: '%{label}: %{value:,.0f} MWh<extra></extra>' },
      link: { source: links.map((l) => l[0]), target: links.map((l) => l[1]), value: links.map((l) => l[2]), color: links.map((l) => nodes[l[0]].color.slice(0, 7) + '55'),
              hovertemplate: '%{source.label} → %{target.label}: %{value:,.0f} MWh<extra></extra>' } }],
    layout: { margin: { l: 10, r: 10, t: 10, b: 10 } },
  };
}

// The tiles under the title of the energy flow card (items for Kpis.svelte)
export function flowTiles(y) {
  const F = energyFlow(y), wind = y.wind_avail > 0, bess = y.bess_ch > 0 || y.bess_dis > 0;
  return [
    ...(F.direct != null ? [['Direct RE share', fmtPct(F.direct), `of the ${wind ? 'PV and wind' : 'PV'} used${bess ? '; the rest is stored first' : ' (no battery)'}`, true]] : []),
    ...(bess ? [['Battery losses', fmtEnergy(F.loss), y.bess_ch > 0 ? `${fmtPct(F.loss / y.bess_ch)} of the energy charged` : 'on discharge only (nothing charged)'],
      ...(y.self_discharge > 0 ? [['Self-discharge', fmtEnergy(y.self_discharge), '']] : []),
      ['Stored-energy change', fmtEnergy(F.dE), 'end of year 1 − start']] : []),
  ];
}
export function flowNote(y) {
  const F = energyFlow(y), bess = y.bess_ch > 0 || y.bess_dis > 0, note = [];
  if (Math.abs(F.gap) > 1e-3 * y.load) note.push(`⚠ Inputs and outputs differ by ${fmtEnergy(F.gap)} (${fmtPct(F.gap / y.load, 2)} of the load).`);
  if (bess && !F.showDE) note.push(`The change in stored energy (${fmtEnergy(F.dE)}) is below 0.1 % of the battery throughput and is not drawn.`);
  return note.join(' ');
}

// ---------------------------------------------------------------- diesel-only baseline against the site's records
// Every result is measured against the modelled diesel-only case, so the existing plant's records (Diesel & control) check it.
// Rows: [key, label, unit, tolerance]; a difference beyond the tolerance is flagged.
export const CAL_ROWS = [['load', 'Site load', 'MWh/yr', 0.03], ['peak', 'Peak load', 'kW', 0.05], ['gen', 'Genset generation', 'MWh/yr', 0.03],
  ['fuel', 'Fuel', 'L/yr', 0.05], ['sfc', 'Specific fuel consumption', 'L/kWh', 0.05], ['hours', 'Genset run hours, all units', 'h/yr', 0.1]];
export const calFmt = (k, v) => (k === 'sfc' ? fmtNum(v, 3) : (k === 'load' || k === 'gen') && v < 100 ? fmtNum(v, 1) : fmtNum(v));
export const calPct = (d) => (d == null || !isFinite(d) ? '–' : Math.abs(d) < 5e-4 ? fmtPct(0) : `${d > 0 ? '+' : '−'}${fmtPct(Math.abs(d))}`);

// The diesel-only case of the last simulation (year 1, no auxiliary loads) against the records, with only the records that have a
// value (above zero); differences are model ÷ site − 1. The diagnosis follows fixed rules and is never applied to the model.
// P: the project (site_records, diesel), SIM: the simulation response. Shared by the Simulation results card, the report and the
// workbook; null without a simulation or a record.
export function calibrationOf(P, SIM) {
  const S = P && P.site_records;
  if (!SIM || !S) return null;
  const given = (v) => typeof v === 'number' && isFinite(v) && v > 0;
  const b = SIM.baseline.years[0], H = SIM.result.hourly, BH = SIM.baseline_hourly;
  // the run's own year-1 site load (hourly load less the auxiliaries), so the check stays with the run when the load is edited later
  const peak = H && H.load ? maxOf(H.load.map((v, i) => v - (H.aux ? H.aux[i] : 0))) : null;
  const site = { load: S.annual_load_mwh, peak: S.peak_kw, gen: S.annual_gen_mwh, fuel: S.annual_fuel_l, hours: S.unit_hours,
                 sfc: given(S.annual_fuel_l) && given(S.annual_gen_mwh) ? S.annual_fuel_l / (1000 * S.annual_gen_mwh) : null };
  const model = { load: b.load / 1000, peak, gen: b.gen_kwh / 1000, fuel: b.fuel_l, hours: b.unit_hours, sfc: b.gen_kwh > 0 ? b.fuel_l / b.gen_kwh : null };
  const rows = CAL_ROWS.filter(([k]) => given(site[k]) && model[k] != null).map(([k, label, unit, tol]) => {
    const d = model[k] / site[k] - 1;
    return { k, label, unit, tol, site: site[k], model: model[k], d, flag: Math.abs(d) > tol + 1e-9 };   // 1e-9: not on rounding noise at the limit
  });
  // monthly fuel: CV(RMSE) over the months with a record, and the months more than 15 % off
  const mf = Array.isArray(S.monthly_fuel_l) ? S.monthly_fuel_l : [], mm = BH && BH.fuel_l ? monthlySum(BH.fuel_l) : null;
  const months = mm ? MONTHS.map((label, i) => ({ label, site: given(mf[i]) ? mf[i] : null, model: mm[i], d: given(mf[i]) ? mm[i] / mf[i] - 1 : null })) : [];
  const rec = months.filter((x) => x.site != null), off = rec.filter((x) => Math.abs(x.d) > 0.15);
  const cv = rec.length ? Math.sqrt(sum(rec.map((x) => (x.model - x.site) ** 2)) / rec.length) / (sum(rec.map((x) => x.site)) / rec.length) : null;
  if (!rows.length && !rec.length) return null;

  const D = P.diesel, r = Object.fromEntries(rows.map((x) => [x.k, x])), diag = [];
  const sfcFix = !!(r.gen && !r.gen.flag && r.sfc && r.sfc.flag);
  if (sfcFix) {
    const f = r.sfc.site / r.sfc.model;   // factor on the fuel per kWh at every loading that matches the records
    diag.push(`Generation matches the records but the specific fuel consumption does not (model ${calPct(r.sfc.d)}): check the fuel curve. A fuel curve ${fmtPct(Math.abs(f - 1))} ${f > 1 ? 'higher' : 'lower'} would match the records (${D.fuel_model === 'linear' ? 'intercept and slope' : 'fuel per kWh at every loading'} × ${fmtNum(f, 3)}${D.fuel_model === 'linear' ? '' : `, the efficiencies in kWh/L ÷ ${fmtNum(f, 3)}`}).`);
  }
  if (r.load && !r.load.flag && r.fuel && r.fuel.flag && !sfcFix)
    diag.push(`The site load matches the records but the fuel does not (model ${calPct(r.fuel.d)}): check the fuel curve and the number of units online (spinning reserve, units always online).`);
  if (r.hours && r.hours.flag && r.hours.model > 0 && r.hours.site > r.hours.model)   // the run-hours row is beyond its tolerance
    diag.push(`The records show ${fmtPct(r.hours.site / r.hours.model - 1)} more run hours than the model: the operators run more units than the reserve rule needs. Check Spinning reserve as share of load and Units always online. The hybrid's savings assume the modelled practice: every extra unit online adds its minimum loading as must-run generation, which displaces PV.`);
  const lp = [['load', 'site load'], ['peak', 'peak load'], ['gen', 'generation']].filter(([k]) => r[k] && r[k].flag).map(([, l]) => l);
  if (lp.length)
    diag.push(`The ${lp.length > 1 ? lp.slice(0, -1).join(', ') + ' and ' + lp[lp.length - 1] + ' differ' : lp[0] + ' differs'} from the records: check the load profile (station service, network losses, the metering point of the records, load changes since their period). The diesel-only case serves the year-1 load without auxiliary loads, and its generation adds only the energy dumped at minimum loading.`);
  if (!diag.length && !rows.some((x) => x.flag) && !off.length && !(cv > 0.15)) diag.push('The modelled diesel-only case matches every record within its tolerance.');
  // the saving is the difference of two fuel figures, so an error in the baseline alone moves it by more than 1 % per 1 %
  const saved = SIM.comparison.fuel_saved_l_y1, lever = saved > 0 ? b.fuel_l / saved : null;
  if (lever != null)
    diag.push(`Each 1 % of baseline fuel error moves the fuel saved by ${fmtNum(lever, 1)} % (diesel only ${fmtNum(b.fuel_l / 1000)} kL, saved ${fmtNum(saved / 1000)} kL in year 1), when the hybrid's own fuel is right. An error in the fuel curve moves both by about the same share, and the fuel saved by about 1 % per 1 %.`);
  const monthNote = !rec.length ? '' : `CV(RMSE) of the monthly fuel ${fmtPct(cv)} over ${rec.length} month${rec.length > 1 ? 's' : ''}${cv > 0.15 ? ', above the 15 % of ASHRAE Guideline 14 for calibration to monthly data' : ''}. ${off.length
    ? `More than 15 % off: ${off.map((x) => `${x.label} (${calPct(x.d)})`).join(', ')}.` : 'No month is more than 15 % off.'} Fuel records are often deliveries, so a change in tank stock moves fuel between months.`;
  const txt = (v) => String(v == null ? '' : v).trim();
  const recs = { period: txt(S.period), source: txt(S.source), scope: txt(S.scope) };
  const basis = `${recs.source || recs.period || recs.scope ? `Records${recs.source ? ' from ' + recs.source : ''}${recs.period ? ', ' + recs.period : ''}${recs.scope ? '; scope: ' + recs.scope : ''}. ` : ''}Model: the diesel-only case of the last simulation, year 1, with ${+D.units} × ${fmtNum(D.unit_kw)} kW gensets and no auxiliary loads. Difference = model ÷ site − 1.`;
  return { rows, months, monthly: rec.length > 0, cv, nMonths: rec.length, off, lever, diag, monthNote, basis, recs };
}

// Fuel by month, the records against the diesel-only model
export function calibrationFigure(c, K) {
  return {
    traces: [
      { type: 'bar', name: 'Site records', x: MONTHS, y: K.months.map((x) => (x.site == null ? null : x.site / 1000)), marker: { color: c.load, cornerradius: 3 }, hovertemplate: '%{x}: %{y:,.1f} kL<extra>Site records</extra>' },
      { type: 'bar', name: 'Model, diesel only', x: MONTHS, y: K.months.map((x) => x.model / 1000), marker: { color: c.gen, cornerradius: 3 },
        customdata: K.months.map((x) => (x.d == null ? 'no record' : calPct(x.d) + ' vs records')), hovertemplate: '%{x}: %{y:,.1f} kL, %{customdata}<extra>Model, diesel only</extra>' },
    ],
    layout: { barmode: 'group', yaxis: { title: { text: 'Fuel (kL)' } } },
  };
}

// ---------------------------------------------------------------- battery health
// Years as compact ranges: [1, 2, 3, 7] -> "1–3, 7".
export function yearList(ys) {
  const out = [];
  for (let i = 0; i < ys.length; i++) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j++;
    out.push(j > i ? `${ys[i]}–${ys[j]}` : String(ys[i]));
    i = j;
  }
  return out.join(', ');
}
// Battery replacement threshold as the engine applies it: blank or negative = end-of-life state of health. bess: P.bess
export const thresholdOf = (bess) => (bess.replace_soh != null && bess.replace_soh >= 0 ? bess.replace_soh : bess.eol_soh);
// Battery health figures of a simulation result (shared by the Battery health card and the report).
export function bessHealthOf(R, bess) {
  const Y = R.years, y1 = Y[0], last = Y[Y.length - 1], thr = thresholdOf(bess);
  const fade = y1.soh_loss_cal + y1.soh_loss_cyc, cap = +bess.warranty_efc_yr || 0;
  return {
    thr, fade, cap,
    maxEfc: Math.max(...Y.map((y) => y.bess_efc)), maxEfcDc: Math.max(...Y.map((y) => y.bess_efc_dc)), maxC: Math.max(...Y.map((y) => y.max_c_rate)),
    life: fade > 0 ? (1 - thr) / fade : null, cycShare: fade > 0 ? y1.soh_loss_cyc / fade : 0,
    repl: Y.filter((y) => y.bess_replaced).map((y) => y.year),
    sohEnd: last.bess_soh - last.soh_loss_cal - last.soh_loss_cyc,
    over: cap > 0 ? Y.filter((y) => y.bess_efc > cap).map((y) => y.year) : [],
  };
}
export const hasBattery = (R) => R.size.bess_kwh > 1e-6 && R.size.bess_kw > 1e-6;
export function bessTiles(R, h) {
  const yrs = (n) => (n > 1 ? 'years ' : 'year ');
  return [
    ['Cycles per year (max)', fmtNum(h.maxEfc), `AC; ${fmtNum(h.maxEfcDc)} at the cells (DC)`],
    ['Max C-rate used', fmtNum(h.maxC, 2) + ' C', `rating ${fmtNum(R.size.bess_kw / R.size.bess_kwh, 2)} C`],
    ['Expected life', h.life == null ? '–' : fmtNum(h.life, 1) + ' yr', h.life == null ? 'no fade' : 'new battery at year-1 use; '
      + (h.cycShare > 0.5 ? `limited by cycling (${fmtPct(h.cycShare, 0)} of the fade)` : `limited by calendar fade (${fmtPct(1 - h.cycShare, 0)} of the fade)`)],
    ['Replacements', String(h.repl.length), h.repl.length ? 'in ' + yrs(h.repl.length) + yearList(h.repl) : 'none in the project life'],
    ['SOH at end of project', fmtPct(h.sohEnd), `replacement threshold ${fmtPct(h.thr, 0)}`],
    h.cap > 0 ? ['Warranty cycle cap', fmtNum(h.cap) + ' /yr', h.over.length ? `exceeded in ${yrs(h.over.length)}${yearList(h.over)}` : 'not exceeded', h.over.length ? 'bad' : false]
      : ['Warranty cycle cap', '–', 'none set (Battery tab)'],
  ];
}
// State of health at every year boundary (start of year y at x = y − 1, end of year y at x = y; a replacement jumps back to 100 %)
export function sohFigure(c, R, h) {
  const Y = R.years, x = [], s = [], rx = [], rs = [];
  Y.forEach((y) => {
    const end = y.bess_soh - y.soh_loss_cal - y.soh_loss_cyc;
    x.push(y.year - 1, y.year); s.push(y.bess_soh * 100, end * 100);
    if (y.bess_replaced) { rx.push(y.year); rs.push(end * 100); }
  });
  const lo = Math.min(h.thr * 100, ...s);
  return {
    traces: [
      { type: 'scatter', mode: 'lines', name: 'State of health', x, y: s, line: { color: c.bess, width: 2 }, hovertemplate: 'after %{x} yr: %{y:.1f} %<extra></extra>' },
      { type: 'scatter', mode: 'lines', name: 'Replacement threshold', x: [0, Y.length], y: [h.thr * 100, h.thr * 100], line: { color: c.unmet, dash: 'dash', width: 1.5 }, hoverinfo: 'skip' },
      ...(rx.length ? [{ type: 'scatter', mode: 'markers', name: 'Replacement', x: rx, y: rs, marker: { color: c.unmet, size: 9, symbol: 'x' }, hovertemplate: 'replaced at the end of year %{x}<extra></extra>' }] : []),
    ],
    layout: { xaxis: { title: { text: 'Years of operation' } }, yaxis: { title: { text: 'State of health (%)' }, range: [Math.max(0, lo - 5), 102] } },
  };
}
export function sohLossFigure(c, R) {
  const Y = R.years;
  return {
    traces: [
      { type: 'bar', name: 'Calendar fade', x: Y.map((y) => y.year), y: Y.map((y) => y.soh_loss_cal * 100), marker: { color: c.text2 } },
      { type: 'bar', name: 'Cycle fade', x: Y.map((y) => y.year), y: Y.map((y) => y.soh_loss_cyc * 100), marker: { color: c.bess } },
    ].map((t) => ({ ...t, hovertemplate: 'year %{x}: %{y:.2f} pp<extra>' + t.name + '</extra>' })),
    layout: { barmode: 'stack', xaxis: { title: { text: 'Project year' } }, yaxis: { title: { text: 'SOH lost (percentage points)' } } },
  };
}

// ---------------------------------------------------------------- genset and battery charts
// Unit-hours by loading band (ten bands of 10 %) in year 1
export function genLoadBands(H, unitKw) {
  const bands = new Array(10).fill(0);
  for (let t = 0; t < HOURS; t++) {
    const u = H.gen_units[t]; if (!u) continue;
    const lf = (H.gen_to_load[t] + H.gen_to_bess[t] + H.gen_dump[t]) / (u * unitKw);
    bands[Math.min(9, Math.floor(lf * 10))] += u;
  }
  return bands;
}
export function genLoadFigure(c, H, diesel) {
  const bands = genLoadBands(H, diesel.unit_kw);
  return {
    traces: [{ type: 'bar', x: bands.map((_, i) => `${i * 10}–${i * 10 + 10}%`), y: bands, marker: { color: c.gen, cornerradius: 4 }, hovertemplate: '%{x}: %{y:,.0f} unit-hours<extra></extra>' }],
    layout: { xaxis: { title: { text: 'Loading per online unit' } }, yaxis: { title: { text: 'Unit-hours' } }, showlegend: false,
      shapes: [{ type: 'line', x0: diesel.min_load * 10 - 0.5, x1: diesel.min_load * 10 - 0.5, yref: 'paper', y0: 0, y1: 1, line: { color: c.unmet, dash: 'dot' } }] },
  };
}
// Units online duration curve: every hour of year 1 sorted from most to fewest gensets online (BH: the diesel-only hourly series)
export function unitsDurationFigure(c, H, BH) {
  const dur = (a) => Array.from(Float64Array.from(a).sort().reverse()), hrs = Array.from({ length: HOURS }, (_, i) => i + 1);
  return {
    traces: [
      ...(BH && BH.gen_units ? [{ type: 'scatter', mode: 'lines', name: 'Diesel only', x: hrs, y: dur(BH.gen_units), line: { color: c.unmet, width: 2, dash: 'dot', shape: 'hv' }, hovertemplate: '%{x:,} h: %{y} units<extra>Diesel only</extra>' }] : []),
      { type: 'scatter', mode: 'lines', name: 'Hybrid', x: hrs, y: dur(H.gen_units), line: { color: c.gen, width: 2, shape: 'hv' }, hovertemplate: '%{x:,} h: %{y} units<extra>Hybrid</extra>' },
    ],
    layout: { xaxis: { title: { text: 'Hours of the year' }, range: [0, HOURS] }, yaxis: { title: { text: 'Gensets online' }, rangemode: 'tozero' } },
  };
}
// Battery state of charge by day and hour
export const socHeatFigure = (c, H) => heatmapFig(c, dayHourMatrix(H.soc, 100), [[0, c.surface2], [0.5, '#9085e9'], [1, '#3d2e9e']], '%');

// ---------------------------------------------------------------- dispatch weeks and the hourly CSV
// Dispatch weeks (the 52 slider positions) that stand out, as start hours: the "Go to" list and the report's second dispatch figure.
// diesel: P.diesel
export function weekPicksOf(R, diesel) {
  const H = R.hourly, gmin1 = diesel.unit_kw * diesel.min_load, bess = hasBattery(R);
  const out = {}, best = {};
  const put = (k, v, s, ok) => { if (ok && (best[k] == null || v > best[k])) { best[k] = v; out[k] = s; } };
  for (let w = 0; w < 52; w++) {
    const s = Math.min(w * 168, HOURS - 168);
    let unmet = 0, units = 0, served = 0, gen = 0, curt = 0, soc = 0, pv = 0, run = 0, longest = 0;
    for (let t = s; t < s + 168; t++) {
      const u = H.gen_units[t], g = H.gen_to_load[t] + H.gen_to_bess[t];
      unmet += H.unmet[t]; units += u; served += H.load[t] - H.unmet[t]; gen += g; soc += H.soc[t]; pv += H.pv_avail[t];
      curt += H.pv_curtailed[t] + (H.wind_curtailed ? H.wind_curtailed[t] : 0);
      run = u > 0 && g + H.gen_dump[t] <= u * gmin1 * (1 + 1e-6) + 1e-3 ? run + 1 : 0;   // every online unit at minimum loading
      longest = Math.max(longest, run);
    }
    put('unmet', unmet, s, unmet > 1e-6); put('units', units, s, units > 0); put('re', gen / served, s, served > 0); put('curt', curt, s, curt > 1e-6);
    put('soc', -soc, s, bess); put('lowload', longest, s, longest > 0); put('pv', pv, s, pv > 0);
  }
  return out;
}

export const CSV_COLUMNS = ['load', 'aux', 'pv_avail', 'pv_to_load', 'pv_to_bess', 'pv_curtailed', 'bess_dis', 'gen_to_load', 'gen_to_bess', 'gen_dump', 'gen_units', 'fuel_l', 'unmet', 'soc', 'soc_target', 'pv_fc_h1', 'load_fc_h1', 'pv_fc_da', 'load_fc_da', 'wind_avail', 'wind_to_load', 'wind_to_bess', 'wind_curtailed'];
// The hourly results of year 1 as CSV text; dateOf(t) gives the date of hour t
export function hourlyCsv(H, dateOf) {
  const lines = ['hour,date,hour_of_day,' + CSV_COLUMNS.join(',')];
  for (let t = 0; t < HOURS; t++) lines.push(`${t},${dateOf(t)},${t % 24},` + CSV_COLUMNS.map((k) => (H[k] ? +(+H[k][t]).toFixed(4) : '')).join(','));
  return lines.join('\n');
}

// ---------------------------------------------------------------- the what-if sliders
// Range and step of the sliders of the Live what-if card, from the project (the old syncWhatIf)
export function whatIfRanges(P) {
  const avg = P.load.kw ? sum(P.load.kw) / HOURS : 1000;
  const pvMax = Math.max(3 * P.pv.capacity_kwp, P.optimizer.pv_max || 0, (P.layout.result && P.layout.result.kwp) || 0, 2 * avg, 100);
  const beMax = Math.max(3 * P.bess.energy_kwh, P.optimizer.bess_max || 0, 12 * avg, 100);
  const stepOf = (m) => Math.pow(10, Math.max(0, Math.floor(Math.log10(m)) - 2));
  const fpMax = Math.max(3, 3 * P.econ.fuel_price), fpStep = Math.pow(10, Math.floor(Math.log10(fpMax)) - 2);
  return {
    pv: { max: Math.ceil(pvMax), step: stepOf(pvMax) },
    be: { max: Math.ceil(beMax), step: stepOf(beMax) },
    fp: { min: Math.max(0.2, fpStep), max: fpMax, step: fpStep },
  };
}
// C-rate of the battery as set (power ÷ energy; 0.5 without a battery)
export const cRateOf = (bess) => (bess.energy_kwh > 0 ? bess.power_kw / bess.energy_kwh : 0.5);
