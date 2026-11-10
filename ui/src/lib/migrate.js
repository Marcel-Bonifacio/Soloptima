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
  if (p.pv.thermal_model !== 'noct') p.pv.thermal_model = 'uc_uv';
  p.pv.soiling_monthly = numList(p.pv.soiling_monthly, 12, 12, 0, 0.999);
  p.pv.albedo_monthly = numList(p.pv.albedo_monthly, 12, 12, 0, 1);
  p.pv.snow_monthly = numList(p.pv.snow_monthly, 12, 12, 0, 1000);
  p.pv.snow_events = numList(p.pv.snow_events, 12, 12, 0, 31);
  p.pv.horizon = numList(p.pv.horizon, 4, 720, 0, 89.9);
  p.pv.mount_style = d.mountStyleOf(p.pv);   // follows the thermal loss factors the file holds
  // a daily load template that no longer exists: the stored 24 values become a custom shape
  if (!d.loadTemplates[p.load.template]) p.load.template = p.load._tpl = 'custom';
  // plant records: 12 monthly fuel values, null for a month without a record (blank or zero, as the editor stores it)
  const mf = p.site_records.monthly_fuel_l;
  p.site_records.monthly_fuel_l = d.months.map((_, i) => (Array.isArray(mf) && typeof mf[i] === 'number' && isFinite(mf[i]) && mf[i] > 0 ? mf[i] : null));
}
