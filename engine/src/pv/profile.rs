//! The hourly PV profile of the array (all its orientations under one inverter) with its loss chain and monthly balances, the
//! clear-sky profile of the forecaster, the tilt scan, the wind turbine output, the PV response document and the basis of
//! the independent yield check.
use super::optics::inverter_curve;
use super::pass::{array_pass, sun_instants, ArrayPass};
use super::sky::{air_mass, ineichen, linke_by_month, monthly_tamb, pressure_ratio};
use super::{local_month, local_shift, max, min, put_local, LossStep, PVProfile};
use crate::json::{Error, Value};
use crate::model::{Project, SiteLayout, HOURS};
use crate::shading::{array_groups, ArrayGroup, NEAR_BINS};
use crate::solar::sun_at;

/// The hourly PV profile of the project's array (array_groups)
pub fn compute_pv_profile(p: &Project) -> Result<PVProfile, Error> { compute_pv_profile_groups(p, &array_groups(p)?, false) }

/// The same on given orientations of the array; detail: also the shade on each table and the near horizon envelope
pub fn compute_pv_profile_groups(p: &Project, groups: &[ArrayGroup], detail: bool) -> Result<PVProfile, Error> {
    let pv = &p.pv;
    let w = &p.wx;
    let mut out = PVProfile { ac_per_kwp: vec![0.0; HOURS], poa: vec![0.0; HOURS], tcell: vec![0.0; HOURS], ghi_local: vec![0.0; HOURS], ..Default::default() };
    let sh = local_shift(p)?;

    // DC energy of each orientation weighted by its share of the modules (east-west tables half each way), so the inverter
    // sees the sum. Near shading of each orientation on the points of its tables.
    let horizon_beam = !pv.horizon.is_empty() && pv.horizon_beam != "data" && (pv.horizon_beam == "apply" || !w.horizon_in_beam);
    let any_near = groups.iter().any(|g| g.near.is_some());
    let sun = if horizon_beam || any_near { sun_instants(p) } else { Vec::new() };
    let n_tables = p.layout.tables.len();
    let mut all = ArrayPass::default();
    for g in groups {
        let near = g.near.as_deref();
        let mut q = pv.clone();
        q.tilt = g.tilt;
        // a canopy is one plane of tables: nothing stands in front of a table, and the ground under it is shaded
        if g.canopy { q.row_shading = false; q.diffuse_shading = false; q.bifaciality = 0.0; }
        let mut sun_wh: Vec<f64> = Vec::new();
        for face in 0..(if g.east_west { 2 } else { 1 }) {
            q.azimuth = if face == 1 { (g.azimuth + 180.0) % 360.0 } else { g.azimuth };
            let mut a = array_pass(p, &q, near, &sun, detail)?;
            if !a.sun_wh.is_empty() {
                if sun_wh.is_empty() { sun_wh = std::mem::take(&mut a.sun_wh); } else { for k in 0..sun_wh.len() { sun_wh[k] += a.sun_wh[k]; } }
            }
            if groups.len() == 1 && !g.east_west { all = a; continue; }
            let wgt = if g.east_west { g.share / 2.0 } else { g.share };
            if all.dc.is_empty() {
                all.poa = vec![0.0; HOURS];
                all.tcell = vec![0.0; HOURS];
                all.dc = vec![0.0; HOURS];
                all.m_dhi = a.m_dhi;
                all.steps = a.steps;
            }
            for i in 0..HOURS {
                all.poa[i] += wgt * a.poa[i];
                all.tcell[i] += wgt * a.tcell[i];
                all.dc[i] += wgt * a.dc[i];
            }
            all.s.add(&a.s, wgt);
            for m in 0..12 {
                all.m_poa[m] += wgt * a.m_poa[m];
                all.m_eff[m] += wgt * a.m_eff[m];
                all.m_dc[m] += wgt * a.m_dc[m];
            }
        }
        let Some(near) = near else { continue };
        if sun_wh.is_empty() || n_tables == 0 { continue; }
        // Beam hidden from each table: per azimuth, the beam with the sun below each whole degree of elevation; a point loses
        // the beam from the elevations below its near horizon.
        let mut below = vec![0.0; NEAR_BINS * 91];
        let mut total = 0.0;
        for j in 0..NEAR_BINS {
            for e in 0..90 { below[j * 91 + e + 1] = below[j * 91 + e] + sun_wh[j * 90 + e]; }
            total += below[j * 91 + 90];
        }
        if out.table_shade.is_empty() { out.table_shade = vec![0.0; n_tables]; }
        let pts = near.points();
        let (mut hidden, mut count) = (vec![0.0; n_tables], vec![0.0; n_tables]);
        for (k, pt) in pts.iter().enumerate() {
            if pt.table < 0 || pt.table as usize >= n_tables { continue; }
            let h = near.horizon(k);
            let mut lost = 0.0;
            for j in 0..NEAR_BINS { lost += below[j * 91 + (f64::from(h[j]) - 0.5).ceil().clamp(0.0, 90.0) as usize]; }
            hidden[pt.table as usize] += lost;
            count[pt.table as usize] += 1.0;
        }
        for &t in &g.tables {
            let t = t as usize;
            if t < n_tables && count[t] > 0.0 && total > 0.0 { out.table_shade[t] = hidden[t] / (count[t] * total); }
        }
    }
    if detail && any_near {
        // Near horizon over all points: highest and median at each azimuth, from each group's sorted elevations
        out.near_max = vec![0.0; NEAR_BINS];
        out.near_median = vec![0.0; NEAR_BINS];
        let sets = groups.iter().filter(|g| g.near.is_some()).count();
        let mut merged: Vec<f32> = Vec::new();
        for j in 0..NEAR_BINS {
            merged.clear();
            for g in groups { if let Some(n) = &g.near { merged.extend_from_slice(n.sorted(j)); } }
            if sets > 1 { merged.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)); }
            out.near_max[j] = f64::from(merged[merged.len() - 1]);
            out.near_median[j] = f64::from(merged[merged.len() / 2]);
        }
    }

    // Inverter and AC side
    let ac_max = 1.0 / pv.dc_ac_ratio;   // inverter AC limit per kWp DC
    let inv_curve = pv.inverter_model == "curve";
    let kinv = if inv_curve { inverter_curve(pv.inverter_eff, pv.inverter_eff_max) } else { [0.0, 0.0] };
    let (mut s_ghi, mut s_inv, mut s_clip, mut s_ac, mut s_avail) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for i in 0..HOURS {
        let ghi = max(0.0, w.ghi[i]);
        let mo = local_month(i, sh);
        put_local(&mut out.ghi_local, i, ghi, sh);
        s_ghi += ghi;
        out.m_ghi[mo] += ghi;
        put_local(&mut out.tcell, i, all.tcell[i], sh);
        if ghi <= 0.0 { continue; }
        let p_dc = all.dc[i];
        let p_inv = if inv_curve {   // AC output y of DC input x, both per unit of the AC rating: x = y + k0 + k2 y^2
            let x = p_dc / ac_max;
            if x > kinv[0] { ((1.0 + 4.0 * kinv[1] * (x - kinv[0])).sqrt() - 1.0) / (2.0 * kinv[1]) * ac_max } else { 0.0 }
        } else {
            p_dc * pv.inverter_eff
        };
        s_inv += p_inv;
        let p_clip = min(p_inv, ac_max);
        s_clip += p_clip;
        let p_ac = p_clip * (1.0 - pv.ac_losses);
        s_ac += p_ac;
        let p_out = p_ac * pv.availability;
        s_avail += p_out;
        out.m_avail[mo] += p_out;
        put_local(&mut out.ac_per_kwp, i, p_out, sh);
        put_local(&mut out.poa, i, all.poa[i], sh);
    }

    let c = all.s;
    let on = all.steps;
    let irr = |n: &str, wh: f64| LossStep { name: n.into(), value: wh / 1000.0, irradiance: true };
    let en = |n: &str, kwh: f64| LossStep { name: n.into(), value: kwh, irradiance: false };
    let l = &mut out.losses;
    l.extend([irr("Global horizontal irradiation", s_ghi), irr("Global incident in collector plane", c.poa)]);
    if on.horizon { l.push(irr("After terrain horizon", c.hor)); }
    if on.near { l.push(irr("After shading by nearby objects", c.near)); }
    l.extend([irr("After near/row shading", c.shade), irr("After IAM (reflection)", c.iam), irr("Effective irradiation (after soiling)", c.eff)]);
    if on.bifacial { l.push(irr("Effective incl. bifacial rear side", c.bif)); }
    if on.spec { l.push(irr("After spectral correction", c.spec)); }
    l.extend([en("Array nominal energy at STC", c.stc), en("After low-irradiance loss", c.low), en("After temperature loss", c.temp)]);
    if on.snow { l.push(en("After snow cover", c.snow)); }
    l.extend([en("After mismatch, wiring, LID, quality", c.dc), en("After inverter efficiency", s_inv), en("After inverter clipping", s_clip),
              en("After AC / transformer losses", s_ac), en("After availability (energy available)", s_avail)]);
    out.rear_annual = c.rear / 1000.0;
    out.specific_yield = s_avail;
    out.ghi_annual = s_ghi / 1000.0;
    out.poa_annual = c.poa / 1000.0;
    out.performance_ratio = if c.poa > 0.0 { s_avail / (c.poa / 1000.0) } else { 0.0 };
    out.m_tamb = monthly_tamb(p)?;
    for m in 0..12 {
        out.m_dhi[m] = all.m_dhi[m] / 1000.0;
        out.m_poa[m] = all.m_poa[m] / 1000.0;
        out.m_eff[m] = all.m_eff[m] / 1000.0;
        out.m_dc[m] = all.m_dc[m];
        out.m_ghi[m] /= 1000.0;
    }
    Ok(out)
}

