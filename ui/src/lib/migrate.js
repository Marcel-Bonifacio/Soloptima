// The input rules applied to a project file on open (older files, files from others): the part of migrate() that concerns the
// schema forms (migrate-project.js adds the rest). `d` is {defaults, siteZone, mountStyleOf, loadTemplates, months}.

const MODEL_DEFAULTS_OF_OLD_FILES = { transposition: 'hay_davies', diffuse_shading: false, decomposition: 'erbs', clearsky: 'haurwitz',
  iam_model: 'ashrae', shade_model: 'linear', inverter_model: 'constant', degradation_model: 'compound', edge_rows: false, near_model: 'linear' };

// a list of numbers from a file: the right count of finite values in range, or null
export function numList(v, n0, n1, lo, hi) {
  return Array.isArray(v) && v.length >= n0 && v.length <= n1 && v.every((x) => typeof x === 'number' && x >= lo && x <= hi) ? v : null;
}

export function migrateForms(p, d) {
  // projects saved before the time-zone lookup: store the site's zone but keep the offset
  if (p.location && p.location.tz === undefined) {
    const L = p.location, z = d.siteZone(L.lat, L.lon), unset = L.utc_offset == null;
    if (unset) L.utc_offset = z ? z.std : Math.round(+L.lon / 15) || 0;
    L.tz = z ? z.tz : '';
    L.utc_offset_src = z && z.std === +L.utc_offset ? 'zone' : unset ? 'longitude' : 'saved';
  }
  // projects saved before these model options keep the models they were made with
  if (p.pv) for (const [k, v] of Object.entries(MODEL_DEFAULTS_OF_OLD_FILES)) if (p.pv[k] === undefined) p.pv[k] = v;
  // inputs added since: take the new project's value (one level deep)
  const def = d.defaults();
  for (const k of Object.keys(def)) {
    if (p[k] == null) p[k] = def[k];
    else if (typeof def[k] === 'object' && !Array.isArray(def[k]) && def[k] !== null) {
      for (const kk of Object.keys(def[k])) if (p[k][kk] === undefined) p[k][kk] = def[k][kk];
    }
  }
  p.econ.currency = String(p.econ.currency).replace(/[<>&"']/g, '');
  const F = p.finance;
  if (F) {   // the other currency's code is shown as text; lists and the debt period as the forms store them
    F.fx_currency = String(F.fx_currency ?? '').replace(/[<>&"']/g, '').slice(0, 8);
    F.cfads_months = numList(F.cfads_months, 12, 12, 0, 1e6);
    F.fx_table = numList(F.fx_table, 1, 60, 1e-9, 1e12);
    F.debt_periods = ['1', '2', '4', '12'].includes(String(F.debt_periods)) ? String(F.debt_periods) : '1';
  }
  if (p.pv.thermal_model !== 'noct') p.pv.thermal_model = 'uc_uv';
  p.pv.soiling_monthly = numList(p.pv.soiling_monthly, 12, 12, 0, 0.999);
  p.pv.albedo_monthly = numList(p.pv.albedo_monthly, 12, 12, 0, 1);
  p.pv.snow_monthly = numList(p.pv.snow_monthly, 12, 12, 0, 1000);
  p.pv.snow_events = numList(p.pv.snow_events, 12, 12, 0, 31);
  p.pv.horizon = numList(p.pv.horizon, 4, 720, 0, 89.9);
  // further genset groups: objects with a positive rating, at most 8
  if (p.diesel) {
    const ok = (g) => g && typeof g === 'object' && isFinite(+g.unit_kw) && +g.unit_kw > 0 && isFinite(+g.units) && +g.units >= 0;
    p.diesel.more_groups = Array.isArray(p.diesel.more_groups) ? p.diesel.more_groups.filter(ok).slice(0, 8).map((g) => ({
      name: String(g.name || '').replace(/[<>&"']/g, '').slice(0, 40), units: Math.round(+g.units), unit_kw: +g.unit_kw,
      min_load: isFinite(+g.min_load) && +g.min_load >= 0 && +g.min_load < 1 ? +g.min_load : +p.diesel.min_load || 0.3,
      fuel_curve: Array.isArray(g.fuel_curve) && g.fuel_curve.every((x) => Array.isArray(x) && x[0] > 0 && x[0] <= 1 && x[1] > 0) ? g.fuel_curve : null,
      capex_kw: g.capex_kw == null ? null : +g.capex_kw, om_kwh: g.om_kwh == null ? null : +g.om_kwh, om_unit_hour: g.om_unit_hour == null ? null : +g.om_unit_hour,
    })) : [];
  }
  if (p.grid) {
    p.grid.tou = numList(p.grid.tou, 24, 288, -10, 1e6);
    if (p.grid.tou && p.grid.tou.length !== 24 && p.grid.tou.length !== 288) p.grid.tou = null;
    p.grid.pattern = numList(p.grid.pattern, 24, 24, 0, 1);
  }
  p.pv.mount_style = d.mountStyleOf(p.pv);   // follows the thermal loss factors the file holds
  // a daily load template that no longer exists: the stored 24 values become a custom shape
  if (!d.loadTemplates[p.load.template]) p.load.template = p.load._tpl = 'custom';
  // plant records: 12 monthly fuel values, null for a month without a record (blank or zero, as the editor stores it)
  const mf = p.site_records.monthly_fuel_l;
  p.site_records.monthly_fuel_l = d.months.map((_, i) => (Array.isArray(mf) && typeof mf[i] === 'number' && isFinite(mf[i]) && mf[i] > 0 ? mf[i] : null));
}
