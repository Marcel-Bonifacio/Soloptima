//! One orientation of the array over the weather year (array_pass of src/pv.cpp): decomposition, transposition, terrain
//! horizon and near shading, row shading (beam, bypass-diode blocks, diffuse), reflection, soiling, rear side, spectrum,
//! low irradiance, temperature, snow and the DC losses, hour by hour.
use super::optics::{diffuse_iam, horizon_at, horizon_view, incidence_modifier, sky_view};
use super::rows::{edge_ground, ground_view, orientation, row_view, EdgeGround, GroundView, RowView};
use super::sky::{air_mass, boland_diffuse_fraction, clearsky_hour, disc_dni, erbs_diffuse_fraction, linke_by_month, monthly_tamb,
                 perez_f, pressure_ratio, pvspec_coeffs, townsend_loss};
use super::{clamp, cosd, local_month, local_shift, max, min, sind, D2R};
use crate::json::Error;
use crate::model::{PVParams, Project, HOURS};
use crate::shading::{near_bin, NearShading, NEAR_BINS};
use crate::solar::{sin_cos, sun_at_utc, sun_position, sun_time};
use std::collections::HashMap;

/// Loss-chain sums of one orientation up to the DC energy: Wh/m2 for irradiance, kWh/kWp for energy
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ChainSums {
    pub poa: f64,
    pub hor: f64,
    pub near: f64,
    pub shade: f64,
    pub iam: f64,
    pub eff: f64,
    pub bif: f64,
    pub rear: f64,
    pub spec: f64,
    pub stc: f64,
    pub low: f64,
    pub temp: f64,
    pub snow: f64,
    pub dc: f64,
}

impl ChainSums {
    pub fn add(&mut self, o: &ChainSums, w: f64) {
        self.poa += w * o.poa; self.hor += w * o.hor; self.near += w * o.near; self.shade += w * o.shade; self.iam += w * o.iam;
        self.eff += w * o.eff; self.bif += w * o.bif; self.rear += w * o.rear; self.spec += w * o.spec; self.stc += w * o.stc;
        self.low += w * o.low; self.temp += w * o.temp; self.snow += w * o.snow; self.dc += w * o.dc;
    }
}

/// The optional steps of the loss chain a pass goes through
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ChainSteps {
    pub horizon: bool,
    pub near: bool,
    pub bifacial: bool,
    pub spec: bool,
    pub snow: bool,
}

/// By UTC hour: plane-of-array irradiance after shading (W/m2), cell temperature (the ambient in the dark) and DC energy per
/// kWp; monthly sums by local month; with near shading and detail, the beam on the plane after the terrain horizon by sun
/// position (NEAR_BINS azimuths x 90 one-degree elevations).
#[derive(Debug, Clone, Default)]
pub(crate) struct ArrayPass {
    pub poa: Vec<f64>,
    pub tcell: Vec<f64>,
    pub dc: Vec<f64>,
    pub sun_wh: Vec<f64>,
    pub s: ChainSums,
    pub steps: ChainSteps,
    pub m_dhi: [f64; 12],
    pub m_poa: [f64; 12],
    pub m_eff: [f64; 12],
    pub m_dc: [f64; 12],
}

/// Sun position [azimuth, zenith] (deg) at 10 instants in each daylight hour of the weather file, index 10 i + k
pub(crate) fn sun_instants(p: &Project) -> Vec<[f64; 2]> {
    let mut s = vec![[0.0, 90.0]; HOURS * 10];
    for i in 0..HOURS {
        if !(p.wx.ghi[i] > 0.0) { continue; }
        let t_utc = sun_time(p, i);
        for k in 0..10 {
            let tk = (t_utc - 0.5 + (f64::from(k) + 0.5) / 10.0 + HOURS as f64) % HOURS as f64;
            let sk = sun_position(p.loc.lat, p.loc.lon, (tk / 24.0) as i32 + 1, tk % 24.0);
            s[i * 10 + k as usize] = [sk.azimuth_deg, sk.zenith_deg];
        }
    }
    s
}

/// Sky views memoised by whole degree of tilt and azimuth
fn memo(m: &mut HashMap<i64, [f64; 2]>, tilt: f64, az: f64, view: impl Fn(f64, f64) -> [f64; 2]) -> [f64; 2] {
    let key = (tilt.round() as i64) * 1000 + ((az.round() as i64) % 360 + 360) % 360;
    *m.entry(key).or_insert_with(|| view(tilt.round(), az.round()))
}