/// PV output per kWp under clear sky (same system, same temperatures), the basis of the PV forecaster
pub fn clearsky_pv_per_kwp(p: &Project) -> Result<Vec<f64>, Error> {
    let mut q = p.clone();
    q.wx.snow.clear();   // a clear sky has no snowfall; the monthly snow loss stays
    if p.pv.clearsky != "ineichen" {
        q.wx.ghi = super::clearsky_ghi(p)?;
        q.wx.dni.clear();
        q.wx.dhi.clear();
        return Ok(compute_pv_profile(&q)?.ac_per_kwp);
    }
    // Ineichen gives its own beam and diffuse split
    let tl = linke_by_month(p)?;
    let sh = local_shift(p)?;
    let pr = pressure_ratio(p.loc.elevation);
    q.wx.ghi = vec![0.0; HOURS];
    q.wx.dni = vec![0.0; HOURS];
    q.wx.dhi = vec![0.0; HOURS];
    for i in 0..HOURS {
        let s = sun_at(p, i);
        let c = ineichen(s.cos_zenith, air_mass(s.zenith_deg) * pr, s.extra_normal, p.loc.elevation, tl[local_month(i, sh)]);
        (q.wx.ghi[i], q.wx.dni[i], q.wx.dhi[i]) = (c[0], c[1], c[2]);
    }
    Ok(compute_pv_profile(&q)?.ac_per_kwp)
}

