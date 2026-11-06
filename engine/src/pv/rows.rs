//! Rows: the plane of fixed rows and trackers (incl. slope-aware backtracking) with the beam shading from the row in front, and
//! the 2-D view factors of a row and of the ground between the rows (diffuse row shading, rear side of bifacial modules).
use super::{clamp, cosd, max, min, sind, D2R, R2D};
use crate::model::PVParams;
use crate::solar::{cos_apart, sin_apart, sin_cos, SunPos};
use std::f64::consts::PI;

/// The plane of the modules in one hour; rot: rotation of the row's cross-section (tilt of fixed rows)
#[derive(Debug, Clone, Copy)]
pub(crate) struct Orientation {
    pub tilt: f64,
    pub azimuth: f64,
    pub shade_frac: f64,
    pub rot: f64,
}

pub(crate) fn orientation(pv: &PVParams, s: &SunPos) -> Orientation {
    // sines and cosines of one angle come from one call, as the compiled C++ takes them (solar::sin_cos)
    let sz = (s.zenith_deg * D2R).sin();
    let (s_az, c_az) = sin_cos(s.azimuth_deg * D2R);
    let (sun_e, sun_n, sun_u) = (sz * s_az, sz * c_az, s.cos_zenith);
    if pv.mount == "tracker" && (pv.tracker_axis_tilt != 0.0 || pv.tracker_cross_slope != 0.0) {
        // Tilted axis or rows on a slope across the axis: the sun projected on the plane across the axis, backtracking on the
        // slope (Anderson and Mikofski 2020), the module plane from the rotation (Marion and Dobos 2013). Rotation > 0 turns
        // the modules towards axis azimuth + 90.
        let (a, bt, bc) = (pv.tracker_axis_azimuth, pv.tracker_axis_tilt, pv.tracker_cross_slope);
        let ((sa, ca), (sbt, cbt)) = (sin_cos(a * D2R), sin_cos(bt * D2R));
        let (mut theta, mut shade) = (0.0, 0.0);
        if sun_u > 0.0 {
            let ideal = (sun_e * ca - sun_n * sa).atan2(sun_e * sa * sbt + sun_n * sbt * ca + sun_u * cbt) * R2D;
            let gap = if pv.gcr > 0.0 { cosd(ideal - bc).abs() / (pv.gcr * cosd(bc)) } else { 2.0 };   // projected spacing / width
            theta = ideal;
            if pv.backtracking && gap < 1.0 { theta = ideal - (if ideal >= 0.0 { 1.0 } else { -1.0 }) * gap.acos() * R2D; }
            theta = clamp(theta, -pv.tracker_max_angle, pv.tracker_max_angle);
            if !pv.backtracking && pv.row_shading { shade = clamp(1.0 - gap / cosd(ideal - theta), 0.0, 1.0); }
        }
        let (st, ct) = (sin_apart(theta * D2R), cos_apart(theta * D2R));   // the C++ takes these two apart
        let ne = -sbt * sa * ct + ca * st;
        let nn = -sbt * ca * ct - sa * st;
        let tilt = clamp(cbt * ct, -1.0, 1.0).acos() * R2D;
        let az = if tilt < 1e-9 { a + 90.0 } else { ne.atan2(nn) * R2D };
        return Orientation { tilt, azimuth: (az + 720.0) % 360.0, shade_frac: shade, rot: theta.abs() };
    }
    if pv.mount == "tracker" {
        if sun_u <= 0.0 { return Orientation { tilt: 0.0, azimuth: pv.tracker_axis_azimuth + 90.0, shade_frac: 0.0, rot: 0.0 }; }
        let a = pv.tracker_axis_azimuth;
        let (sa, ca) = sin_cos(a * D2R);
        let (pe, pn) = (ca, -sa);   // horizontal direction perpendicular to the axis
        let mut theta = (sun_e * pe + sun_n * pn).atan2(sun_u) * R2D;
        let mut shade = 0.0;
        if pv.backtracking && pv.gcr > 0.0 {
            let temp = min(1.0, cosd(theta) / pv.gcr);
            theta -= (if theta >= 0.0 { 1.0 } else { -1.0 }) * temp.acos() * R2D;
        } else if pv.row_shading && pv.gcr > 0.0 {
            let rot = min(theta.abs(), pv.tracker_max_angle);
            shade = clamp(1.0 - cosd(theta.abs()) / (pv.gcr * cosd(theta.abs() - rot)), 0.0, 1.0);
        }
        theta = clamp(theta, -pv.tracker_max_angle, pv.tracker_max_angle);
        let az = if theta >= 0.0 { a + 90.0 } else { a - 90.0 };
        return Orientation { tilt: theta.abs(), azimuth: (az + 360.0) % 360.0, shade_frac: shade, rot: theta.abs() };
    }
    // Fixed rows: beam shading from the row in front (infinite-row 2-D model)
    let mut shade = 0.0;
    if pv.row_shading && pv.gcr > 0.0 && pv.tilt > 0.0 && sun_u > 0.0 {
        let elev = 90.0 - s.zenith_deg;
        let c = cosd(s.azimuth_deg - pv.azimuth);
        if c > 1e-6 {
            let ap = ((elev * D2R).tan() / c).atan() * R2D;   // profile angle
            let denom = sind(ap + pv.tilt);
            if denom > 1e-6 { shade = clamp(1.0 - (1.0 / pv.gcr) * sind(ap) / denom, 0.0, 1.0); }
        }
    }
    Orientation { tilt: pv.tilt, azimuth: pv.azimuth, shade_frac: shade, rot: pv.tilt }
}

