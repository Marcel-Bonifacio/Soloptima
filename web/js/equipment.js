// Equipment datasheet library: PV modules, inverters, batteries, gensets, transformers, cables.
// Built-in entries are generic typical values; replace them with manufacturer datasheets.
'use strict';

const EQ_TYPES = {
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
    ['eff_max', 'Max efficiency', 'num', '%'], ['vac', 'AC output voltage', 'num', 'V'], ['price', 'Price', 'num', '/kW'], ['notes', 'Notes', 'text']],
    cols: ['pac_kw', 'vdc_max', 'vmppt_min', 'vmppt_max', 'eff_euro', 'vac'] },
  battery: { label: 'Batteries (BESS)', sel: true, fields: [
    ['name', 'Name', 'text'], ['manufacturer', 'Manufacturer', 'text'], ['chemistry', 'Chemistry', 'text'], ['energy_kwh', 'Usable energy per unit', 'num', 'kWh'],
    ['power_kw', 'PCS power per unit', 'num', 'kW'], ['pcs_noload_kw', 'PCS no-load loss per unit', 'num', 'kW'], ['rte', 'Round-trip efficiency (AC)', 'num', '%'],
    ['dod', 'Depth of discharge', 'num', '%'], ['cycle_life', 'Cycle life to EOL', 'num', 'cycles'], ['eol', 'End-of-life capacity', 'num', '%'], ['calendar_fade', 'Calendar fade', 'num', '%/yr'],
    ['vdc', 'DC voltage', 'num', 'V'], ['vac', 'PCS AC voltage', 'num', 'V'], ['price_kwh', 'Energy price', 'num', '/kWh'], ['price_kw', 'PCS price', 'num', '/kW'], ['notes', 'Notes', 'text']],
    cols: ['chemistry', 'energy_kwh', 'power_kw', 'rte', 'cycle_life', 'vac'] },
  genset: { label: 'Diesel generators', sel: true, fields: [
    ['name', 'Name', 'text'], ['manufacturer', 'Manufacturer', 'text'], ['prime_kw', 'Prime power', 'num', 'kWe'], ['kva', 'Apparent power', 'num', 'kVA'],
    ['voltage', 'Voltage', 'num', 'V'], ['pf', 'Power factor', 'num', ''], ['fuel_25', 'Fuel at 25 % load', 'num', 'L/h'], ['fuel_50', 'Fuel at 50 % load', 'num', 'L/h'],
    ['fuel_75', 'Fuel at 75 % load', 'num', 'L/h'], ['fuel_100', 'Fuel at 100 % load', 'num', 'L/h'], ['min_load', 'Minimum load', 'num', '%'],
    ['om_hour', 'O&M per run hour', 'num', '/h'], ['price', 'Price', 'num', '/kW'], ['notes', 'Notes', 'text']],
    cols: ['prime_kw', 'kva', 'voltage', 'fuel_50', 'fuel_100', 'min_load'] },
  transformer: { label: 'Transformers', sel: false, fields: [
    ['name', 'Name', 'text'], ['manufacturer', 'Manufacturer', 'text'], ['kva', 'Rated power', 'num', 'kVA'], ['hv_kv', 'HV voltage', 'num', 'kV'],
    ['lv_kv', 'LV voltage', 'num', 'kV'], ['z', 'Impedance', 'num', '%'], ['p0', 'No-load loss', 'num', 'kW'], ['pk', 'Load loss at rated', 'num', 'kW'],
    ['vector', 'Vector group', 'text'], ['cooling', 'Cooling', 'text'], ['price', 'Price', 'num', '/unit'], ['notes', 'Notes', 'text']],
    cols: ['kva', 'hv_kv', 'lv_kv', 'z', 'p0', 'pk'] },
  cable: { label: 'Cables', sel: false, fields: [
    ['name', 'Name', 'text'], ['material', 'Conductor (Cu / Al)', 'text'], ['cores', 'Cores', 'num', ''], ['csa', 'Cross-section', 'num', 'mm²'],
    ['rating', 'Voltage rating', 'text'], ['r20', 'Conductor resistance at 20 °C', 'num', 'Ω/km'], ['x', 'Reactance', 'num', 'Ω/km'],
    ['ampacity', 'Current rating (reference installation)', 'num', 'A'], ['price', 'Price', 'num', '/m'], ['notes', 'Notes', 'text']],
    cols: ['material', 'csa', 'rating', 'r20', 'ampacity'] },
};