/// Specific yield (kWh/kWp) of a fixed-tilt array over a range of tilts, all other parameters unchanged. The tables at the
/// project's tilt and azimuth take each tilt; areas with their own tilt keep it, and the near shading keeps the table heights
/// of the project's tilt.
pub fn tilt_scan(p: &Project, from: f64, to: f64, step: f64) -> Result<Vec<(f64, f64)>, Error> {
    let mut p = p.clone();
    p.pv.mount = "fixed".into();
    let groups0 = array_groups(&p)?;
    let mut r = Vec::new();
    let mut t = from;
    while t <= to + 1e-9 {
        p.pv.tilt = t;
        let mut groups = groups0.clone();
        for g in &mut groups { if !g.own_tilt { g.tilt = t; } }
        r.push((t, compute_pv_profile_groups(&p, &groups, false)?.specific_yield));
        t += step;
    }
    Ok(r)
}

/// Wind turbine AC output per turbine (kW), local time; zeros when the weather file has no wind speed. Power-law shear to hub
/// height, then the power curve (cubic or linear between cut-in and rated).
pub fn wind_per_turbine(p: &Project) -> Result<Vec<f64>, Error> {
    let w = &p.wind;
    let mut out = vec![0.0; HOURS];
    if p.wx.wind.len() != HOURS { return Ok(out); }
    let shear = (max(1.0, w.hub_height) / max(1.0, w.ref_height)).powf(w.shear_alpha);
    let sh = local_shift(p)?;
    for i in 0..HOURS {
        let v = max(0.0, p.wx.wind[i]) * shear;
        let mut pw = 0.0;
        if v >= w.v_in && v < w.v_out {
            pw = if v >= w.v_rated {
                w.rated_kw
            } else if w.curve == "linear" {
                w.rated_kw * (v - w.v_in) / (w.v_rated - w.v_in)
            } else {
                w.rated_kw * (v * v * v - w.v_in * w.v_in * w.v_in) / (w.v_rated * w.v_rated * w.v_rated - w.v_in * w.v_in * w.v_in)
            };
        }
        put_local(&mut out, i, pw * (1.0 - w.losses) * w.availability, sh);
    }
    Ok(out)
}