pub(crate) fn array_pass(p: &Project, pv: &PVParams, near: Option<&NearShading>, sun: &[[f64; 2]], detail: bool) -> Result<ArrayPass, Error> {
    let w = &p.wx;
    let mut out = ArrayPass { poa: vec![0.0; HOURS], tcell: vec![0.0; HOURS], dc: vec![0.0; HOURS], ..Default::default() };

    let have_split = w.dni.len() == HOURS && w.dhi.len() == HOURS;
    let (disc, boland) = (pv.decomposition == "disc", pv.decomposition == "boland");
    let noct = pv.thermal_model == "noct";
    let k_low = pv.low_irr_loss_200 / -(0.2f64).ln();
    // DC wiring on the "stc" basis is the loss at STC power, scaled each hour by p_stc^2 / p_temp (I^2R over the string's
    // current and voltage); the "annual" basis takes a constant fraction
    let wiring_stc = pv.dc_wiring_basis == "stc";
    let dc_factor = (1.0 - pv.mismatch) * (if wiring_stc { 1.0 } else { 1.0 - pv.dc_wiring }) * (1.0 - pv.lid) * (1.0 - pv.module_quality);
    let iam_diffuse = clamp(1.0 - pv.iam_b0 * (1.0 / cosd(59.0) - 1.0), 0.0, 1.0);
    let sh = local_shift(p)?;
    let perez = pv.transposition == "perez";
    let monthly_soiling = pv.soiling_monthly.len() == 12;
    let monthly_albedo = pv.albedo_monthly.len() == 12;
    let pr = pressure_ratio(p.loc.elevation);
    // 2-D view factors on rows of width 1, so the mounting height counts relative to the table width
    let rows_ok = pv.gcr > 0.0 && pv.gcr < 1.0 && pv.row_width > 0.0;
    let vf_front = rows_ok && pv.row_shading && pv.diffuse_shading;
    let bifacial = rows_ok && pv.bifaciality > 0.0;
    let tracker = pv.mount == "tracker";
    let h_rel = if pv.row_width > 0.0 { pv.mount_height / pv.row_width } else { 0.0 };
    // Ground views: one for fixed tilt, one per whole degree of rotation for trackers (lazy)
    let mut gview: Vec<Option<GroundView>> = vec![None; if tracker { 91 } else { 1 }];
    // Edge rows: the shares of the tables with no row in front of them and with none behind them, and the ground the open
    // face of such a row sees (front of a front-edge row, back of a back-edge row), by tilt as gview
    let edge = if pv.edge_rows && rows_ok { pv.edge_share } else { [0.0, 0.0] };
    let (edge_front, edge_back) = (edge[0] > 0.0, edge[1] > 0.0 && bifacial);
    let mut eview: Vec<[Option<EdgeGround>; 2]> = vec![[None, None]; if tracker { 91 } else { 1 }];
    // Diffuse IAM: ASHRAE uses its 59 deg value; the others sky and ground averages per whole degree of tilt (0-180)
    let iam_ashrae = pv.iam_model != "martin_ruiz" && pv.iam_model != "physical";
    let mut diam = vec![[-1.0, -1.0]; 181];
    let mut iam_diff = |tilt: f64| -> [f64; 2] {
        let d = &mut diam[clamp(tilt.round(), 0.0, 180.0) as usize];
        if d[0] < 0.0 { *d = diffuse_iam(pv, tilt.round()); }
        *d
    };
    // Terrain horizon hides the sun unless the weather beam is blocked already; "data" (site-measured weather) leaves both to the weather
    let horizon = !pv.horizon.is_empty() && pv.horizon_beam != "data";
    let horizon_beam = horizon && (pv.horizon_beam == "apply" || !w.horizon_in_beam);
    let (mut hview, mut nview) = (HashMap::new(), HashMap::new());
    if near.is_some() && detail { out.sun_wh = vec![0.0; NEAR_BINS * 90]; }
    // Spectral correction on the clear-sky index of the chosen clear-sky model
    let spec = pvspec_coeffs(&pv.spectral);
    let ineichen_cs = pv.clearsky == "ineichen";
    let tl = if spec.is_some() && ineichen_cs { linke_by_month(p)? } else { [0.0; 12] };
    // Bypass-diode blocks up the table for the electrical effect of row shading (Martinez-Moreno et al. 2010)
    let blocks = pv.shade_model == "blocks";
    let n_blocks = if pv.bypass_blocks > 0 { f64::from(pv.bypass_blocks) } else { f64::from(pv.modules_up.max(1)) * if pv.portrait { 2.0 } else { 3.0 } };
    // Snow: hourly cover when the weather has snowfall (Marion et al. 2013: a fall over 1 cm/h covers the modules, which then
    // shed 19.7 % of their slant height times sin(tilt) per hour while the air is warmer than -POA / 80 W/m2 per deg C; a
    // string stops when any of its modules is covered, strings running along the rows); otherwise the monthly model.
    let snow_hourly = w.snow.len() == HOURS;
    let snow_monthly = !snow_hourly && pv.snow_monthly.len() == 12 && pv.snow_events.len() == 12;
    let mut snow_loss = [0.0; 12];
    if snow_monthly {
        let mut q = pv.clone();
        q.snow_monthly.clear();
        let base = array_pass(p, &q, None, sun, false)?;   // the plane-of-array sums come before any shading
        let mut poa_kwh = [0.0; 12];
        for m in 0..12 { poa_kwh[m] = base.m_poa[m] / 1000.0; }
        snow_loss = townsend_loss(pv, &poa_kwh, &monthly_tamb(p)?);
    }
    let strings_up = f64::from(pv.modules_up.max(1));
    let shed = 0.197 * sind(if tracker { pv.tracker_max_angle } else { pv.tilt });
    let mut cover = 0.0;
    let snow_step = |cover: &mut f64, i: usize, ta: f64, poa: f64| {
        if w.snow[i] > 1.0 { *cover = 1.0; } else if ta > -poa / 80.0 { *cover = max(0.0, *cover - shed); }
    };
    let tamb_at = |i: usize| if w.tamb.len() == HOURS { w.tamb[i] } else { 25.0 };
    if snow_hourly {   // the cover on 1 January from the last 31 days of the year, GHI in place of the plane-of-array irradiance
        for i in HOURS - 31 * 24..HOURS { snow_step(&mut cover, i, tamb_at(i), max(0.0, w.ghi[i])); }
    }
    let mut sum = ChainSums::default();

    for i in 0..HOURS {
        let ghi = max(0.0, w.ghi[i]);
        let ta = tamb_at(i);
        let ws = if w.wind.len() == HOURS { max(0.0, w.wind[i]) } else { 1.0 };
        let mo = local_month(i, sh);
        if ghi <= 0.0 {
            if snow_hourly { snow_step(&mut cover, i, ta, 0.0); }
            out.tcell[i] = ta;
            continue;
        }
        let s = sun_at_utc(p, sun_time(p, i));

        // Split GHI into beam and diffuse, keeping the three components consistent
        let cz = s.cos_zenith;
        let (mut dni, mut dhi) = (0.0, ghi);
        if cz > 0.0872 {
            if have_split {
                dhi = clamp(w.dhi[i], 0.0, ghi);
                dni = (ghi - dhi) / cz;
            } else {
                let kt = min(1.0, ghi / (s.extra_normal * cz));
                if disc {
                    dni = min(disc_dni(kt, s.zenith_deg, pr, s.extra_normal), ghi / cz);
                } else {
                    dhi = ghi * if boland { boland_diffuse_fraction(kt) } else { erbs_diffuse_fraction(kt) };
                    dni = (ghi - dhi) / cz;
                }
            }
            dni = min(dni, s.extra_normal);
            dhi = ghi - dni * cz;
        }
        out.m_dhi[mo] += dhi;
        let alb = if monthly_albedo { pv.albedo_monthly[mo] } else { pv.albedo };

        let o = orientation(pv, &s);
        // sines and cosines of one angle come from one call, as the compiled C++ takes them (solar::sin_cos)
        let ((st, ct), (sa, ca), (ssa, csa)) = (sin_cos(o.tilt * D2R), sin_cos(o.azimuth * D2R), sin_cos(s.azimuth_deg * D2R));
        let sz = (s.zenith_deg * D2R).sin();
        let cos_aoi_raw = st * sa * sz * ssa + st * ca * sz * csa + ct * cz;
        let cos_aoi = max(0.0, cos_aoi_raw);

        // Transposition. Sky diffuse = isotropic + circumsolar (share F1, from the sun's direction) + horizon band (F2).
        // Hay-Davies: F1 = DNI / E0 (anisotropy index), no horizon band. Perez 1990: F1 and F2 from clearness and brightness.
        let (mut f1, mut f2) = (clamp(dni / s.extra_normal, 0.0, 1.0), 0.0);
        if perez { (f1, f2) = if dhi > 0.0 { perez_f(dhi, dni, s.zenith_deg, s.extra_normal) } else { (0.0, 0.0) }; }
        let rb = cos_aoi / max(cz, 0.0872);
        let mut beam = dni * cos_aoi;
        let mut sky = if perez {
            max(0.0, dhi * ((1.0 - f1) * (1.0 + ct) / 2.0 + f1 * rb + f2 * st))
        } else {
            dhi * ((1.0 - f1) * (1.0 + ct) / 2.0 + f1 * rb)
        };
        let ground = ghi * alb * (1.0 - ct) / 2.0;
        let poa = beam + sky + ground;
        sum.poa += poa;
        out.m_poa[mo] += poa;

        // Terrain horizon: the share of the hour's 10 instants with the sun above it passes beam and circumsolar light; the
        // isotropic sky and horizon band take the sky share the terrain leaves in view. Layout objects then shade the tables
        // behind them, and their sky view replaces the terrain's. If the terrain already blocks the weather beam, objects
        // act only on the instants with the sun above the terrain.
        let (mut vis, mut vis_near) = (1.0, 1.0);
        let mut circ = dhi * f1 * rb;   // circumsolar light on the plane
        if horizon_beam || near.is_some() {
            let (mut up, mut seen, mut n_sun) = (0i32, 0i32, 0usize);
            let mut lit = 0.0;
            let mut sun_bin = [0usize; 10];
            for k in 0..10 {
                let sk = sun[i * 10 + k];
                if sk[1] >= 90.0 { continue; }
                up += 1;
                let el = 90.0 - sk[1];
                if horizon && !(el > horizon_at(&pv.horizon, sk[0])) { continue; }
                seen += 1;
                if let Some(n) = near {
                    lit += 1.0 - n.shaded(sk[0], el);
                    if detail {
                        sun_bin[n_sun] = near_bin(sk[0]) * 90 + (el as i32).min(89) as usize;
                        n_sun += 1;
                    }
                }
            }
            if horizon_beam { vis = if up != 0 { f64::from(seen) / f64::from(up) } else { 1.0 }; }
            if near.is_some() {
                let per = if horizon_beam { up } else { seen };
                vis_near = if per != 0 { lit / f64::from(per) } else { 1.0 };
                for &b in &sun_bin[..n_sun] { out.sun_wh[b] += beam / f64::from(per); }
            }
        }
        // Beam, sky and circumsolar light past a horizon whose sky view is hv and beam visibility v
        let band = if perez { dhi * f2 * st } else { 0.0 };
        let past = |hv: [f64; 2], v: f64, beam: f64, sky: f64, circ: f64| {
            [beam * v, max(0.0, (sky - circ - band) * hv[0] + circ * v + band * hv[1]), circ * v]
        };
        if horizon {
            let hv = memo(&mut hview, o.tilt, o.azimuth, |t, a| horizon_view(&pv.horizon, t, a));
            let t = past(hv, vis, beam, sky, circ);
            sum.hor += t[0] + t[1] + ground;
            if near.is_none() { (beam, sky, circ) = (t[0], t[1], t[2]); }
        }
        if let Some(n) = near {
            let nv = memo(&mut nview, o.tilt, o.azimuth, |t, a| sky_view(n.sky(), t, a));
            let t = past(nv, vis_near, beam, sky, circ);
            (beam, sky, circ) = (t[0], t[1], t[2]);
        }
        sum.near += beam + sky + ground;

        // Light reflected by the ground between the rows towards the front and the back of a row (before albedo): beam
        // outside the rows' shadows and sky diffuse by each strip's view of the sky between the rows; beyond 85 deg of
        // projected zenith the ground counts as shaded.
        let (mut g_refl, mut e_refl) = ([0.0, 0.0], [0.0, 0.0]);
        let mut rv = RowView::default();
        if vf_front || bifacial {
            rv = row_view(o.rot, pv.gcr);
            let tan_phi = cosd(s.azimuth_deg - o.azimuth) * (min(s.zenith_deg, 89.0) * D2R).tan();
            let at = if tracker { clamp(o.rot.round(), 0.0, 90.0) as usize } else { 0 };
            let t = if tracker { o.rot.round() } else { o.rot };
            let g = gview[at].get_or_insert_with(|| ground_view(t, pv.gcr, h_rel));
            let beam_h = if tan_phi.abs() < (85.0 * D2R).tan() { dni * vis * cz } else { 0.0 };
            g_refl = g.reflected(tan_phi, beam_h, dhi);
            for (side, on) in [(0, edge_front && vf_front), (1, edge_back)] {
                if !on { continue; }
                let e = eview[at][side].get_or_insert_with(|| edge_ground(t, pv.gcr, h_rel, side == 0));
                e_refl[side] = e.reflected(tan_phi, beam_h, dhi);
            }
        }

        // Beam on the unshaded part; with bypass-diode blocks, every block the shadow touches also loses the beam on its
        // unshaded cells: (1 - F) (1 - N_shaded / (N_blocks + 1)) (Martinez-Moreno et al. 2010)
        let f_sh = o.shade_frac;
        let sf = if blocks && f_sh > 0.0 { (1.0 - f_sh) * (1.0 - (f_sh * n_blocks - 1e-9).ceil() / (n_blocks + 1.0)) } else { 1.0 - f_sh };
        let mut beam_sh = beam * sf;
        let (mut sky_sh, mut ground_sh, mut circ_sh) = (sky, ground, circ);
        if vf_front {
            // Rows in front also block more than the beam: the circumsolar part with the beam, the isotropic and
            // horizon parts by the front's view of the sky, and the ground-reflected light from the partly shaded ground
            sky_sh = min(sky, circ * sf + max(0.0, sky - circ) * rv.front_sky / ((1.0 + cosd(o.rot)) / 2.0));
            ground_sh = alb * g_refl[0];
            circ_sh = min(circ * sf, sky_sh);
        }
        if edge_front {
            // Tables with no row in front: the whole beam and sky of the plane, and the open ground in front of them
            let w = edge[0];
            beam_sh = (1.0 - w) * beam_sh + w * beam;
            if vf_front {
                sky_sh = (1.0 - w) * sky_sh + w * sky;
                ground_sh = (1.0 - w) * ground_sh + w * alb * e_refl[0];
                circ_sh = (1.0 - w) * circ_sh + w * circ;
            }
        }
        let poa_sh = beam_sh + sky_sh + ground_sh;
        sum.shade += poa_sh;
        if snow_hourly { snow_step(&mut cover, i, ta, poa_sh); }

        // Reflection: with the ASHRAE model all diffuse light at its 59 deg value; with the others the circumsolar light as
        // beam and the rest of the sky and the ground at their averages for the plane
        let iam_b = incidence_modifier(pv, cos_aoi);
        let poa_iam = if iam_ashrae {
            beam_sh * iam_b + (sky_sh + ground_sh) * iam_diffuse
        } else {
            let d = iam_diff(o.tilt);
            (beam_sh + circ_sh) * iam_b + (sky_sh - circ_sh) * d[0] + ground_sh * d[1]
        };
        sum.iam += poa_iam;
        let mut geff = poa_iam * (1.0 - if monthly_soiling { pv.soiling_monthly[mo] } else { pv.soiling });
        sum.eff += geff;
        out.m_eff[mo] += geff;

        let mut g_temp = poa_sh;   // irradiance that heats the cells
        if bifacial {
            // Back of the row: light reflected by the ground between the rows, the sky above the row behind (isotropic and
            // horizon parts) and, with the sun behind the modules, beam and circumsolar light outside the shadow of the row
            // behind. No soiling; the rear-side loss covers structure shading and the mismatch of uneven rear irradiance.
            let (sr, cr) = sin_cos(o.rot * D2R);
            let back_open = (1.0 - cr) / 2.0;
            let mut rear_ground = alb * g_refl[1];
            let mut rear_sky = 0.0;
            let open_sky = if back_open > 1e-9 { max(0.0, dhi * ((1.0 - f1) * back_open + f2 * sr)) } else { 0.0 };
            if back_open > 1e-9 { rear_sky = open_sky * rv.back_sky / back_open; }
            let hz = if horizon { memo(&mut hview, 180.0 - o.tilt, o.azimuth + 180.0, |t, a| horizon_view(&pv.horizon, t, a))[0] } else { 1.0 };
            if horizon { rear_sky *= hz; }
            let (mut rear_beam, mut open_beam) = (0.0, 0.0);
            let cos_back = -cos_aoi_raw;
            if cos_back > 0.0 && cz > 0.0872 {
                let tan_phi_b = -cosd(s.azimuth_deg - o.azimuth) * (s.zenith_deg * D2R).tan();
                let x = pv.gcr * (sr * tan_phi_b - cr);
                let shade_b = if x > 1.0 { 1.0 - 1.0 / x } else { 0.0 };
                open_beam = (dni + dhi * f1 / cz) * vis * cos_back;
                rear_beam = open_beam * (1.0 - shade_b);
            }
            if edge_back {
                // Tables with no row behind them: the open sky and ground behind, and the beam without a row's shadow
                let w = edge[1];
                rear_ground = (1.0 - w) * rear_ground + w * alb * e_refl[1];
                rear_sky = (1.0 - w) * rear_sky + w * open_sky * hz;
                rear_beam = (1.0 - w) * rear_beam + w * open_beam;
            }
            let rear_diffuse = rear_ground + rear_sky;
            let rear = rear_diffuse + rear_beam;
            let rear_iam = if iam_ashrae {
                rear_diffuse * iam_diffuse + rear_beam * incidence_modifier(pv, cos_back)
            } else {
                let d = iam_diff(180.0 - o.tilt);
                rear_ground * d[1] + rear_sky * d[0] + rear_beam * incidence_modifier(pv, cos_back)
            };
            let rear_eff = pv.bifaciality * (1.0 - pv.rear_loss) * rear_iam;
            g_temp += pv.bifaciality * rear;
            geff += rear_eff;
            sum.rear += rear;
        }
        sum.bif += geff;
        if let Some(c) = spec {
            // PVSPEC on the hour's clear-sky index (within 0.1-1.2) and absolute air mass (within 1-10)
            let am = air_mass(s.zenith_deg) * pr;
            let cs = clearsky_hour(ineichen_cs, cz, am, s.extra_normal, p.loc.elevation, tl[mo]);
            let kc = if cs > 1.0 { clamp(ghi / cs, 0.1, 1.2) } else { 1.0 };
            let ama = clamp(am, 1.0, 10.0);
            geff *= c[0] * kc.powf(c[1]) * ama.powf(c[2]);
        }
        sum.spec += geff;

        let p_stc = geff / 1000.0;   // kW per kWp at STC efficiency
        sum.stc += p_stc;
        let f_low = if geff > 10.0 { clamp(1.0 + k_low * (geff / 1000.0).ln(), 0.0, 1.03) } else { 0.0 };
        let p_low = p_stc * f_low;
        sum.low += p_low;
        let tc = if noct { ta + (pv.noct - 20.0) / 800.0 * g_temp } else { ta + g_temp * pv.absorptance * (1.0 - pv.module_eff) / (pv.uc + pv.uv * ws) };
        let p_temp = max(0.0, p_low * (1.0 + pv.gamma_pmax * (tc - 25.0)));
        sum.temp += p_temp;
        let mut p_snow = p_temp;
        if snow_hourly { p_snow *= 1.0 - (cover * strings_up - 1e-9).ceil() / strings_up; }
        else if snow_monthly { p_snow *= 1.0 - snow_loss[mo]; }
        sum.snow += p_snow;
        let mut p_dc = p_snow * dc_factor;
        if wiring_stc && p_temp > 0.0 { p_dc *= 1.0 - pv.dc_wiring * p_stc * p_stc / p_temp; }   // I^2R: loss ~ I/V
        sum.dc += p_dc;
        out.m_dc[mo] += p_dc;
        out.dc[i] = p_dc;
        out.poa[i] = poa_sh;
        out.tcell[i] = tc;
    }
    out.s = sum;
    out.steps = ChainSteps { horizon, near: near.is_some(), bifacial, spec: spec.is_some(), snow: snow_hourly || snow_monthly };
    Ok(out)
}
