// What the PV & wind page shows, as plain functions: tiles, monthly balances, figures, the PVGIS
// comparison text and the wind resource preview. No browser needed; ui/tests/pv.test.js covers it.
import { fmtNum, fmtPct, fmtEnergy, fmtPower } from './format.js';
import { MONTHS, MDAYS, HOURS, sum, monthlySum } from './series.js';

const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };

// Headline tiles of a yield result for a plant of kwp kWp
export function pvTiles(R, kwp) {
  return [
    ['Specific yield', fmtNum(R.specific_yield, 0), 'kWh/kWp·yr', true],
    ['Annual energy', fmtEnergy(R.specific_yield * kwp), `for ${fmtNum(kwp)} kWp`],
    ['Performance ratio', fmtPct(R.performance_ratio), 'on plane-of-array'],
    ['Plane-of-array irr.', fmtNum(R.poa_annual, 0), 'kWh/m²·yr'],
    ['Capacity factor', fmtPct(R.specific_yield / 8760), 'DC basis'],
    ['Peak AC output', fmtPower(maxOf(R.ac_per_kwp) * kwp), ''],
  ];
}

// Monthly PV energy curtailed (Lu) and used (load and battery) in kWh/kWp from the last simulation, or null when that
// simulation does not match the PV capacity or the yield shown (PV inputs changed since).
export function pvUse(PVR, SIM, capacityKwp) {
  const H = SIM && SIM.result.hourly, kwp = SIM && SIM.result.size.pv_kwp;
  if (!PVR || !H || !(kwp > 0) || Math.abs(kwp - capacityKwp) > 1e-6 * kwp || Math.abs(sum(H.pv_avail) / kwp / PVR.specific_yield - 1) > 1e-6) return null;
  return { lu: monthlySum(H.pv_curtailed).map((x) => x / kwp), used: monthlySum(H.pv_to_load.map((v, i) => v + H.pv_to_bess[i])).map((x) => x / kwp) };
}

// Monthly PV balances (shared by the PV page, the report and the workbook): irradiation in kWh/m², energy in kWh/kWp,
// normalised production in kWh/kWp/day (Yr = GlobInc, Ya = EArray, Yf = E_avail; Lc = Yr − Ya, Ls = Ya − Yf) and the PR.
// With a matching simulation, Lu = curtailed PV and prUsed = PV used ÷ GlobInc. The last row is the year.
export function pvBalance(PVR, SIM, capacityKwp) {
  const M = PVR && PVR.monthly;
  if (!M) return null;
  const U = pvUse(PVR, SIM, capacityKwp), row = (label, i, days) => {
    const g = (k) => (i < 12 ? M[k][i] : sum(M[k]));
    const x = { label, days, ghi: g('ghi'), dhi: g('dhi'), tamb: i < 12 ? M.tamb[i] : sum(M.tamb.map((t, m) => t * MDAYS[m])) / 365, poa: g('poa'), eff: g('eff'),
                earray: g('earray'), eavail: g('eavail'), lu: U ? (i < 12 ? U.lu[i] : sum(U.lu)) : null, used: U ? (i < 12 ? U.used[i] : sum(U.used)) : null };
    return Object.assign(x, { pr: x.poa > 0 ? x.eavail / x.poa : null, prUsed: U && x.poa > 0 ? x.used / x.poa : null,
      yr: x.poa / days, ya: x.earray / days, yf: x.eavail / days });
  };
  return { rows: MONTHS.map((m, i) => row(m, i, MDAYS[i])).concat([row('Year', 12, 365)]), sim: !!U, stale: !!(SIM && SIM.result.size.pv_kwp > 0 && !U) };
}

export const BAL_HEADS = ['', 'GlobHor kWh/m²', 'DiffHor kWh/m²', 'T_amb °C', 'GlobInc kWh/m²', 'GlobEff kWh/m²', 'EArray MWh', 'E_avail MWh', 'PR'];
export const BAL_NOTE_STALE = 'The last simulation does not match the current PV inputs: run it again to add the unused energy Lu and the delivered PR.';

// Rows of the balance table ({cells, cls} for DataTable)
export function balanceRows(B, kwp) {
  const dE = kwp >= 1000 ? 0 : kwp >= 100 ? 1 : 2;
  return B.rows.map((x) => ({ cls: x.label === 'Year' ? 'total' : '',
    cells: [x.label, fmtNum(x.ghi, 1), fmtNum(x.dhi, 1), fmtNum(x.tamb, 1), fmtNum(x.poa, 1), fmtNum(x.eff, 1),
      fmtNum(x.earray * kwp / 1000, dE), fmtNum(x.eavail * kwp / 1000, dE), fmtPct(x.pr)] }));
}

// Normalised production per kWp and day with the performance ratio on a second axis
export function balanceFig(B, c) {
  const mo = B.rows.slice(0, 12);
  const bar = (name, y, color) => ({ type: 'bar', name, x: MONTHS, y, marker: { color }, hovertemplate: '%{x}: %{y:.2f} kWh/kWp/day<extra>' + name + '</extra>' });
  const line = (name, y, dash) => ({ type: 'scatter', mode: 'lines+markers', name, x: MONTHS, y: y.map((v) => v * 100), yaxis: 'y2', line: { color: c.text, width: 2, dash }, marker: { size: 6 },
    hovertemplate: '%{x}: %{y:.1f} %<extra>' + name + '</extra>' });
  const prs = mo.map((x) => x.pr).concat(B.sim ? mo.map((x) => x.prUsed) : []).filter((v) => v != null);
  return {
    traces: [
      bar(B.sim ? 'Yf: PV energy used' : 'Yf: final yield', mo.map((x) => (B.sim ? x.used / x.days : x.yf)), c.pv),
      ...(B.sim ? [bar('Lu: unused (curtailed)', mo.map((x) => x.lu / x.days), c.curt)] : []),
      bar('Ls: system losses', mo.map((x) => x.ya - x.yf), c.muted),
      bar('Lc: array capture losses', mo.map((x) => x.yr - x.ya), c.text2 + '66'),
      line('PR', mo.map((x) => x.pr)),
      ...(B.sim ? [line('PR delivered', mo.map((x) => x.prUsed), 'dot')] : []),
    ],
    layout: { barmode: 'stack', yaxis: { title: { text: 'kWh/kWp/day' } },
      yaxis2: { title: { text: 'Performance ratio (%)' }, overlaying: 'y', side: 'right', showgrid: false, range: [prs.length ? Math.max(0, Math.floor(Math.min(...prs) * 10 - 1) * 10) : 0, 100] } },
  };
}

