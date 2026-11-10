// The equipment datasheet library: PV modules, inverters, batteries, gensets, transformers and cables. Plain functions, no
// browser: the built-in entries (generic typical values), the consistency checks, CSV and JSON import and export, and the
// push of the selected datasheets into the energy model inputs. node --test ui/tests/equip.test.js covers them.
import { fmtNum, fmtSig } from '../format.js';
import { csvSplit } from '../csv.js';

export const EQ_TYPES = {
  pv: { label: 'PV modules', sel: true, fields: [
    ['name', 'Name', 'text'], ['manufacturer', 'Manufacturer', 'text'], ['pmax', 'Pmax (STC)', 'num', 'Wp'],
    ['vmp', 'Vmp', 'num', 'V'], ['imp', 'Imp', 'num', 'A'], ['voc', 'Voc', 'num', 'V'], ['isc', 'Isc', 'num', 'A'], ['n_cells_series', 'Cells in series', 'num', ''],
    ['gamma_p', 'Temp. coeff. Pmax', 'num', '%/°C'], ['beta_voc', 'Temp. coeff. Voc', 'num', '%/°C'], ['beta_vmp', 'Temp. coeff. Vmp', 'num', '%/°C'], ['alpha_isc', 'Temp. coeff. Isc', 'num', '%/°C'],
    ['noct', 'NOCT / NMOT', 'num', '°C'], ['eff', 'Efficiency', 'num', '%'], ['eff_rel_200', 'Relative efficiency at 200 W/m²', 'num', '%'],
    ['length', 'Length', 'num', 'm'], ['width', 'Width', 'num', 'm'], ['vsys', 'Max system voltage', 'num', 'V'], ['max_series_fuse', 'Max series fuse', 'num', 'A'],
    ['price', 'Price', 'num', '/Wp'], ['notes', 'Notes', 'text']],
    cols: ['pmax', 'voc', 'isc', 'eff', 'vsys'] },
  inverter: { label: 'PV inverters', sel: true, fields: [
    ['name', 'Name', 'text'], ['manufacturer', 'Manufacturer', 'text'], ['pac_kw', 'Rated AC power', 'num', 'kW'], ['pdc_max_kw', 'Max DC power', 'num', 'kW'],
    ['vdc_max', 'Max DC voltage', 'num', 'V'], ['vmppt_min', 'MPPT voltage min', 'num', 'V'], ['vmppt_max', 'MPPT voltage max', 'num', 'V'],
    ['n_mppt', 'Number of MPPT', 'num', ''], ['imax_mppt', 'Max input current per MPPT', 'num', 'A'], ['eff_euro', 'Euro / weighted efficiency', 'num', '%'],
    ['eff_max', 'Max efficiency', 'num', '%'], ['vac', 'AC output voltage', 'num', 'V'], ['ifault', 'Fault current contribution', 'num', '× rated'], ['price', 'Price', 'num', '/kW'], ['notes', 'Notes', 'text']],
    cols: ['pac_kw', 'vdc_max', 'vmppt_min', 'vmppt_max', 'eff_euro', 'vac'] },
  battery: { label: 'Batteries (BESS)', sel: true, fields: [
    ['name', 'Name', 'text'], ['manufacturer', 'Manufacturer', 'text'], ['chemistry', 'Chemistry', 'text'], ['energy_kwh', 'Usable energy per unit', 'num', 'kWh'],
    ['power_kw', 'PCS power per unit', 'num', 'kW'], ['pcs_noload_kw', 'PCS no-load loss per unit', 'num', 'kW'], ['rte', 'Round-trip efficiency (AC)', 'num', '%'],
    ['dod', 'Depth of discharge', 'num', '%'], ['cycle_life', 'Cycle life to EOL', 'num', 'cycles'], ['eol', 'End-of-life capacity', 'num', '%'], ['calendar_fade', 'Calendar fade', 'num', '%/yr'],
    ['vdc', 'DC voltage', 'num', 'V'], ['vac', 'PCS AC voltage', 'num', 'V'], ['ifault', 'PCS fault current contribution', 'num', '× rated'], ['price_kwh', 'Energy price', 'num', '/kWh'], ['price_kw', 'PCS price', 'num', '/kW'], ['notes', 'Notes', 'text']],
    cols: ['chemistry', 'energy_kwh', 'power_kw', 'rte', 'cycle_life', 'vac'] },
  genset: { label: 'Diesel generators', sel: true, fields: [
    ['name', 'Name', 'text'], ['manufacturer', 'Manufacturer', 'text'], ['prime_kw', 'Prime power', 'num', 'kWe'], ['kva', 'Apparent power', 'num', 'kVA'],
    ['voltage', 'Voltage', 'num', 'V'], ['pf', 'Power factor', 'num', ''], ['xd2', 'Subtransient reactance X″d', 'num', '%'], ['fuel_25', 'Fuel at 25 % load', 'num', 'L/h'], ['fuel_50', 'Fuel at 50 % load', 'num', 'L/h'],
    ['fuel_75', 'Fuel at 75 % load', 'num', 'L/h'], ['fuel_100', 'Fuel at 100 % load', 'num', 'L/h'], ['min_load', 'Minimum load', 'num', '%'],
    ['om_hour', 'O&M per run hour', 'num', '/h'], ['price', 'Price', 'num', '/kW'], ['notes', 'Notes', 'text']],
    cols: ['prime_kw', 'kva', 'voltage', 'fuel_50', 'fuel_100', 'min_load'] },
  transformer: { label: 'Transformers', sel: false, fields: [
    ['name', 'Name', 'text'], ['manufacturer', 'Manufacturer', 'text'], ['kva', 'Rated power', 'num', 'kVA'], ['hv_kv', 'HV voltage', 'num', 'kV'],
    ['lv_kv', 'LV voltage', 'num', 'kV'], ['z', 'Impedance', 'num', '%'], ['xr', 'X/R ratio', 'num', ''], ['p0', 'No-load loss', 'num', 'kW'], ['pk', 'Load loss at rated', 'num', 'kW'],
    ['vector', 'Vector group', 'text'], ['cooling', 'Cooling', 'text'], ['price', 'Price', 'num', '/unit'], ['notes', 'Notes', 'text']],
    cols: ['kva', 'hv_kv', 'lv_kv', 'z', 'p0', 'pk'] },
  cable: { label: 'Cables', sel: false, fields: [
    ['name', 'Name', 'text'], ['material', 'Conductor (Cu / Al)', 'text'], ['cores', 'Cores', 'num', ''], ['csa', 'Cross-section', 'num', 'mm²'],
    ['rating', 'Voltage rating', 'text'], ['r20', 'Conductor resistance at 20 °C', 'num', 'Ω/km'], ['x', 'Reactance', 'num', 'Ω/km'],
    ['ampacity', 'Current rating (reference installation)', 'num', 'A'], ['price', 'Price', 'num', '/m'], ['notes', 'Notes', 'text']],
    cols: ['material', 'csa', 'rating', 'r20', 'ampacity'] },
  breaker: { label: 'Circuit breakers', sel: false, fields: [
    ['name', 'Name', 'text'], ['manufacturer', 'Manufacturer', 'text'], ['kind', 'Type (VCB / ACB / MCCB)', 'text'], ['ur_kv', 'Rated voltage', 'num', 'kV'],
    ['ir', 'Rated current', 'num', 'A'], ['icu_ka', 'Rated breaking capacity', 'num', 'kA'], ['icm_ka', 'Rated making capacity', 'num', 'kA peak'],
    ['icw_ka', 'Rated short-time withstand current', 'num', 'kA'], ['tk', 'Short-time withstand duration', 'num', 's'], ['price', 'Price', 'num', '/unit'], ['notes', 'Notes', 'text']],
    cols: ['kind', 'ur_kv', 'ir', 'icu_ka', 'icw_ka'] },
};