/// View factors of one row in an infinite array of identical rows, 2-D, averaged over the row's slant height (Marion et al.
/// 2017). Rows of width 1 at pitch 1/gcr; without neighbouring rows they reduce to (1 + cos tilt) / 2 and (1 - cos tilt) / 2.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RowView {
    pub front_sky: f64,
    pub front_ground: f64,
    pub back_sky: f64,
    pub back_ground: f64,
}

pub fn row_view(tilt: f64, gcr: f64) -> RowView {
    let (p, c) = (1.0 / gcr, cosd(tilt));
    let near = (p * p - 2.0 * p * c + 1.0).sqrt();
    let far = (p * p + 2.0 * p * c + 1.0).sqrt();
    RowView { front_sky: 0.5 * (1.0 + p - near), front_ground: 0.5 * (1.0 + p - far), back_sky: 0.5 * (1.0 + p - far), back_ground: 0.5 * (1.0 + p - near) }
}

/// The ground between the rows in STRIPS strips per pitch, 2-D: rows of width 1 at pitch 1/gcr with their centre at height h
/// (row 0 centred at x = 0, front facing +x, top edge towards -x). sky: view factor from each strip to the sky through the
/// gaps between the rows; front, back: view factors from the front and the back of a row, averaged over its slant, to that
/// strip in every pitch (they sum to front_ground and back_ground of row_view).
#[derive(Debug, Clone, PartialEq)]
pub struct GroundView {
    pub tilt: f64,
    pub gcr: f64,
    pub h: f64,
    pub sky: Vec<f64>,
    pub front: Vec<f64>,
    pub back: Vec<f64>,
}

impl GroundView {
    pub const STRIPS: usize = 30;

    /// Irradiance reflected by the ground towards the front and the back, before albedo: beam_h on the part of each strip
    /// outside the rows' shadows plus dhi times the strip's sky view. tan_phi: tangent of the sun's zenith projected on the
    /// plane across the rows, positive with the sun in front of the modules.
    pub fn reflected(&self, tan_phi: f64, beam_h: f64, dhi: f64) -> [f64; 2] {
        // Beam shadow of row 0 on the ground, one interval per pitch of width |cos tilt + sin tilt tan phi|, at most the pitch
        let p = 1.0 / self.gcr;
        let (st, ct) = sin_cos(self.tilt * D2R);
        let (dx, dz) = (0.5 * ct, 0.5 * st);
        let e1 = -dx - (self.h + dz) * tan_phi;
        let e2 = dx - (self.h - dz) * tan_phi;
        let len = min(p, (e2 - e1).abs());
        let mut s0 = min(e1, e2);
        s0 -= (s0 / p).floor() * p;
        let sw = p / Self::STRIPS as f64;
        let mut r = [0.0, 0.0];
        for s in 0..Self::STRIPS {
            let a = s as f64 * sw;
            let b = a + sw;
            let ov = |lo: f64, hi: f64| max(0.0, min(b, hi) - max(a, lo));
            let lit = 1.0 - min(1.0, (ov(s0, s0 + len) + ov(s0 - p, s0 + len - p)) / sw);
            let gs = lit * beam_h + self.sky[s] * dhi;
            r[0] += self.front[s] * gs;
            r[1] += self.back[s] * gs;
        }
        r
    }
}