// The tilt scan result: the points [tilt, kWh/kWp] and the best one
export const bestTilt = (points) => points.reduce((a, b) => (b[1] > a[1] ? b : a));
export function tiltFig(points, c) {
  const best = bestTilt(points);
  return {
    traces: [{ type: 'scatter', mode: 'lines+markers', x: points.map((p) => p[0]), y: points.map((p) => p[1]), line: { color: c.pv, width: 2 }, marker: { size: 8 }, hovertemplate: '%{x}°: %{y:,.0f} kWh/kWp<extra></extra>' },
      { type: 'scatter', mode: 'markers+text', x: [best[0]], y: [best[1]], text: [`best ${best[0]}°`], textposition: 'top center', marker: { size: 12, color: c.accent }, hoverinfo: 'skip' }],
    layout: { showlegend: false, xaxis: { title: { text: 'Tilt (°)' } }, yaxis: { title: { text: 'kWh/kWp' } }, margin: { l: 56, r: 16, t: 28, b: 40 } },
  };
}

// The PVGIS comparison as sentences (PV page and report). P is the project (bifaciality, weather source).
export function pvRefText(r, P) {
  const out = [`PVGIS reference ${fmtNum(r.pvgis_ey)} kWh/kWp, Soloptima comparable ${fmtNum(r.soloptima_ey)} kWh/kWp (${r.diff >= 0 ? '+' : '−'}${fmtNum(Math.abs(r.diff) * 100, 1)} %).`];
  if (Math.abs(r.diff) > 0.08) out.push('⚠ More than 8 % apart: check the weather data, the loss inputs and the thermal model.');
  out.push(`Comparable means without row shading${P.pv.bifaciality > 0 ? ', the rear side of the bifacial modules' : ''} and inverter clipping, which PVGIS does not model${r.tracker ? ', and true tracking without backtracking or a rotation limit' : ''}; PVGIS gets the losses it does not model itself as its system loss (${fmtNum(r.loss_pct, 1)} %). PVGIS uses its own thermal and spectral models and the ${r.radiation_db} average of ${r.year_min}–${r.year_max}.`);
  const wx = (P.weather && P.weather.source) || '';
  if (!/^PVGIS/.test(wx)) out.push('Not like for like: the weather data of this project is not from PVGIS.');
  else if (!/^PVGIS TMY/.test(wx)) out.push(`Not like for like: the weather data of this project is a single PVGIS year, PVGIS the ${r.year_min}–${r.year_max} average, so part of the gap is that year's weather.`);
  return out;
}

// The message under the PVGIS line when the reference failed: offline gives none (null)
export function refErrorText(message) {
  return /^(Download failed|Cannot reach)/.test(message) ? null : 'PVGIS reference not available: ' + message;
}

// Wind resource preview: hub-height speed and per-turbine energy from the weather file. Returns { text, monthlyMwh }; monthlyMwh is
// null while there is no wind in the weather data.
export function windPreview(P) {
  const W = P.weather, w = P.wind;
  if (!W || !W.wind || !W.wind.length || !w) return { text: 'Fetch weather data to see the wind resource.', monthlyMwh: null };
  const sh = Math.pow(Math.max(1, w.hub_height) / Math.max(1, w.ref_height), w.shear_alpha);
  const pc = (v) => (v < w.v_in || v >= w.v_out ? 0 : v >= w.v_rated ? w.rated_kw : w.curve === 'linear' ? w.rated_kw * (v - w.v_in) / (w.v_rated - w.v_in)
    : w.rated_kw * (v ** 3 - w.v_in ** 3) / (w.v_rated ** 3 - w.v_in ** 3));
  const vh = W.wind.map((v) => Math.max(0, v) * sh);
  const e = vh.map((v) => pc(v) * (1 - w.losses) * w.availability);
  return {
    monthlyMwh: monthlySum(e).map((x) => x / 1000),
    text: `Mean speed ${fmtNum(sum(W.wind) / W.wind.length, 2)} m/s at ${w.ref_height} m → ${fmtNum(sum(vh) / vh.length, 2)} m/s at hub; capacity factor ${fmtPct(sum(e) / (w.rated_kw * HOURS))}; ${fmtNum(sum(e) / 1000)} MWh/yr per turbine${w.units ? `, ${fmtNum(sum(e) * w.units / 1000)} MWh/yr for ${w.units} turbines` : ''}.`,
  };
}

export function windFig(monthlyMwh, c) {
  return {
    traces: [{ type: 'bar', name: 'Energy per turbine', x: MONTHS, y: monthlyMwh, marker: { color: c.wind, cornerradius: 4 }, hovertemplate: '%{x}: %{y:,.1f} MWh<extra></extra>' }],
    layout: { showlegend: false, yaxis: { title: { text: 'MWh per turbine' } } },
  };
}