const GEN = 'Generic typical values. Replace with the manufacturer datasheet.';

export function defaultLibrary() {
  return {
    pv: [
      { id: 'pv665', name: 'Generic 665 Wp mono PERC', manufacturer: 'Generic', pmax: 665, vmp: 38.3, imp: 17.37, voc: 45.9, isc: 18.55, n_cells_series: 66, gamma_p: -0.34, beta_voc: -0.25, alpha_isc: 0.045, eff: 21.4, length: 2.384, width: 1.303, vsys: 1500, price: 0.2, notes: GEN },
      { id: 'pv600', name: 'Generic 600 Wp n-type TOPCon (182 mm, 72 cells)', manufacturer: 'Generic', pmax: 600, vmp: 44.4, imp: 13.52, voc: 52.6, isc: 14.2, n_cells_series: 72, gamma_p: -0.29, beta_voc: -0.25, alpha_isc: 0.046, eff: 23.2, length: 2.278, width: 1.134, vsys: 1500, price: 0.19, notes: GEN },
      { id: 'pv720', name: 'Generic 720 Wp n-type TOPCon (210 mm, 132 cells)', manufacturer: 'Generic', pmax: 720, vmp: 41.2, imp: 17.48, voc: 49.4, isc: 18.4, n_cells_series: 66, gamma_p: -0.29, beta_voc: -0.25, alpha_isc: 0.046, eff: 23.2, length: 2.384, width: 1.303, vsys: 1500, price: 0.19, notes: GEN },
    ],
    inverter: [
      { id: 'inv330', name: 'Generic 330 kW string inverter, 1500 V', manufacturer: 'Generic', pac_kw: 330, pdc_max_kw: 450, vdc_max: 1500, vmppt_min: 500, vmppt_max: 1500, n_mppt: 6, imax_mppt: 65, eff_euro: 98.5, eff_max: 99.0, vac: 800, ifault: 1.2, price: 30, notes: GEN },
      { id: 'inv4400', name: 'Generic 4.4 MVA central inverter, 1500 V', manufacturer: 'Generic', pac_kw: 4400, pdc_max_kw: 6000, vdc_max: 1500, vmppt_min: 875, vmppt_max: 1300, n_mppt: 1, imax_mppt: 5000, eff_euro: 98.7, eff_max: 99.0, vac: 630, ifault: 1.1, price: 25, notes: GEN },
      { id: 'inv100', name: 'Generic 100 kW string inverter, 1100 V', manufacturer: 'Generic', pac_kw: 100, pdc_max_kw: 150, vdc_max: 1100, vmppt_min: 200, vmppt_max: 1000, n_mppt: 10, imax_mppt: 30, eff_euro: 98.4, eff_max: 98.8, vac: 400, ifault: 1.5, price: 40, notes: GEN },
    ],
    battery: [
      { id: 'bat5', name: 'Generic 5 MWh LFP container + 2.5 MW PCS', manufacturer: 'Generic', chemistry: 'LFP', energy_kwh: 5016, power_kw: 2500, rte: 88, dod: 95, cycle_life: 8000, eol: 70, calendar_fade: 1.0, vdc: 1331, vac: 690, ifault: 1.2, price_kwh: 180, price_kw: 60, notes: GEN },
      { id: 'bat344', name: 'Generic 3.44 MWh LFP container + 1.72 MW PCS', manufacturer: 'Generic', chemistry: 'LFP', energy_kwh: 3440, power_kw: 1720, rte: 87, dod: 95, cycle_life: 7000, eol: 70, calendar_fade: 1.2, vdc: 1228, vac: 690, ifault: 1.2, price_kwh: 190, price_kw: 70, notes: GEN },
      { id: 'bat1', name: 'Generic 1 MWh LFP cabinet + 500 kW PCS', manufacturer: 'Generic', chemistry: 'LFP', energy_kwh: 1000, power_kw: 500, rte: 86, dod: 90, cycle_life: 6000, eol: 70, calendar_fade: 1.5, vdc: 832, vac: 400, ifault: 1.5, price_kwh: 230, price_kw: 90, notes: GEN },
    ],
    genset: [
      { id: 'dg1800', name: 'Generic 1800 kWe prime diesel', manufacturer: 'Generic', prime_kw: 1800, kva: 2250, voltage: 400, pf: 0.8, xd2: 14, fuel_25: 139.8, fuel_50: 239.4, fuel_75: 342.6, fuel_100: 453.4, min_load: 30, om_hour: 2.0, price: 0, notes: 'Efficiency curve of a 925 kW reference engine, scaled. ' + GEN },
      { id: 'dg1000', name: 'Generic 1000 kWe prime diesel', manufacturer: 'Generic', prime_kw: 1000, kva: 1250, voltage: 400, pf: 0.8, xd2: 14, fuel_25: 75, fuel_50: 135, fuel_75: 195, fuel_100: 260, min_load: 30, om_hour: 1.5, price: 350, notes: GEN },
      { id: 'dg500', name: 'Generic 500 kWe prime diesel', manufacturer: 'Generic', prime_kw: 500, kva: 625, voltage: 400, pf: 0.8, xd2: 13, fuel_25: 40, fuel_50: 71, fuel_75: 101, fuel_100: 133, min_load: 30, om_hour: 1.0, price: 380, notes: GEN },
    ],
    transformer: [
      { id: 'tr2500', name: 'Generic 2500 kVA 0.4/20 kV ONAN', manufacturer: 'Generic', kva: 2500, hv_kv: 20, lv_kv: 0.4, z: 6, p0: 2.1, pk: 22, vector: 'Dyn11', cooling: 'ONAN', price: 45000, notes: GEN },
      { id: 'tr3150', name: 'Generic 3150 kVA 0.8/20 kV ONAN (PV)', manufacturer: 'Generic', kva: 3150, hv_kv: 20, lv_kv: 0.8, z: 7, p0: 2.6, pk: 27, vector: 'Dy11', cooling: 'ONAN', price: 52000, notes: GEN },
      { id: 'tr5000', name: 'Generic 5000 kVA 0.69/20 kV ONAN (BESS)', manufacturer: 'Generic', kva: 5000, hv_kv: 20, lv_kv: 0.69, z: 7.5, p0: 3.8, pk: 38, vector: 'Dy11', cooling: 'ONAN', price: 75000, notes: GEN },
      { id: 'tr30000', name: 'Generic 30 MVA 20/150 kV ONAN/ONAF', manufacturer: 'Generic', kva: 30000, hv_kv: 150, lv_kv: 20, z: 10, p0: 15, pk: 130, vector: 'YNd11', cooling: 'ONAN/ONAF', price: 900000, notes: GEN },
    ],
    cable: [
      { id: 'dc4', name: 'PV DC 1×4 mm² Cu, 1.5 kV', material: 'Cu', cores: 1, csa: 4, rating: '1.5 kV DC', r20: 5.09, x: 0, ampacity: 55, price: 0.6, notes: 'H1Z2Z2-K class. ' + GEN },
      { id: 'dc6', name: 'PV DC 1×6 mm² Cu, 1.5 kV', material: 'Cu', cores: 1, csa: 6, rating: '1.5 kV DC', r20: 3.39, x: 0, ampacity: 70, price: 0.8, notes: GEN },
      { id: 'dc10', name: 'PV DC 1×10 mm² Cu, 1.5 kV', material: 'Cu', cores: 1, csa: 10, rating: '1.5 kV DC', r20: 1.95, x: 0, ampacity: 98, price: 1.2, notes: GEN },
      { id: 'lv95al', name: 'LV 1×95 mm² Al, 0.6/1 kV', material: 'Al', cores: 1, csa: 95, rating: '0.6/1 kV', r20: 0.32, x: 0.085, ampacity: 220, price: 3, notes: GEN },
      { id: 'lv240al', name: 'LV 1×240 mm² Al, 0.6/1 kV', material: 'Al', cores: 1, csa: 240, rating: '0.6/1 kV', r20: 0.125, x: 0.08, ampacity: 390, price: 6, notes: GEN },
      { id: 'lv400al', name: 'LV 1×400 mm² Al, 0.6/1 kV', material: 'Al', cores: 1, csa: 400, rating: '0.6/1 kV', r20: 0.0778, x: 0.078, ampacity: 515, price: 9, notes: GEN },
      { id: 'lv630cu', name: 'LV 1×630 mm² Cu, 0.6/1 kV', material: 'Cu', cores: 1, csa: 630, rating: '0.6/1 kV', r20: 0.0283, x: 0.075, ampacity: 920, price: 45, notes: GEN },
      { id: 'mv95al', name: 'MV 3×1×95 mm² Al, 12/20 kV', material: 'Al', cores: 3, csa: 95, rating: '12/20 kV', r20: 0.32, x: 0.13, ampacity: 245, price: 18, notes: GEN },
      { id: 'mv150al', name: 'MV 3×1×150 mm² Al, 12/20 kV', material: 'Al', cores: 3, csa: 150, rating: '12/20 kV', r20: 0.206, x: 0.12, ampacity: 310, price: 22, notes: GEN },
      { id: 'mv240al', name: 'MV 3×1×240 mm² Al, 12/20 kV', material: 'Al', cores: 3, csa: 240, rating: '12/20 kV', r20: 0.125, x: 0.11, ampacity: 405, price: 28, notes: GEN },
      { id: 'mv400al', name: 'MV 3×1×400 mm² Al, 12/20 kV', material: 'Al', cores: 3, csa: 400, rating: '12/20 kV', r20: 0.0778, x: 0.105, ampacity: 520, price: 38, notes: GEN },
      { id: 'mv630al', name: 'MV 3×1×630 mm² Al, 12/20 kV', material: 'Al', cores: 3, csa: 630, rating: '12/20 kV', r20: 0.0469, x: 0.1, ampacity: 660, price: 55, notes: GEN },
    ],
    breaker: [
      { id: 'vcb630', name: 'Generic 24 kV 630 A 16 kA vacuum breaker', manufacturer: 'Generic', kind: 'VCB', ur_kv: 24, ir: 630, icu_ka: 16, icm_ka: 40, icw_ka: 16, tk: 3, price: 18000, notes: GEN },
      { id: 'vcb1250', name: 'Generic 24 kV 1250 A 25 kA vacuum breaker', manufacturer: 'Generic', kind: 'VCB', ur_kv: 24, ir: 1250, icu_ka: 25, icm_ka: 63, icw_ka: 25, tk: 3, price: 24000, notes: GEN },
      { id: 'vcb2500', name: 'Generic 24 kV 2500 A 31.5 kA vacuum breaker', manufacturer: 'Generic', kind: 'VCB', ur_kv: 24, ir: 2500, icu_ka: 31.5, icm_ka: 80, icw_ka: 31.5, tk: 3, price: 38000, notes: GEN },
      { id: 'mccb630', name: 'Generic 630 A moulded-case breaker, 690 V', manufacturer: 'Generic', kind: 'MCCB', ur_kv: 0.69, ir: 630, icu_ka: 36, icm_ka: 76, icw_ka: null, tk: null, price: 2500, notes: GEN },
      { id: 'acb1600', name: 'Generic 1600 A air circuit breaker, 1000 V', manufacturer: 'Generic', kind: 'ACB', ur_kv: 1, ir: 1600, icu_ka: 50, icm_ka: 105, icw_ka: 50, tk: 1, price: 9000, notes: GEN },
      { id: 'acb2500', name: 'Generic 2500 A air circuit breaker, 1000 V', manufacturer: 'Generic', kind: 'ACB', ur_kv: 1, ir: 2500, icu_ka: 66, icm_ka: 145, icw_ka: 66, tk: 1, price: 13000, notes: GEN },
      { id: 'acb4000', name: 'Generic 4000 A air circuit breaker, 1000 V', manufacturer: 'Generic', kind: 'ACB', ur_kv: 1, ir: 4000, icu_ka: 85, icm_ka: 187, icw_ka: 85, tk: 1, price: 21000, notes: GEN },
      { id: 'acb6300', name: 'Generic 6300 A air circuit breaker, 1000 V', manufacturer: 'Generic', kind: 'ACB', ur_kv: 1, ir: 6300, icu_ka: 100, icm_ka: 220, icw_ka: 100, tk: 1, price: 32000, notes: GEN },
    ],
  };
}

