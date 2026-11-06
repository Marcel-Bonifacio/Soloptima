// Workbook sheets, first half: summary, inputs, equipment, layout, electrical design, weather years, data quality and the PV
// monthly balance. `D` is the report data of data.js: the open project, the results and the helpers of the old screens.
import { fmtNum } from '../format.js';

function summarySheet({ P, SIM, h, stale }) {
  const cur = P.econ.currency, summary = [['Item', 'Value', 'Unit']];
  summary.push(['Project', P.name, ''], ['Latitude', P.location.lat, '°'], ['Longitude', P.location.lon, '°'], ['UTC offset', P.location.utc_offset, 'h'],
    ['Time zone', P.location.tz || '', ''], ['Exported', new Date().toISOString(), '']);
  if (!SIM) return summary;
  // sizes from the run, as the results; the genset fleet is not part of it (the note covers a change)
  const R = SIM.result, C = SIM.comparison, y = R.years[0], Z = R.size;
  if (stale.note) summary.push(['Note', stale.note, '']);
  summary.push(['PV capacity', Z.pv_kwp, 'kWp'], ['BESS energy', Z.bess_kwh, 'kWh'], ['BESS power', Z.bess_kw, 'kW'], ['Gensets', `${P.diesel.units} x ${P.diesel.unit_kw}`, 'kW'],
    ['Renewable fraction (yr 1)', R.re_fraction, '-'], ['Fuel (yr 1)', y.fuel_l, 'L'], ['Fuel saved vs diesel-only (yr 1)', C.fuel_saved_l_y1, 'L'],
    ['LCOE', R.econ.lcoe, cur + '/kWh'], ['LCOE diesel-only', C.lcoe_base, cur + '/kWh'], ['NPC', R.econ.npc, cur], ['NPV of savings', C.npv_savings, cur],
    ['IRR', C.irr, '-'], ['Payback', C.payback_years, 'yr'], ['Capex', R.econ.capex_total, cur], ['PV curtailment', R.curtail_fraction, '-'], ['Unmet load', R.unmet_fraction, '-'],
    ['CO2 avoided (yr 1)', C.co2_saved_t_y1, 't'], ['Auxiliary consumption (yr 1)', y.aux || 0, 'kWh'], ['Unmet load, worst year', R.unmet_fraction_max, '-'],
    ['Loss-of-load hours (yr 1)', y.lol_h, 'h'], ['Loss-of-load events (yr 1)', y.lol_events, ''], ['Reserve shortfall (yr 1)', y.reserve_short_h, 'h'],
    ['Reserve shortfall diesel-only (yr 1)', SIM.baseline.years[0].reserve_short_h, 'h'], ['Most gensets online (yr 1)', y.max_units, ''],
    ['Most gensets online diesel-only (yr 1)', SIM.baseline.years[0].max_units, ''], ['Hours at minimum loading (yr 1)', y.minload_h, 'h']);
  const V = SIM.pv_only, CB = SIM.comparison_bess, vl = R.size.wind_units > 0 ? 'PV + wind only' : 'PV only';
  if (V && CB) summary.push([`NPC without the battery (${vl})`, V.econ.npc, cur], [`NPV of the battery vs ${vl}`, CB.npv_savings, cur],
    [`IRR of the battery vs ${vl}`, CB.irr, '-'], [`Fuel saved by the battery vs ${vl} (yr 1)`, CB.fuel_saved_l_y1, 'L']);
  if (R.metrics) for (const [k, v] of Object.entries(R.metrics)) summary.push([k, v, '']);
  return summary;
}