pub fn ground_view(tilt: f64, gcr: f64, h: f64) -> GroundView {
    let p = 1.0 / gcr;
    let (st, ct) = sin_cos(tilt * D2R);
    let (dx, dz, b) = (0.5 * ct, 0.5 * st, tilt * D2R);
    let h = max(h, dz + 0.02);   // lower edge above the ground
    const M: usize = GroundView::STRIPS;
    let mut g = GroundView { tilt, gcr, h, sky: vec![0.0; M], front: vec![0.0; M], back: vec![0.0; M] };
    // Sky seen from the ground: the gaps between neighbouring rows, from 10 points per strip. Rows beyond K hide only sky
    // within 5 deg of the horizon.
    let kk = (h * gcr / (5.0 * D2R).tan()).ceil() as i32 + 2;
    const NG: i32 = 10;
    for s in 0..M {
        for j in 0..NG {
            let x = (s as f64 + (f64::from(j) + 0.5) / f64::from(NG)) * p / M as f64;
            let mut lo_prev = 0.0;   // smaller edge angle of the row to the left
            for k in -kk..=kk {
                let kp = f64::from(k) * p;
                let a1 = (h + dz).atan2(kp - dx - x);
                let a2 = (h - dz).atan2(kp + dx - x);
                if k > -kk { g.sky[s] += max(0.0, max(a1, a2).cos() - f64::cos(lo_prev)) / 2.0 / f64::from(NG); }
                lo_prev = min(a1, a2);
            }
        }
    }
    // Ground seen from the row (front facing +x), averaged over 12 points of the slant. A strip at angle a below the horizon
    // counts sin(a - a_normal) / 2 between its edges. Strips more than KG pitches away take the remainder of the closed-form
    // total, spread evenly.
    const NS: i32 = 12;
    const KG: i32 = 20;
    let rv = row_view(tilt, gcr);
    for i in 0..NS {
        let u = (f64::from(i) + 0.5) / f64::from(NS);   // 0 lower edge, 1 top edge
        let (px, pz) = (dx - u * ct, h - dz + u * st);
        let dep_behind = (u * st).atan2(px + p - dx);
        let dep_front = (u * st).atan2(p + dx - px);
        let (back_lo, back_hi, front_lo, front_hi) = (-PI + dep_behind, -b, -b, -dep_front);
        let add = |w: &mut Vec<f64>, lo: f64, hi: f64, normal: f64| {
            let mut prev = 0.0;
            for k in -KG..=KG {
                for s in 0..=M {
                    let a = clamp((-pz).atan2(f64::from(k) * p + s as f64 * p / M as f64 - px), lo, hi);
                    if s > 0 { w[s - 1] += ((a - normal).sin() - f64::sin(prev - normal)) / 2.0 / f64::from(NS); }
                    prev = a;
                }
            }
        };
        add(&mut g.back, back_lo, back_hi, -PI / 2.0 - b);
        add(&mut g.front, front_lo, front_hi, PI / 2.0 - b);
    }
    let (fb, ff) = (g.back.iter().fold(0.0, |a, x| a + x), g.front.iter().fold(0.0, |a, x| a + x));
    for s in 0..M {
        g.back[s] += (rv.back_ground - fb) / M as f64;
        g.front[s] += (rv.front_ground - ff) / M as f64;
    }
    g
}