// A project file from an older version: built-in datasheets copied from an older library are brought in line with the
// current one (note text, the cell count of the built-in modules, names that had a bracketed suffix).
export function migrateEquipment(p) {
  const lib = (p.equipment && p.equipment.lib) || {};
  for (const list of Object.values(lib))
    if (Array.isArray(list)) list.forEach((e) => { if (e.notes === 'Generic typical values \u2014 replace with the manufacturer datasheet.') e.notes = GEN; });
  const lib0 = defaultLibrary();
  (lib.pv || []).forEach((e) => {
    const b = lib0.pv.find((x) => x.id === e.id);
    if (b && e.n_cells_series === undefined && e.voc === b.voc) e.n_cells_series = b.n_cells_series;
  });
  // the breakers and the short-circuit values came later: a built-in datasheet gets them, a library without breakers the built-in ones
  if (p.equipment && p.equipment.lib && !Array.isArray(lib.breaker)) lib.breaker = lib0.breaker;
  /** @type {[string, string][]} */
  const added = [['inverter', 'ifault'], ['battery', 'ifault'], ['genset', 'xd2']];
  for (const [cat, k] of added)
    (lib[cat] || []).forEach((e) => { const b = lib0[cat].find((x) => x.id === e.id); if (b && e[k] === undefined) e[k] = b[k]; });
  for (const [cat, list] of Object.entries(lib))
    if (Array.isArray(list)) list.forEach((e) => {
      const b = (lib0[cat] || []).find((x) => x.id === e.id);
      if (b && typeof e.name === 'string' && e.name.startsWith(b.name + ' (') && e.name.endsWith(')')) e.name = b.name;
      if (b && b.notes && typeof e.notes === 'string' && e.notes !== b.notes && e.notes.endsWith(GEN) && e.notes.slice(0, 16) === b.notes.slice(0, 16)) e.notes = b.notes;
    });
}