const GEN = 'Generic typical values. Replace with the manufacturer datasheet.';
function defaultLibrary() {
  return {
    pv: [
      { id: 'pv665', name: 'Generic 665 Wp mono PERC', manufacturer: 'Generic', pmax: 665, vmp: 38.3, imp: 17.37, voc: 45.9, isc: 18.55, n_cells_series: 66, gamma_p: -0.34, beta_voc: -0.25, alpha_isc: 0.045, eff: 21.4, length: 2.384, width: 1.303, vsys: 1500, price: 0.2, notes: GEN },
      { id: 'pv600', name: 'Generic 600 Wp n-type TOPCon (182 mm, 72 cells)', manufacturer: 'Generic', pmax: 600, vmp: 44.4, imp: 13.52, voc: 52.6, isc: 14.2, n_cells_series: 72, gamma_p: -0.29, beta_voc: -0.25, alpha_isc: 0.046, eff: 23.2, length: 2.278, width: 1.134, vsys: 1500, price: 0.19, notes: GEN },
      { id: 'pv720', name: 'Generic 720 Wp n-type TOPCon (210 mm, 132 cells)', manufacturer: 'Generic', pmax: 720, vmp: 41.2, imp: 17.48, voc: 49.4, isc: 18.4, n_cells_series: 66, gamma_p: -0.29, beta_voc: -0.25, alpha_isc: 0.046, eff: 23.2, length: 2.384, width: 1.303, vsys: 1500, price: 0.19, notes: GEN },
    ],
    inverter: [
      { id: 'inv330', name: 'Generic 330 kW string inverter, 1500 V', manufacturer: 'Generic', pac_kw: 330, pdc_max_kw: 450, vdc_max: 1500, vmppt_min: 500, vmppt_max: 1500, n_mppt: 6, imax_mppt: 65, eff_euro: 98.5, eff_max: 99.0, vac: 800, price: 30, notes: GEN },
      { id: 'inv4400', name: 'Generic 4.4 MVA central inverter, 1500 V', manufacturer: 'Generic', pac_kw: 4400, pdc_max_kw: 6000, vdc_max: 1500, vmppt_min: 875, vmppt_max: 1300, n_mppt: 1, imax_mppt: 5000, eff_euro: 98.7, eff_max: 99.0, vac: 630, price: 25, notes: GEN },
      { id: 'inv100', name: 'Generic 100 kW string inverter, 1100 V', manufacturer: 'Generic', pac_kw: 100, pdc_max_kw: 150, vdc_max: 1100, vmppt_min: 200, vmppt_max: 1000, n_mppt: 10, imax_mppt: 30, eff_euro: 98.4, eff_max: 98.8, vac: 400, price: 40, notes: GEN },
    ],
    battery: [
      { id: 'bat5', name: 'Generic 5 MWh LFP container + 2.5 MW PCS', manufacturer: 'Generic', chemistry: 'LFP', energy_kwh: 5016, power_kw: 2500, rte: 88, dod: 95, cycle_life: 8000, eol: 70, calendar_fade: 1.0, vdc: 1331, vac: 690, price_kwh: 180, price_kw: 60, notes: GEN },
      { id: 'bat344', name: 'Generic 3.44 MWh LFP container + 1.72 MW PCS', manufacturer: 'Generic', chemistry: 'LFP', energy_kwh: 3440, power_kw: 1720, rte: 87, dod: 95, cycle_life: 7000, eol: 70, calendar_fade: 1.2, vdc: 1228, vac: 690, price_kwh: 190, price_kw: 70, notes: GEN },
      { id: 'bat1', name: 'Generic 1 MWh LFP cabinet + 500 kW PCS', manufacturer: 'Generic', chemistry: 'LFP', energy_kwh: 1000, power_kw: 500, rte: 86, dod: 90, cycle_life: 6000, eol: 70, calendar_fade: 1.5, vdc: 832, vac: 400, price_kwh: 230, price_kw: 90, notes: GEN },
    ],
    genset: [
      { id: 'dg1800', name: 'Generic 1800 kWe prime diesel', manufacturer: 'Generic', prime_kw: 1800, kva: 2250, voltage: 400, pf: 0.8, fuel_25: 139.8, fuel_50: 239.4, fuel_75: 342.6, fuel_100: 453.4, min_load: 30, om_hour: 2.0, price: 0, notes: 'Efficiency curve of a 925 kW reference engine, scaled. ' + GEN },
      { id: 'dg1000', name: 'Generic 1000 kWe prime diesel', manufacturer: 'Generic', prime_kw: 1000, kva: 1250, voltage: 400, pf: 0.8, fuel_25: 75, fuel_50: 135, fuel_75: 195, fuel_100: 260, min_load: 30, om_hour: 1.5, price: 350, notes: GEN },
      { id: 'dg500', name: 'Generic 500 kWe prime diesel', manufacturer: 'Generic', prime_kw: 500, kva: 625, voltage: 400, pf: 0.8, fuel_25: 40, fuel_50: 71, fuel_75: 101, fuel_100: 133, min_load: 30, om_hour: 1.0, price: 380, notes: GEN },
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
  };
}

const Equipment = (() => {
  let P, onChange, type = 'pv', editId = null;
  const lib = () => P.equipment.lib;
  const find = (t, id) => (lib()[t] || []).find((e) => e.id === id);
  const selected = (t) => find(t, P.equipment.sel[t]);

  function init(project, changed) {
    P = project; onChange = changed;
    const seg = $('#eqType');
    seg.innerHTML = Object.entries(EQ_TYPES).map(([k, v]) => `<button data-v="${k}" class="${k === type ? 'on' : ''}">${v.label}</button>`).join('');
    $$('#eqType button').forEach((b) => b.addEventListener('click', () => { type = b.dataset.v; editId = null; $$('#eqType button').forEach((x) => x.classList.toggle('on', x === b)); render(); }));
    $('#eqNew').onclick = () => { const e = { id: uid(), name: 'New datasheet', manufacturer: '' }; lib()[type].push(e); editId = e.id; save(); };
    $('#eqImport').onchange = importFile;
    $('#eqExportJson').onclick = () => download('equipment_library.json', JSON.stringify(lib(), null, 1), 'application/json');
    $('#eqExportCsv').onclick = exportCsv;
    $('#eqReset').onclick = () => { if (!confirm('Restore the built-in generic library? Your own entries in this project are removed.')) return; P.equipment.lib = defaultLibrary(); save(); };
    $('#eqApply').onclick = applyToModel;
    render();
  }
  function reload(project) { P = project; editId = null; render(); }
  const uid = (t = type) => t + Math.random().toString(36).slice(2, 8);
  function save() { onChange('equipment'); render(); }

  function render() { renderTable(); renderEditor(); renderSelected(); }

  function renderTable() {
    const T = EQ_TYPES[type], rows = lib()[type] || [];
    const fieldOf = (k) => T.fields.find((f) => f[0] === k);
    const tbl = $('#eqTable');
    tbl.innerHTML = `<table class="data"><tr>${T.sel ? '<th>Use</th>' : ''}<th>Name</th>${T.cols.map((k) => `<th>${fieldOf(k)[1]}${fieldOf(k)[3] ? ' (' + fieldOf(k)[3] + ')' : ''}</th>`).join('')}<th></th></tr>${
      rows.map((e) => `<tr class="${e.id === editId ? 'best' : ''}">${T.sel ? `<td><input type="radio" name="eqsel" data-sel="${escapeHtml(e.id)}" ${P.equipment.sel[type] === e.id ? 'checked' : ''}></td>` : ''}
        <td>${escapeHtml(e.name || '')}</td>${T.cols.map((k) => `<td>${typeof e[k] === 'number' ? fmtSig(e[k]) : escapeHtml(e[k] || '')}</td>`).join('')}
        <td><button class="btn small" data-edit="${escapeHtml(e.id)}">Edit</button> <button class="btn small ghost" data-dup="${escapeHtml(e.id)}" title="Duplicate">⧉</button> <button class="btn small ghost" data-del="${escapeHtml(e.id)}" title="Delete">✕</button></td></tr>`).join('')}</table>`;
    $$('[data-sel]', tbl).forEach((r) => (r.onchange = () => { P.equipment.sel[type] = r.dataset.sel; save(); }));
    $$('[data-edit]', tbl).forEach((b) => (b.onclick = () => { editId = b.dataset.edit; render(); }));
    $$('[data-dup]', tbl).forEach((b) => (b.onclick = () => { const c = { ...find(type, b.dataset.dup), id: uid() }; c.name += ' (copy)'; lib()[type].push(c); editId = c.id; save(); }));
    $$('[data-del]', tbl).forEach((b) => (b.onclick = () => { if (!confirm('Delete this datasheet?')) return; lib()[type] = rows.filter((e) => e.id !== b.dataset.del); if (editId === b.dataset.del) editId = null; save(); }));
  }

  function renderEditor() {
    const box = $('#eqEditor'), e = editId && find(type, editId);
    if (!e) { box.innerHTML = '<p class="hint">Select <b>Edit</b> on a row to view or change its datasheet values, or add a new one.</p>'; return; }
    const T = EQ_TYPES[type];
    box.innerHTML = `<h3>${escapeHtml(e.name)}</h3><div class="form">${T.fields.map(([k, l, t, u]) =>
      `<label for="eq_${k}">${l}${infoBtn('eq.' + k, l)}</label><div class="field"><input id="eq_${k}" data-ek="${k}" type="${t === 'num' ? 'number' : 'text'}" step="any" value="${escapeHtml(e[k] ?? '')}">${u ? `<span class="unit">${u}</span>` : ''}</div>`).join('')}</div><div class="eq-checks">${checks(type, e)}</div>`;
    $$('[data-ek]', box).forEach((inp) => inp.addEventListener('change', () => {
      const f = T.fields.find((x) => x[0] === inp.dataset.ek);
      e[inp.dataset.ek] = f[2] === 'num' ? (inp.value === '' ? null : +inp.value) : inp.value;
      onChange('equipment'); renderTable(); renderSelected();
      $('h3', box).textContent = e.name; $('.eq-checks', box).innerHTML = checks(type, e);
    }));
  }
  // Datasheet consistency checks shown under the editor.
  function checks(t, e) {
    const w = [], notes = [];
    if (t === 'pv') {
      const num = (x) => typeof x === 'number' && isFinite(x);
      if (e.vmp && e.imp && e.pmax && Math.abs(e.vmp * e.imp - e.pmax) / e.pmax > 0.03) w.push(`Vmp × Imp = ${fmtNum(e.vmp * e.imp, 1)} W differs from Pmax by more than 3 %.`);
      if (e.length && e.width && e.pmax && e.eff && Math.abs(e.pmax / (e.length * e.width * 1000) * 100 - e.eff) > 0.6) w.push(`Pmax / area gives ${fmtNum(e.pmax / (e.length * e.width * 10), 1)} % efficiency. Check the dimensions or the efficiency.`);
      if (e.voc && e.vmp && e.vmp >= e.voc) w.push('Vmp should be below Voc.');
      if (num(e.isc) && num(e.imp) && e.isc <= e.imp) w.push('Isc should be above Imp.');
      // catches wrong cell counts and coefficients typed in the wrong unit
      if (e.voc && e.n_cells_series > 0 && (e.voc / e.n_cells_series < 0.58 || e.voc / e.n_cells_series > 0.78)) w.push(`Voc per cell = ${fmtNum(e.voc / e.n_cells_series, 3)} V is outside 0.58–0.78 V. Check the cells in series (half-cut modules: 144 half cells = 72 in series).`);
      if (e.pmax && e.voc && e.isc) { const ff = e.pmax / (e.voc * e.isc); if (ff < 0.74 || ff > 0.85) w.push(`Fill factor Pmax / (Voc × Isc) = ${fmtNum(ff, 3)} is outside 0.74–0.85.`); }
      if (num(e.alpha_isc) && (e.alpha_isc < 0.02 || e.alpha_isc > 0.08)) w.push(`Temp. coeff. Isc ${fmtSig(e.alpha_isc)} %/°C is outside 0.02–0.08 %/°C. Check the unit.`);
      if (num(e.beta_vmp) && num(e.beta_voc) && Math.abs(e.beta_vmp) < Math.abs(e.beta_voc)) w.push('Temp. coeff. Vmp should be larger in magnitude than Temp. coeff. Voc: Vmp falls faster with temperature.');
      if (num(e.beta_vmp) && e.beta_vmp >= 0) w.push('Temp. coeff. Vmp should be negative: Vmp falls with temperature.');
      // values typed as a reduction or a fraction would cut the yield silently
      if (num(e.eff_rel_200) && (e.eff_rel_200 < 85 || e.eff_rel_200 > 105)) w.push(`Relative efficiency at 200 W/m² ${fmtSig(e.eff_rel_200)} % is outside 85–105 %. Enter the efficiency relative to STC (e.g. 97), not the reduction (3) or a fraction (0.97).`);
      if (num(e.noct) && (e.noct < 30 || e.noct > 65)) w.push(`NOCT / NMOT ${fmtSig(e.noct)} °C is outside 30–65 °C.`);
      if (num(e.beta_voc) && num(e.gamma_p) && e.gamma_p !== 0 && Math.abs(e.beta_voc) >= Math.abs(e.gamma_p)) notes.push('Temp. coeff. Voc is at least as large in magnitude as Temp. coeff. Pmax: unusual except for heterojunction modules.');
    }
    if (t === 'genset' && e.fuel_25 && e.fuel_100 && !(e.fuel_25 < e.fuel_50 && e.fuel_50 < e.fuel_75 && e.fuel_75 < e.fuel_100)) w.push('Fuel consumption should increase with load.');
    if (t === 'transformer' && e.kva && e.pk && e.pk / e.kva > 0.02) w.push('Load loss above 2 % of rating is unusually high.');
    if (t === 'battery' && e.rte && (e.rte < 70 || e.rte > 98)) w.push('Round-trip efficiency outside 70–98 %.');
    if (t === 'battery' && e.pcs_noload_kw > 0 && e.power_kw > 0 && e.pcs_noload_kw / e.power_kw > 0.01) w.push('PCS no-load loss above 1 % of the PCS power is unusually high.');
    return (w.length ? `<div class="warnbox mt">${w.map((x) => '⚠ ' + escapeHtml(x)).join('<br>')}</div>` : '') + notes.map((x) => `<p class="hint">${escapeHtml(x)}</p>`).join('');
  }

  function renderSelected() {
    const pv = selected('pv'), inv = selected('inverter'), bat = selected('battery'), dg = selected('genset');
    const nCont = bat && bat.energy_kwh ? P.bess.energy_kwh / bat.energy_kwh : 0;
    $('#eqSelected').innerHTML = `<table class="data">
      <tr><td>PV module</td><td>${pv ? escapeHtml(pv.name) : '–'}</td><td>${pv ? `${fmtNum(P.pv.capacity_kwp * 1000 / pv.pmax)} modules for ${fmtNum(P.pv.capacity_kwp)} kWp` : ''}</td></tr>
      <tr><td>PV inverter</td><td>${inv ? escapeHtml(inv.name) : '–'}</td><td>${inv ? `${fmtNum(Math.ceil(P.pv.capacity_kwp / P.pv.dc_ac_ratio / inv.pac_kw))} units at DC/AC ${escapeHtml(P.pv.dc_ac_ratio)}` : ''}</td></tr>
      <tr><td>Battery</td><td>${bat ? escapeHtml(bat.name) : '–'}</td><td>${bat ? `${fmtNum(nCont, 1)} units for ${fmtNum(P.bess.energy_kwh)} kWh${Math.abs(nCont - Math.round(nCont)) > 0.05 ? ' (not a whole number)' : ''}` : ''}</td></tr>
      <tr><td>Diesel generator</td><td>${dg ? escapeHtml(dg.name) : '–'}</td><td>${dg ? `fleet ${escapeHtml(P.diesel.units)} × ${fmtNum(P.diesel.unit_kw)} kW in the model` : ''}</td></tr></table>`;
  }

  // Push the selected datasheets into the energy model inputs.
  function applyToModel() {
    const pv = selected('pv'), inv = selected('inverter'), bat = selected('battery'), dg = selected('genset');
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
    if (inv) { P.pv.inverter_eff = inv.eff_euro / 100; msg.push('inverter efficiency'); }
    if (bat) {
      Object.assign(P.bess, { rte: bat.rte / 100, soc_min: Math.max(0, 1 - bat.dod / 100), soc_max: 1, cycle_life: bat.cycle_life, cycle_life_dod: Math.min(1, bat.dod / 100) || 1,
                              eol_soh: bat.eol / 100, calendar_fade: bat.calendar_fade / 100 });
      if (bat.price_kwh) P.econ.bess_capex_kwh = bat.price_kwh;
      if (bat.price_kw != null) P.econ.bess_capex_kw = bat.price_kw;
      if (bat.price_kwh) P.econ.bess_replace_kwh = Math.round(bat.price_kwh * 0.8);
      // PCS no-load loss per unit as kW per MW of PCS rating, so in the model it scales with the battery power;
      // above 1 % of the PCS power (the check under the editor warns) it is left out, as a value typed in W would be
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
    syncForms(P); onChange('equipment.apply'); drawFuel(); renderSelected();
    toast(msg.length ? 'Applied to model: ' + msg.join(', ') + (skipped.length ? `. Not applied, outside the plausible range: ${skipped.join(', ')}.` : '')
      : 'Select datasheets first (radio button "Use").', skipped.length > 0);
  }

  async function importFile(ev) {
    const f = ev.target.files[0]; if (!f) return; ev.target.value = '';
    try {
      const txt = await readFile(f);
      if (/\.json$/i.test(f.name)) {
        const j = JSON.parse(txt);
        let n = 0;
        for (const t of Object.keys(EQ_TYPES)) for (const e of j[t] || []) { lib()[t].push({ ...e, id: e.id && !find(t, e.id) ? e.id : uid(t) }); n++; }
        toast(`Imported ${n} datasheets`);
      } else {
        // CSV for the current type: header row with field keys (e.g. name,pmax,vmp,...) or labels.
        const { header, rows } = parseCSV(txt);
        if (!header) throw new Error('CSV needs a header row with field names.');
        const T = EQ_TYPES[type];
        const keyOf = (h) => (T.fields.find((fd) => fd[0] === h || fd[1].toLowerCase() === h) || [])[0];
        rows.forEach((r) => {
          const e = { id: uid() };
          header.forEach((h, i) => { const k = keyOf(h); if (!k) return; const fd = T.fields.find((x) => x[0] === k); e[k] = fd[2] === 'num' ? (r[i] == null || r[i] === '' ? null : +r[i]) : r[i]; });
          lib()[type].push(e);
        });
        toast(`Imported ${rows.length} ${T.label.toLowerCase()}`);
      }
      save();
    } catch (e) { toast('Import failed: ' + e.message, true); }
  }
  function exportCsv() {
    const T = EQ_TYPES[type];
    const lines = [T.fields.map((f) => f[0]).join(',')];
    (lib()[type] || []).forEach((e) => lines.push(T.fields.map(([k]) => { const v = e[k] ?? ''; return /[,"]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v; }).join(',')));
    download(`datasheets_${type}.csv`, lines.join('\n'), 'text/csv');
  }

  return { init, reload, find, selected, render };
})();