fn months(a: &[f64; 12]) -> Value { Value::from(a.to_vec()) }

/// The PV response document of the engine (pv_json of src/main.cpp)
pub fn pv_json(prof: &PVProfile) -> Value {
    let mut losses = Value::array();
    for l in &prof.losses {
        let mut o = Value::object();
        o.set("name", l.name.as_str());
        o.set("value", l.value);
        o.set("irradiance", l.irradiance);
        losses.push(o);
    }
    let mut monthly = Value::object();
    for (k, a) in [("ghi", &prof.m_ghi), ("dhi", &prof.m_dhi), ("tamb", &prof.m_tamb), ("poa", &prof.m_poa), ("eff", &prof.m_eff),
                   ("earray", &prof.m_dc), ("eavail", &prof.m_avail)] {
        monthly.set(k, months(a));
    }
    let mut o = Value::object();
    o.set("specific_yield", prof.specific_yield);
    o.set("performance_ratio", prof.performance_ratio);
    o.set("ghi_annual", prof.ghi_annual);
    o.set("poa_annual", prof.poa_annual);
    o.set("rear_annual", prof.rear_annual);
    o.set("losses", losses);
    o.set("monthly", monthly);
    o.set("ac_per_kwp", prof.ac_per_kwp.clone());
    o.set("ghi", prof.ghi_local.clone());
    o.set("poa", prof.poa.clone());
    o.set("tcell", prof.tcell.clone());
    let shade = if prof.near_max.is_empty() {
        Value::Null
    } else {
        let mut s = Value::object();
        s.set("tables", prof.table_shade.clone());
        s.set("near_max", prof.near_max.clone());
        s.set("near_median", prof.near_median.clone());
        s
    };
    o.set("shade", shade);
    o
}

/// The part of the independent yield check (pv_reference of src/main.cpp) that is pure computation: the comparable profile
/// (one orientation, no row shading, no clipping, monofacial, trackers without backtracking or rotation limit, constant
/// inverter efficiency) and the share of the energy that the losses the reference service does not model keep, applied to
/// its loss-free yield. Fetching that yield is left to the caller.
#[derive(Debug, Clone)]
pub struct PvReferenceBasis {
    pub profile: PVProfile,
    /// soiling x DC losses x inverter x AC x availability
    pub kept: f64,
    pub tracker: bool,
}

pub fn pv_reference_basis(p: &Project) -> Result<PvReferenceBasis, Error> {
    let tracker = p.pv.mount == "tracker";
    if tracker && libm_remainder(p.pv.tracker_axis_azimuth, 180.0).abs() > 1.0 {
        return Err(Error("PVGIS models single-axis trackers only on a north-south axis.".into()));
    }
    let mut q = p.clone();
    q.layout = SiteLayout::default();
    q.pv.row_shading = false;
    q.pv.backtracking = false;
    q.pv.tracker_max_angle = 90.0;
    q.pv.dc_ac_ratio = 0.1;
    q.pv.bifaciality = 0.0;
    q.pv.inverter_model = "constant".into();
    let c = compute_pv_profile(&q)?;
    let step = |name: &str| c.step(name).unwrap_or(0.0);
    let (t, iam) = (step("After temperature loss"), step("After IAM (reflection)"));
    let dc = if t > 0.0 { step("After mismatch, wiring, LID, quality") / t } else { 1.0 };
    // monthly soiling as weighted by the irradiance of each month
    let soil = if p.pv.soiling_monthly.len() == 12 && iam > 0.0 { step("Effective irradiation (after soiling)") / iam } else { 1.0 - p.pv.soiling };
    let kept = soil * dc * p.pv.inverter_eff * (1.0 - p.pv.ac_losses) * p.pv.availability;
    Ok(PvReferenceBasis { profile: c, kept, tracker })
}

/// std::remainder: x - n y with n the integer nearest x / y, halves to even
pub fn libm_remainder(x: f64, y: f64) -> f64 {
    let n = x / y;
    let mut r = n.round();
    if (n - n.trunc()).abs() == 0.5 && r % 2.0 != 0.0 { r -= n.signum(); }
    x - r * y
}
