//! Rows: fixed rows and trackers (slope-aware backtracking), beam shading from the row in front, and 2-D view factors of a row
//! and of the ground between the rows.
use super::{clamp, cosd, max, min, sind, D2R, R2D};
use crate::model::PVParams;
use crate::solar::{cos_apart, sin_apart, sin_cos, SunPos};
use std::f64::consts::PI;

/// rot: rotation of the row's cross-section (tilt of fixed rows)
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
        // Tilted axis or sloped rows: sun projected across the axis, backtracking on the slope (Anderson and Mikofski 2020), module plane
        // from the rotation (Marion and Dobos 2013). Rotation > 0 turns the modules towards axis azimuth + 90.
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

/// View factors of one row in an infinite array of identical rows, 2-D, averaged over the slant (Marion et al. 2017). Rows of width 1
/// at pitch 1/gcr; without neighbours they reduce to (1 +- cos tilt) / 2.
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

/// Ground between the rows in STRIPS strips per pitch, 2-D: rows of width 1 at pitch 1/gcr, centre at height h (row 0 at x = 0, front
/// facing +x). sky: strip view factor to the sky; front, back: row front/back to the strip, slant-averaged (sum to front_ground, back_ground).
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

    /// Ground-reflected irradiance towards the front and back, before albedo: beam_h on the unshaded part of each strip plus dhi times its
    /// sky view. tan_phi: tangent of the sun's zenith projected across the rows, positive with the sun in front.
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

/// Ground seen by a row at the edge of the array, 2-D: rows of width 1 at pitch 1/gcr, centre at height h, on one side of row 0
/// only. Front edge (front = true): the rows stand behind row 0 and the ground in front of it is open; back edge: the rows
/// stand in front of row 0 and the ground behind it is open. Strips of width pitch / PER_PITCH from `span` pitches behind to
/// `span` pitches in front of row 0, with their sky view and the view of the open face of row 0 (its front for the front
/// edge, its back for the back edge); `far` is that face's view of the ground beyond the strips on the open side.
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeGround {
    pub tilt: f64,
    pub gcr: f64,
    pub h: f64,
    pub front: bool,
    pub span: i32,
    pub sky: Vec<f64>,
    pub view: Vec<f64>,
    pub far: f64,
    pub far_sky: f64,
}

impl EdgeGround {
    pub const PER_PITCH: usize = 10;

    /// Ground-reflected irradiance towards the open face, before albedo, as GroundView::reflected: beam_h on the part of each
    /// strip outside the shadows of the rows that stand, plus dhi times its sky view
    pub fn reflected(&self, tan_phi: f64, beam_h: f64, dhi: f64) -> f64 {
        let p = 1.0 / self.gcr;
        let (st, ct) = sin_cos(self.tilt * D2R);
        let (dx, dz) = (0.5 * ct, 0.5 * st);
        let e1 = -dx - (self.h + dz) * tan_phi;
        let e2 = dx - (self.h - dz) * tan_phi;
        let (lo, hi) = (min(e1, e2), max(e1, e2));
        let (k0, k1) = self.rows();
        let sw = p / Self::PER_PITCH as f64;
        let x0 = -f64::from(self.span) * p;
        let mut r = 0.0;
        for s in 0..self.view.len() {
            if self.view[s] == 0.0 { continue; }
            let a = x0 + s as f64 * sw;
            let b = a + sw;
            let ov = |l: f64, h: f64| max(0.0, min(b, h) - max(a, l));
            let shaded = if hi - lo >= p {
                ov(lo + f64::from(k0) * p, hi + f64::from(k1) * p)   // the shadows of neighbouring rows join
            } else {
                let ka = ((a - hi) / p).ceil().max(f64::from(k0)) as i32;
                let kb = ((b - lo) / p).floor().min(f64::from(k1)) as i32;
                (ka..=kb).fold(0.0, |t, k| t + ov(lo + f64::from(k) * p, hi + f64::from(k) * p))
            };
            let lit = 1.0 - min(1.0, shaded / sw);
            r += self.view[s] * (lit * beam_h + self.sky[s] * dhi);
        }
        r + self.far * (beam_h + self.far_sky * dhi)
    }

    /// The rows that stand: k0..=k1 pitches from row 0
    fn rows(&self) -> (i32, i32) {
        let n = self.span + (self.h * self.gcr / (5.0 * D2R).tan()).ceil() as i32 + 2;
        if self.front { (-n, 0) } else { (0, n) }
    }
}

pub fn edge_ground(tilt: f64, gcr: f64, h: f64, front: bool) -> EdgeGround {
    let p = 1.0 / gcr;
    let (st, ct) = sin_cos(tilt * D2R);
    let (dx, dz, b) = (0.5 * ct, 0.5 * st, tilt * D2R);
    let h = max(h, dz + 0.02);
    // far enough that the shadows (at most 85 deg of projected zenith) and most of the face's view stay on the strips
    let span = max(12.0, ((h + 1.0) * 12.0 * gcr).ceil()) as i32;
    let m = 2 * span as usize * EdgeGround::PER_PITCH;
    let sw = p / EdgeGround::PER_PITCH as f64;
    let x0 = -f64::from(span) * p;
    let mut g = EdgeGround { tilt, gcr, h, front, span, sky: vec![0.0; m], view: vec![0.0; m], far: 0.0, far_sky: 1.0 };
    let (k0, k1) = g.rows();
    // Sky seen from the ground: the gaps between the rows that stand and the open sky beyond row 0
    let sky_at = |x: f64| {
        let mut v = 0.0;
        let mut lo_prev = 0.0;
        for k in k0..=k1 {
            let kp = f64::from(k) * p;
            let a1 = (h + dz).atan2(kp - dx - x);
            let a2 = (h - dz).atan2(kp + dx - x);
            if k == k0 && !front { v += (max(a1, a2).cos() + 1.0) / 2.0; }   // open behind row 0
            if k > k0 { v += max(0.0, max(a1, a2).cos() - f64::cos(lo_prev)) / 2.0; }
            lo_prev = min(a1, a2);
        }
        if front { v += (1.0 - f64::cos(lo_prev)) / 2.0; }   // open in front of row 0
        v
    };
    const NG: i32 = 10;
    for s in 0..m {
        for j in 0..NG { g.sky[s] += sky_at(x0 + (s as f64 + (f64::from(j) + 0.5) / f64::from(NG)) * sw) / f64::from(NG); }
    }
    g.far_sky = if front { g.sky[m - 1] } else { g.sky[0] };
    // The open face's view of each strip, averaged over 12 points of the slant (as ground_view, nothing in its way)
    const NS: i32 = 12;
    let (lo, hi, normal) = if front { (-b, 0.0, PI / 2.0 - b) } else { (-PI, -b, -PI / 2.0 - b) };
    for i in 0..NS {
        let u = (f64::from(i) + 0.5) / f64::from(NS);
        let (px, pz) = (dx - u * ct, h - dz + u * st);
        let ang = |x: f64| clamp((-pz).atan2(x - px), lo, hi);
        let mut prev = ang(x0);
        for s in 0..m {
            let a = ang(x0 + (s + 1) as f64 * sw);
            g.view[s] += ((a - normal).sin() - (prev - normal).sin()) / 2.0 / f64::from(NS);
            prev = a;
        }
    }
    let total = if front { (1.0 - ct) / 2.0 } else { (1.0 + ct) / 2.0 };
    g.far = max(0.0, total - g.view.iter().fold(0.0, |a, x| a + x));
    g
}