function electricalSheet({ P, design: D }) {
  const cur = P.econ.currency;
  const rows = [['Circuit', 'Count', 'Cable', 'Parallel runs', 'Length m', 'Design current A', 'Rating A', 'Utilisation', 'Voltage drop', 'Loss at rated kW', 'Annual loss kWh', 'Cost ' + cur]];
  D.circuits.forEach((c) => rows.push([c.name, c.count, c.cab ? c.cab.name : '', c.runs, c.L, c.I, c.amp, c.util, c.dv, c.ploss != null ? c.ploss * c.count : null, c.annual, c.cost]));
  rows.push([]);
  rows.push(['Transformer role', 'Units', 'Type', 'kVA', 'Peak loading', 'No-load loss kWh/yr', 'Load loss kWh/yr']);
  D.trafos.forEach((t) => rows.push([t.role, t.n, t.t.name, t.t.kva, t.loading, t.noLoad, t.loadLoss]));
  if (D.str) {
    const s = D.str;
    rows.push([], ['String sizing', 'Value', 'Unit']);
    rows.push(['Modules per string', s.ns, ''], ['Allowed modules per string, min', s.nMin, ''], ['Allowed modules per string, max', Math.min(s.nMax, s.nMppt), ''],
      ['Site minimum temperature', D.tmin, '°C'], ['Max cell temperature', s.tHot, '°C'], ['Thermal model P99.9 cell temperature', s.tModel, '°C'],
      ['Voc at site minimum', s.vocMax, 'V'], ['Vmp at max cell temperature', s.vmpHot, 'V'], ['Vmp at site minimum', s.vmpCold, 'V'],
      ['Temp. coeff. Vmp', s.bVmp, '%/°C'], ['Temp. coeff. Vmp source', s.bVmpSrc, ''], ['Strings', s.nStrings, ''], ['Inverters', s.nInv, ''], ['DC capacity (built)', s.kwp, 'kWp']);
  }
  return rows;
}

function yearsSheet({ P, ry: S }) {
  const cur = P.econ.currency, X = S.X, b = X.budget || {};
  const cols = [['year', 'Weather year'], ['sy', 'Specific yield kWh/kWp'], ['ghi', 'GHI kWh/m²'], ['poa', 'Plane of array kWh/m²'], ['re', 'RE fraction'], ['curtail', 'Curtailment'],
    ['unmet', 'Unmet load'], ['fuel_hyb', 'Fuel hybrid L'], ['fuel_base', 'Fuel diesel only L'], ['fuel_saved', 'Fuel saved L'], ['avoided_cost', 'Avoided diesel cost ' + cur],
    ['re_kwh', 'RE served kWh'], ['revenue', 'Revenue yr 1 ' + cur], ['npv_savings', 'NPV of savings ' + cur]];
  const rows = [cols.map((c) => c[1])];
  X.years.forEach((y) => rows.push(cols.map(([k]) => y[k])));
  const st = fmtNum(X.step * 100, 2);
  [['Project weather (P50)', X.anchor], [`Project weather, irradiance +${st} %`, X.plus], [`Project weather, irradiance −${st} %`, X.minus]]
    .forEach(([l, y]) => rows.push([l].concat(cols.slice(1).map(([k]) => y[k]))));
  const unit = { yield: 'kWh/kWp', fuel_saved: 'L', re: '-', revenue: cur, fuel_used: 'L', avoided_cost: cur };
  rows.push([], ['Result', 'Unit', 'P50', 'Multi-year mean', 'Inter-annual σ', 'σ 1 yr', 'σ 10 yr', 'Elasticity', 'P75 1 yr', 'P90 1 yr', 'P99 1 yr', 'P90 10 yr', 'Worst year', 'Worst year value']);
  S.rows.concat([{ k: 'avoided_cost', label: 'Avoided diesel cost', ...X.stats.avoided_cost }]).forEach((r) => rows.push([r.label, unit[r.k], r.p50, r.mean, r.sigma_iav, r.sigma_1, r.sigma_10,
    r.elasticity, r.p75_1, r.p90_1, r.p99_1, r.p90_10, r.worst_year, r.worst]));
  rows.push([], ['Database', `${X.database} ${X.range.from}–${X.range.to}`], ['P50 weather', X.weather || ''],
    ['Project weather vs multi-year mean', S.dev, 'specific yield, P50 ÷ multi-year mean − 1'], ['Systematic uncertainty σ', X.sigma_sys],
    ['Dataset / model / soiling and availability', `${b.dataset} / ${b.model} / ${b.soiling}`], ['Revenue P90 ÷ P50, one year', S.f1], ['Revenue P90 ÷ P50, 10-year average', S.f10],
    ['Debt sizing factor (Project finance)', P.finance.p90_factor, S.applied ? `from this run, ${S.applied.basis === 10 ? '10-year average' : 'one year'}` : 'typed'],
    ['Basis', 'year 1 of the plant per weather year; spread used as ratios around P50; 10-year values assume independent years']);
  if (S.devWarn) rows.push(['Note', S.devWarn]);
  if (X.note) rows.push(['Note', X.note]);
  if (S.stale) rows.push(['Note', 'The inputs changed after this run; run it again.']);
  return rows;
}