export const findIn = (lib, t, id) => ((lib && lib[t]) || []).find((e) => e.id === id);
export const selectedIn = (P, t) => findIn(P.equipment.lib, t, P.equipment.sel[t]);
export const newId = (t) => t + Math.random().toString(36).slice(2, 8);

const num = (x) => typeof x === 'number' && isFinite(x);

// Datasheet consistency checks shown under the editor: { warn: [text], notes: [text] }
export function checks(t, e) {
  const warn = [], notes = [];
  if (t === 'pv') {
    if (e.vmp && e.imp && e.pmax && Math.abs(e.vmp * e.imp - e.pmax) / e.pmax > 0.03) warn.push(`Vmp × Imp = ${fmtNum(e.vmp * e.imp, 1)} W differs from Pmax by more than 3 %.`);
    if (e.length && e.width && e.pmax && e.eff && Math.abs(e.pmax / (e.length * e.width * 1000) * 100 - e.eff) > 0.6) warn.push(`Pmax / area gives ${fmtNum(e.pmax / (e.length * e.width * 10), 1)} % efficiency. Check the dimensions or the efficiency.`);
    if (e.voc && e.vmp && e.vmp >= e.voc) warn.push('Vmp should be below Voc.');
    if (num(e.isc) && num(e.imp) && e.isc <= e.imp) warn.push('Isc should be above Imp.');
    // catches wrong cell counts and coefficients typed in the wrong unit
    if (e.voc && e.n_cells_series > 0 && (e.voc / e.n_cells_series < 0.58 || e.voc / e.n_cells_series > 0.78)) warn.push(`Voc per cell = ${fmtNum(e.voc / e.n_cells_series, 3)} V is outside 0.58–0.78 V. Check the cells in series (half-cut modules: 144 half cells = 72 in series).`);
    if (e.pmax && e.voc && e.isc) { const ff = e.pmax / (e.voc * e.isc); if (ff < 0.74 || ff > 0.85) warn.push(`Fill factor Pmax / (Voc × Isc) = ${fmtNum(ff, 3)} is outside 0.74–0.85.`); }
    if (num(e.alpha_isc) && (e.alpha_isc < 0.02 || e.alpha_isc > 0.08)) warn.push(`Temp. coeff. Isc ${fmtSig(e.alpha_isc)} %/°C is outside 0.02–0.08 %/°C. Check the unit.`);
    if (num(e.beta_vmp) && num(e.beta_voc) && Math.abs(e.beta_vmp) < Math.abs(e.beta_voc)) warn.push('Temp. coeff. Vmp should be larger in magnitude than Temp. coeff. Voc: Vmp falls faster with temperature.');
    if (num(e.beta_vmp) && e.beta_vmp >= 0) warn.push('Temp. coeff. Vmp should be negative: Vmp falls with temperature.');
    // values typed as a reduction or a fraction would cut the yield silently
    if (num(e.eff_rel_200) && (e.eff_rel_200 < 85 || e.eff_rel_200 > 105)) warn.push(`Relative efficiency at 200 W/m² ${fmtSig(e.eff_rel_200)} % is outside 85–105 %. Enter the efficiency relative to STC (e.g. 97), not the reduction (3) or a fraction (0.97).`);
    if (num(e.noct) && (e.noct < 30 || e.noct > 65)) warn.push(`NOCT / NMOT ${fmtSig(e.noct)} °C is outside 30–65 °C.`);
    if (num(e.beta_voc) && num(e.gamma_p) && e.gamma_p !== 0 && Math.abs(e.beta_voc) >= Math.abs(e.gamma_p)) notes.push('Temp. coeff. Voc is at least as large in magnitude as Temp. coeff. Pmax: unusual except for heterojunction modules.');
  }
  if (t === 'genset' && e.fuel_25 && e.fuel_100 && !(e.fuel_25 < e.fuel_50 && e.fuel_50 < e.fuel_75 && e.fuel_75 < e.fuel_100)) warn.push('Fuel consumption should increase with load.');
  if (t === 'transformer' && e.kva && e.pk && e.pk / e.kva > 0.02) warn.push('Load loss above 2 % of rating is unusually high.');
  if (t === 'transformer' && num(e.xr) && (e.xr < 1 || e.xr > 40)) warn.push(`X/R ratio ${fmtSig(e.xr)} is outside 1–40.`);
  if (t === 'genset' && num(e.xd2) && (e.xd2 < 5 || e.xd2 > 35)) warn.push(`Subtransient reactance ${fmtSig(e.xd2)} % is outside 5–35 %. Enter it in percent of the genset rating.`);
  if ((t === 'inverter' || t === 'battery') && num(e.ifault) && (e.ifault < 1 || e.ifault > 3)) warn.push(`Fault current contribution ${fmtSig(e.ifault)} × rated is outside 1–3.`);
  if (t === 'breaker' && num(e.icm_ka) && num(e.icu_ka) && e.icm_ka < e.icu_ka * 1.4) warn.push('Making capacity is usually at least 2 × the breaking capacity (peak against r.m.s.).');
  if (t === 'battery' && e.rte && (e.rte < 70 || e.rte > 98)) warn.push('Round-trip efficiency outside 70–98 %.');
  if (t === 'battery' && e.pcs_noload_kw > 0 && e.power_kw > 0 && e.pcs_noload_kw / e.power_kw > 0.01) warn.push('PCS no-load loss above 1 % of the PCS power is unusually high.');
  return { warn, notes };
}

