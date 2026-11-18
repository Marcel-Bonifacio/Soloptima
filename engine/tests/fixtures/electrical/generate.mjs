// Froze what the JavaScript electrical design computed, as fixtures the Rust port must reproduce. Kept for the record: the
// modules it imports (ui/src/lib/equip/design.js, fault.js, loadflow.js and the study part of protection.js) are gone since the
// engine took the calculation over; run it against a checkout from before that change.
const R = process.argv[2], OUT = process.argv[3];
const { defaultLibrary } = await import(R + '/ui/src/lib/equip/library.js');
const { computeDesign, autoSize, applyLosses } = await import(R + '/ui/src/lib/equip/design.js');
const { runLoadFlow, busVoltages, weekAround } = await import(R + '/ui/src/lib/equip/loadflow.js');
const { protectionStudy } = await import(R + '/ui/src/lib/equip/protection.js');
const { plantLengths } = await import(R + '/ui/src/lib/equip/siteplan.js');
const { projector } = await import(R + '/ui/src/lib/layout/geometry.js');
const { HOURS } = await import(R + '/ui/src/lib/series.js');
const { writeFileSync } = await import('node:fs');
const clone = (x) => JSON.parse(JSON.stringify(x));
const KEYS = ['location', 'econ', 'load', 'pv', 'bess', 'diesel', 'aux', 'equipment', 'electrical', 'weather'];
const subset = (P) => Object.fromEntries(KEYS.filter((k) => k in P).map((k) => [k, P[k]]));
const flat = (k) => new Array(HOURS).fill(k);
const wave = (a, b, ph = 0) => Array.from({ length: HOURS }, (_, h) => a + b * Math.sin((h + ph) / 24 * 2 * Math.PI));
const pvr = () => ({ ac_per_kwp: Array.from({ length: HOURS }, (_, h) => Math.max(0, Math.sin((h % 24 - 6) / 12 * Math.PI)) * 0.7), tcell: wave(35, 12), poa: Array.from({ length: HOURS }, (_, h) => Math.max(0, Math.sin((h % 24 - 6) / 12 * Math.PI)) * 900) });
const sim = () => { const pv = Array.from({ length: HOURS }, (_, h) => Math.max(0, Math.sin((h % 24 - 6) / 12 * Math.PI)) * 2400);
  const load = wave(1000, 300); const H = { pv_avail: pv, pv_to_load: pv.map((p, i) => Math.min(p, load[i])), pv_to_bess: pv.map((p, i) => Math.max(0, p - load[i]) * 0.8),
    bess_dis: load.map((l, i) => (pv[i] < l ? Math.min(600, l - pv[i]) : 0)), gen_to_load: load.map((l, i) => Math.max(0, l - pv[i] - 600)), gen_to_bess: flat(0), gen_dump: flat(0),
    gen_units: load.map((l, i) => (l - pv[i] - 600 > 0 ? Math.ceil((l - pv[i] - 600) / 500) : 0)), load, aux: flat(20), wind_to_load: flat(0), wind_to_bess: flat(0) };
  return { result: { hourly: H, years: [{ bess_dis: 1.1e6, bess_ch: 1.25e6, gen_kwh: 6.4e5 }] } }; };
const cabs = { dc: 'dc6', lv_pv: 'lv240al', mv_pv: 'mv240al', lv_bess: 'lv400al', mv_bess: 'mv240al', lv_gen: 'lv630cu', mv_gen: 'mv150al', load: 'mv400al' };
const base = (E = {}, o = {}) => ({
  name: 'case', location: { lat: o.lat ?? -8.5, lon: 115.2 }, econ: { currency: 'USD', bess_capex_kwh: 220, bess_capex_kw: 80, bess_replace_kwh: 150, diesel_om_unit_hour: 2 },
  weather: o.weather === undefined ? { tamb: wave(27, 4) } : o.weather, load: { kw: wave(800, 300) },
  pv: { capacity_kwp: o.kwp ?? 3000, dc_ac_ratio: 1.3, inverter_eff: 0.98, inverter_eff_max: 0.985, dc_wiring: 0.015, ac_losses: 0.015, dc_wiring_basis: 'annual', noct: 45, low_irr_loss_200: 0.02 },
  bess: { energy_kwh: o.bess === false ? 0 : 5000, power_kw: o.bess === false ? 0 : 2500, rte: 0.88 },
  diesel: { units: o.units ?? 2, unit_kw: 500, min_units_online: 1, min_load: 0.3, fuel_model: 'linear', strategy: 'load_following', reserve_load: 0.1, reserve_pv: 0.2 },
  aux: { trafo_noload_kw: 0, bess_trafo_noload_kw: 0, pcs_kw_per_mw: 0 },
  equipment: { lib: o.lib || defaultLibrary(), sel: { pv: 'pv600', inverter: 'inv330', battery: 'bat5', genset: 'dg500', ...(o.sel || {}) } },
  electrical: { mv_kv: 20, pf_load: 0.9, t_min: 15, t_cell_max: 70, modules_per_string: 0, derate: 0.8, trafo_pv: 'tr3150', trafo_bess: 'tr5000', trafo_gen: 'tr2500',
    gens_per_trafo: 1, gen_mv: false, trafo_load: '', pv_per_feeder: 4, dv_dc: 1.5, dv_lv: 1.5, dv_mv: 1.0,
    len: { dc: 60, lv_pv: 120, mv_pv: 800, lv_bess: 30, mv_bess: 400, lv_gen: 60, mv_gen: 250, load: 500 }, cable: { ...cabs },
    runs: { dc: 1, lv_pv: 2, mv_pv: 1, lv_bess: 4, mv_bess: 1, lv_gen: 4, mv_gen: 1, load: 2 }, applied: null,
    grid_mva: 0, grid_xr: 10, mv_earthing: 'resistance', mv_earth_a: 300, grading_s: 0.3, sc_t_max: 1, breaker: {}, prot: {}, ...E },
});
// stations and tables for lengths measured on the layout
const pr = projector(7, -1), ll = (x, y) => pr.inv([x, y]);
const st = (kind, x, y) => ({ kind, latlng: ll(x, y) });
const tbl = (x, y) => [[x, y], [x + 30, y], [x + 30, y + 5], [x, y + 5]].map(([a, b]) => ll(a, b));
const withLayout = (P) => ({ ...P, location: { lat: 7, lon: -1 }, layout: { stations: [st('substation', 0, 0), st('pv', 700, 500), st('pv', 300, 300), st('bess', 100, -200), st('gen', -150, 50), st('load', -400, 0)],
  result: { tables: [tbl(650, 480), tbl(690, 520), tbl(320, 260), tbl(250, 330)] } } });