function pvSheet({ P, PVREF, h }, PB) {
  const kwp = P.pv.capacity_kwp, rows = [['Month', 'GlobHor kWh/m²', 'DiffHor kWh/m²', 'T_amb °C', 'GlobInc kWh/m²', 'GlobEff kWh/m²', 'EArray kWh/kWp', 'E_avail kWh/kWp',
    'EArray MWh', 'E_avail MWh', 'PR', 'Yr kWh/kWp/day', 'Ya kWh/kWp/day', 'Yf kWh/kWp/day', 'Lc kWh/kWp/day', 'Ls kWh/kWp/day'].concat(PB.sim ? ['Lu kWh/kWp/day', 'PR delivered'] : [])];
  PB.rows.forEach((x) => rows.push([x.label, x.ghi, x.dhi, x.tamb, x.poa, x.eff, x.earray, x.eavail, x.earray * kwp / 1000, x.eavail * kwp / 1000, x.pr, x.yr, x.ya, x.yf,
    x.yr - x.ya, x.ya - x.yf].concat(PB.sim ? [x.lu / x.days, x.prUsed] : [])));
  rows.push([], ['PV capacity', kwp, 'kWp']);
  if (PVREF) {
    rows.push([], ['PVGIS reference', 'PVGIS kWh/kWp', 'Soloptima comparable kWh/kWp']);
    h.MONTHS.forEach((m, i) => rows.push([m, PVREF.pvgis_em[i], PVREF.soloptima_em[i]]));
    rows.push(['Year', PVREF.pvgis_ey, PVREF.soloptima_ey], ['Difference', PVREF.diff, '(Soloptima − PVGIS) ÷ PVGIS'], ['PVGIS system loss', PVREF.loss_pct / 100, ''],
      ['PVGIS data', `${PVREF.radiation_db} ${PVREF.year_min}–${PVREF.year_max}`, ''],
      ['Basis', 'comparable yield without row shading and inverter clipping; PVGIS uses its own thermal and spectral models', '']);
  }
  return rows;
}

// the sheets up to the PV monthly balance
export function sheetsA(D) {
  const { P, h } = D, sheets = [];
  sheets.push({ name: 'Summary', rows: summarySheet(D) });
  sheets.push({ name: 'Inputs', rows: [['Parameter', 'Value']].concat(h.flatten({ location: P.location, pv: P.pv, bess: P.bess, aux: P.aux, diesel: P.diesel, wind: P.wind, ems: P.ems, econ: P.econ, sim: P.sim, electrical: P.electrical, site_records: P.site_records })) });
  const eqRows = [['Type', 'Field', 'Value']];
  for (const t of ['pv', 'inverter', 'battery', 'genset']) { const e = h.selected(t); if (e) Object.entries(e).forEach(([k, v]) => eqRows.push([t, k, v])); }
  sheets.push({ name: 'Equipment', rows: eqRows });
  if (D.layoutRows) sheets.push({ name: 'Layout', rows: D.layoutRows });
  if (D.design) sheets.push({ name: 'Electrical', rows: electricalSheet(D) });
  if (D.ry) sheets.push({ name: 'Resource years', rows: yearsSheet(D) });
  const DQ = h.tsRows();
  if (DQ) sheets.push({ name: 'Data quality', rows: DQ });
  const PB = h.pvBalance();
  if (PB) sheets.push({ name: 'PV monthly', rows: pvSheet(D, PB) });
  return sheets;
}