// Push the selected datasheets into the energy model inputs. Returns { msg: [what was applied], skipped: [what was left out] }.
export function applyToModel(P) {
  const pv = selectedIn(P, 'pv'), inv = selectedIn(P, 'inverter'), bat = selectedIn(P, 'battery'), dg = selectedIn(P, 'genset');
  const msg = [], skipped = [];
  if (pv) {
    Object.assign(P.pv, { module_wp: pv.pmax, module_eff: pv.eff / 100, gamma_pmax: pv.gamma_p / 100, module_length: pv.length, module_width: pv.width });
    const extra = [];
    // implausible values (the checks under the editor warn about them) are left out rather than written to the model
    if (pv.noct > 0) { if (pv.noct >= 30 && pv.noct <= 65) { P.pv.noct = pv.noct; extra.push('NOCT'); } else skipped.push('NOCT'); }
    if (pv.eff_rel_200 > 0) {
      if (pv.eff_rel_200 >= 85 && pv.eff_rel_200 <= 105) { P.pv.low_irr_loss_200 = +(1 - pv.eff_rel_200 / 100).toFixed(5); extra.push('low-irradiance loss'); }
      else skipped.push('relative efficiency at 200 W/m²');
    }
    msg.push('PV module' + (extra.length ? ` (incl. ${extra.join(', ')})` : ''));
  }
  if (inv) {
    P.pv.inverter_eff = inv.eff_euro / 100;
    if (inv.eff_max > inv.eff_euro) P.pv.inverter_eff_max = inv.eff_max / 100;   // the part-load curve between the two
    msg.push('inverter efficiency');
  }
  if (bat) {
    Object.assign(P.bess, { rte: bat.rte / 100, soc_min: Math.max(0, 1 - bat.dod / 100), soc_max: 1, cycle_life: bat.cycle_life, cycle_life_dod: Math.min(1, bat.dod / 100) || 1,
      eol_soh: bat.eol / 100, calendar_fade: bat.calendar_fade / 100 });
    if (bat.price_kwh) P.econ.bess_capex_kwh = bat.price_kwh;
    if (bat.price_kw != null) P.econ.bess_capex_kw = bat.price_kw;
    if (bat.price_kwh) P.econ.bess_replace_kwh = Math.round(bat.price_kwh * 0.8);
    // PCS no-load loss per unit as kW per MW of PCS rating, so in the model it scales with the battery power; above 1 % of
    // the PCS power (the check under the editor warns) it is left out, as a value typed in W would be
    const pcs = bat.pcs_noload_kw > 0 && bat.power_kw > 0;
    const pcsOk = pcs && bat.pcs_noload_kw / bat.power_kw <= 0.01;
    if (pcsOk) P.aux.pcs_kw_per_mw = +(1000 * bat.pcs_noload_kw / bat.power_kw).toFixed(3);
    else if (pcs) skipped.push('PCS no-load loss');
    msg.push('battery' + (pcsOk ? ` (incl. PCS no-load loss ${fmtNum(P.aux.pcs_kw_per_mw, 2)} kW/MW)` : ''));
  }
  if (dg) {
    P.diesel.unit_kw = dg.prime_kw;
    P.diesel.min_load = dg.min_load / 100;
    P.diesel.fuel_model = 'table';
    P.diesel.fuel_curve = [[0.25, dg.fuel_25], [0.5, dg.fuel_50], [0.75, dg.fuel_75], [1, dg.fuel_100]]
      .filter(([, f]) => f > 0).map(([lf, f]) => [lf, +(lf * dg.prime_kw / f).toFixed(3)]);
    if (dg.om_hour != null) P.econ.diesel_om_unit_hour = dg.om_hour;
    msg.push('genset (rating, min load, fuel curve)');
  }
  return { msg, skipped };
}