const blanks = () => { const lib = defaultLibrary(); for (const t of ['inverter', 'genset', 'transformer']) for (const e of lib[t]) { delete e.ifault; delete e.xd2; delete e.xr; } return lib; };
const CASES = {
  base: base(),
  string_inverters: base({ inverter_layout: 'string' }),
  grid_strong: base({ grid_mva: 500, grid_xr: 12 }),
  grid_weak_solid: base({ grid_mva: 40, grid_xr: 6, mv_earthing: 'solid' }),
  gen_mv: base({ gen_mv: true, gens_per_trafo: 2 }, { units: 4 }),
  no_bess: base({}, { bess: false }),
  no_pv: base({}, { kwp: 0 }),
  layout_lengths: withLayout(base({ len_from_layout: true, route_factor: 1.25 })),
  blank_datasheets: base({ grid_mva: 250 }, { lib: blanks() }),
  no_weather_tmin: base({ t_min: null }, { weather: null }),
  settings_typed: base({ prot: { mv_pv: { pickup: 120, curve: 'VI' }, load: { tms: 0.2 } }, breaker: {} }),
  mv_11kv_trafo_load: base({ mv_kv: 11, trafo_load: 'tr2500', dv_mv: 0.5 }),
};
let total = 0;
const series = { load: wave(800, 300), tamb: wave(27, 4), pvr: pvr(), sim: sim() };
writeFileSync(`${OUT}/_series.json`, JSON.stringify(series));
for (const [name, P] of Object.entries(CASES)) {
  const pv = pvr(), S = sim(), lengths = plantLengths(P);
  const req = { project: subset(P), pvr: pv, sim: S, lengths };
  const D = computeDesign(clone(P), { PVR: pv, SIM: S });
  const PR = protectionStudy(clone(P), D);
  const LF = runLoadFlow(clone(P), D, S);
  const hours = [LF.hours[0].h, 12, 4000, 8759].map((t) => ({ t, buses: busVoltages(LF, S, t) }));
  const Pa = clone(P), n = autoSize(Pa, { PVR: pv, SIM: S });
  const Pb = clone(P);
  let rte = null, applyError = null;
  try { rte = applyLosses(Pb, computeDesign(clone(P), { PVR: pv, SIM: S }), null); } catch (e) { applyError = e.message; }
  const out = { name, request: req, design: D, protection: PR, loadflow: { ...LF, net: undefined }, bus_hours: hours, week: weekAround(4000),
    autosize: { count: n, electrical: Pa.electrical }, apply: applyError ? { error: applyError } : { rte_base: rte, pv: Pb.pv, bess: Pb.bess, aux: Pb.aux, electrical: Pb.electrical } };
  // the hourly series are the same in every case: kept once in _series.json, named here
  const S0 = JSON.stringify(series), shared = (v, k) => (JSON.stringify(v) === JSON.stringify(series[k]) ? '@' + k : v);
  out.request = { ...req, project: { ...req.project, load: { kw: shared(req.project.load.kw, 'load') }, weather: req.project.weather ? { tamb: shared(req.project.weather.tamb, 'tamb') } : null }, pvr: shared(pv, 'pvr'), sim: shared(S, 'sim') };
  void S0;
  // hourly series in the results: a fingerprint (length, sum, min, max, 24 hours) the Rust test takes of its own output too
  const AT = Array.from({ length: 24 }, (_, i) => Math.floor(i * HOURS / 24) + (i * 7) % 24);
  const fp = (x) => (Array.isArray(x) && x.length >= 8000 && x.every((v) => v === null || typeof v === 'number')
    ? { '@series': x.length, sum: x.reduce((a, v) => a + (v || 0), 0), min: Math.min(...x.map((v) => v ?? Infinity)), max: Math.max(...x.map((v) => v ?? -Infinity)), at: AT.map((i) => x[i]) }
    : Array.isArray(x) ? x.map(fp) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === 'request' ? v : fp(v)])) : x);
  for (const k of ['design', 'protection', 'loadflow']) out[k] = fp(JSON.parse(JSON.stringify(out[k])));
  const s = JSON.stringify(out);
  writeFileSync(`${OUT}/${name}.json`, s);
  total += s.length;
  console.log(name, (s.length / 1e6).toFixed(2), 'MB', 'circuits', D.circuits && D.circuits.length, 'buses', PR.F && PR.F.buses.length, 'lf keys', Object.keys(LF).join(','));
}
console.log('total MB', (total / 1e6).toFixed(1));