// ---------------------------------------------------------------- CSV
function delimOf(line) {
  return (line.match(/;/g) || []).length > (line.match(/,/g) || []).length ? ';' : (line.includes('\t') ? '\t' : ',');
}
// CSV text as { header: [lower-case names] | null, rows: [[cells]] }
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { header: null, rows: [] };
  const d = delimOf(lines[0]), first = csvSplit(lines[0], d);
  const header = first.some((c) => c !== '' && isNaN(Number(c)) && !/^\d{1,4}[-/:]/.test(c)) ? first.map((c) => c.toLowerCase()) : null;
  return { header, rows: lines.slice(header ? 1 : 0).map((l) => csvSplit(l, d)) };
}

// The datasheets of one type as CSV text. A text cell that starts with = + - @ tab or return gets a leading ' so a spreadsheet
// does not run it as a formula.
export function exportCsv(lib, type) {
  const T = EQ_TYPES[type];
  const lines = [T.fields.map((f) => f[0]).join(',')];
  const cell = (v) => {
    let s = String(v ?? '');
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  (lib[type] || []).forEach((e) => lines.push(T.fields.map(([k]) => cell(e[k])).join(',')));
  return lines.join('\n');
}

// Datasheets of one type from CSV text (header of field keys or labels). Returns the new entries; throws without a header.
export function importCsv(text, type) {
  const { header, rows } = parseCsv(text);
  if (!header) throw new Error('CSV needs a header row with field names.');
  const T = EQ_TYPES[type];
  const fieldOf = (h) => T.fields.find((fd) => fd[0] === h || fd[1].toLowerCase() === h);
  return rows.map((r) => {
    const e = { id: newId(type) };
    header.forEach((h, i) => { const fd = fieldOf(h); if (fd) e[fd[0]] = fd[2] === 'num' ? (r[i] == null || r[i] === '' ? null : +r[i]) : r[i]; });
    return e;
  });
}

// Datasheets from a JSON library file, added to `lib`; an entry keeps its id unless the library has it. Returns how many.
export function importJson(lib, text) {
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object') throw new Error('Not an equipment library.');
  let n = 0;
  for (const t of Object.keys(EQ_TYPES)) {
    if (!Array.isArray(j[t])) continue;
    for (const e of j[t]) {
      if (!e || typeof e !== 'object') continue;
      (lib[t] || (lib[t] = [])).push({ ...e, id: typeof e.id === 'string' && e.id && !findIn(lib, t, e.id) ? e.id : newId(t) });
      n++;
    }
  }
  return n;
}
