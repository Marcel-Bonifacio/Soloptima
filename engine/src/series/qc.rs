//! Data checks of the project's weather and load (`data_qc` in src/series.cpp): flags per hour, timing against the sun, load level
//! shifts. Output as the C++ engine's (src/series.hpp).
use super::{fail, R};
use crate::json::Value;
use crate::weather::max0;
use crate::model::{month_of_day, Project, HOURS};
use crate::solar::{equation_of_time, haurwitz_ghi, local_shift, sun_position, SunPos};
use std::f64::consts::PI;

fn sum(it: impl Iterator<Item = f64>) -> f64 { it.fold(0.0, |a, b| a + b) }

fn quantile(v: &[f64], q: f64) -> f64 {
    let mut v = v.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let x = q * (v.len() - 1) as f64;
    let i = x as usize;
    if i + 1 < v.len() { v[i] + (x - i as f64) * (v[i + 1] - v[i]) } else { v[i] }
}

struct Flag {
    id: &'static str,
    label: &'static str,
    hit: Vec<bool>,
    hours: usize,
}

#[derive(Default)]
struct Flags {
    f: Vec<Flag>,
    list: Vec<(usize, usize, f64)>,
}

impl Flags {
    fn add(&mut self, id: &'static str, label: &'static str) -> usize {
        self.f.push(Flag { id, label, hit: vec![false; HOURS], hours: 0 });
        self.f.len() - 1
    }
    fn mark(&mut self, k: usize, i: usize, v: f64) {
        if self.f[k].hit[i] { return; }
        self.f[k].hit[i] = true;
        self.f[k].hours += 1;
        self.list.push((i, k, v));
    }
    /// shift: file hour to local standard hour; ghi: for the share of the year's irradiation in flagged hours (weather)
    fn to_json(&mut self, shift: i32, ghi: Option<&[f64]>) -> Value {
        let h = HOURS as i32;
        let local = |i: usize| ((i as i32 + shift) % h + h) % h;
        let total: f64 = ghi.map_or(0.0, |g| sum(g.iter().map(|&x| max0(x))));
        let mut any = vec![false; HOURS];
        let mut any_day = vec![false; 365];
        let mut flags = Value::array();
        for x in &self.f {
            let mut day = vec![false; 365];
            let mut g = 0.0;
            for i in 0..HOURS {
                if !x.hit[i] { continue; }
                any[i] = true;
                day[local(i) as usize / 24] = true;
                any_day[local(i) as usize / 24] = true;
                if let Some(gh) = ghi { g += max0(gh[i]); }
            }
            let mut e = Value::object();
            e.set("id", x.id);
            e.set("label", x.label);
            e.set("hours", x.hours);
            e.set("days", day.iter().filter(|&&d| d).count());
            if ghi.is_some() { e.set("ghi_share", if total > 0.0 { g / total } else { 0.0 }); }
            flags.push(e);
        }
        self.list.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut hours = Value::array();
        for &(i, k, v) in self.list.iter().take(200) {
            let mut e = Value::object();
            e.set("i", i);
            e.set("h", local(i));
            e.set("flag", self.f[k].id);
            e.set("v", v);
            hours.push(e);
        }
        let mut days = Value::array();
        for (d, &a) in any_day.iter().enumerate() { if a { days.push(d); } }
        let n_days = days.len();
        let mut o = Value::object();
        o.set("flags", flags);
        o.set("hours", hours);
        o.set("n_flagged", any.iter().filter(|&&a| a).count());
        o.set("n_list", self.list.len());
        o.set("days", days);
        o.set("score", 1.0 - n_days as f64 / 365.0);
        if let Some(gh) = ghi {
            let g_any: f64 = sum((0..HOURS).filter(|&i| any[i]).map(|i| max0(gh[i])));
            o.set("ghi_share", if total > 0.0 { g_any / total } else { 0.0 });
        }
        o
    }
}

fn constant(v: &[f64]) -> bool { v.iter().all(|&x| x == v[0]) }

fn stuck(f: &mut Flags, k: usize, v: &[f64], ok: impl Fn(usize) -> bool, min_len: usize) {
    let mut a = 0;
    while a < HOURS {
        if !ok(a) || v[a] == 0.0 { a += 1; continue; }
        let mut b = a + 1;
        while b < HOURS && ok(b) && v[b] == v[a] { b += 1; }
        if b - a >= min_len { for i in a..b { f.mark(k, i, v[i]); } }
        a = b;
    }
}

/// The same value at the same hour on 3 or more consecutive days
fn copied(f: &mut Flags, k: usize, v: &[f64], ok: impl Fn(usize) -> bool) {
    for h in 0..24 {
        let mut d = 0;
        while d < 365 {
            let i = d * 24 + h;
            if !ok(i) { d += 1; continue; }
            let mut e = d + 1;
            while e < 365 && ok(e * 24 + h) && v[e * 24 + h] == v[i] { e += 1; }
            if e - d >= 3 { for x in d..e { f.mark(k, x * 24 + h, v[x * 24 + h]); } }
            d = e;
        }
    }
}

/// Sun at time t in hours of the weather file's own time base, timed as compute_pv_profile times the representative instant
fn sun_file(p: &Project, t: f64) -> SunPos {
    let u = if p.wx.is_utc { t } else { t - p.loc.utc_offset };
    let u = (u + 2.0 * HOURS as f64) % HOURS as f64;
    sun_position(p.loc.lat, p.loc.lon, (u / 24.0) as i32 + 1, u % 24.0)
}

/// IEEE remainder: x - n y with n the integer nearest x / y (ties to even)
fn remainder(x: f64, y: f64) -> f64 {
    let r = x % y;
    let n = ((x - r) / y).round();
    if r > y / 2.0 || (r == y / 2.0 && n % 2.0 == 0.0) { r - y }
    else if r < -y / 2.0 || (r == -y / 2.0 && n % 2.0 == 0.0) { r + y }
    else { r }
}

/// Timing against the sun: centroid of each clear day's irradiance against the clear-sky model's, over 24 h centred on solar noon in
/// the file's time base. The window moves by the whole hours of the mean offset so a wrong UTC flag does not cut the day.
fn timing(p: &Project, ghi: &[f64]) -> Value {
    let w = &p.wx;
    let (to, off) = (w.time_offset, p.loc.utc_offset);
    let (mut g, mut c) = (vec![0.0; HOURS], vec![0.0; HOURS]);
    let (mut gx, mut gy, mut cx, mut cy) = (0.0, 0.0, 0.0, 0.0);
    for i in 0..HOURS {
        g[i] = max0(ghi[i]);
        let mut s = 0.0;   // Haurwitz clear sky averaged over the hour's interval
        for j in 0..6 { s += haurwitz_ghi(sun_file(p, i as f64 + to - 0.5 + (f64::from(j) + 0.5) / 6.0).cos_zenith); }
        c[i] = s / 6.0;
        let th = 2.0 * PI * (i as f64 + to) / 24.0;
        let (ct, st) = (th.cos(), th.sin());
        gx += g[i] * ct; gy += g[i] * st;
        cx += c[i] * ct; cy += c[i] * st;
    }
    let coarse = remainder((gy.atan2(gx) - cy.atan2(cx)) * 24.0 / (2.0 * PI), 24.0);
    let k = coarse.round() as i64;
    struct Day { d: usize, kt: f64, var: f64, off: f64 }
    let mut days: Vec<Day> = Vec::new();
    let mut kt_m: Vec<Vec<f64>> = vec![vec![]; 12];
    for d in 0..365usize {
        let b = 2.0 * PI * d as f64 / 365.0;
        let eot = equation_of_time(b);
        let noon = 12.0 - p.loc.lon / 15.0 - eot / 60.0 + if w.is_utc { 0.0 } else { off };
        let i0 = (d as f64 * 24.0 + noon - 12.0 - to - 1e-9).ceil() as i64;
        if i0 < 0 || i0 + 24 > HOURS as i64 || i0 + k < 0 || i0 + k + 24 > HOURS as i64 { continue; }
        let (mut sg, mut sc, mut mg, mut mc, mut vg, mut vc) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        for j in 0..24i64 {
            let (ig, ic) = ((i0 + k + j) as usize, (i0 + j) as usize);
            sg += g[ig]; sc += c[ic];
            mg += (ig as f64 + to) * g[ig]; mc += (ic as f64 + to) * c[ic];
            if j > 0 { vg += (g[ig] - g[ig - 1]).abs(); vc += (c[ic] - c[ic - 1]).abs(); }
        }
        if sg <= 0.0 || sc <= 0.0 || vc <= 0.0 { continue; }
        days.push(Day { d, kt: sg / sc, var: vg / vc, off: (mg / sg - mc / sc) * 60.0 });
        kt_m[month_of_day(d as i32) as usize].push(sg / sc);
    }
    let mut p90 = vec![0.0; 12];
    for m in 0..12 { if !kt_m[m].is_empty() { p90[m] = quantile(&kt_m[m], 0.9); } }
    let (mut offs, mut by_m): (Vec<f64>, Vec<Vec<f64>>) = (vec![], vec![vec![]; 12]);
    for x in &days {
        let m = month_of_day(x.d as i32) as usize;
        if x.kt >= 0.9 * p90[m] && x.var <= 1.5 { offs.push(x.off); by_m[m].push(x.off); }
    }
    let mut monthly = Value::array();
    let (mut lo, mut hi) = (1e300f64, -1e300f64);
    for v in &by_m {
        if v.is_empty() { monthly.push(Value::Null); continue; }
        let med = quantile(v, 0.5);
        monthly.push(med);
        if v.len() >= 3 { lo = lo.min(med); hi = hi.max(med); }
    }
    let n = offs.len();
    let mut o = Value::object();
    o.set("n_days", n);
    o.set("monthly", monthly);
    o.set("coarse_h", coarse);
    o.set("verdict", "none");
    o.set("shift_h", 0);
    if n == 0 { return o; }
    let med = quantile(&offs, 0.5);
    let iqr = quantile(&offs, 0.75) - quantile(&offs, 0.25);
    o.set("median_min", med);
    o.set("iqr_min", iqr);
    o.set("clock_change", hi > lo && hi - lo >= 40.0 && hi - lo <= 80.0);
    o.set("month_spread_min", if hi > lo { hi - lo } else { 0.0 });
    if n < 10 { return o; }
    // positive: the data's day comes later than the sun's
    let u = (if w.is_utc { 1.0 } else { -1.0 }) * off * 60.0;
    let kk = (med / 60.0).round() as i64;
    let mut v = "unclear";
    if off.abs() >= 0.75 && (med - u).abs() <= 20.0 { v = "utc"; }
    else if med.abs() < 10.0 { v = "ok"; }
    else if med.abs() >= 20.0 && med.abs() <= 40.0 { v = "half"; }
    else if kk != 0 && (med - 60.0 * kk as f64).abs() <= 10.0 * kk.abs() as f64 { v = "hours"; o.set("shift_h", kk); }
    o.set("verdict", v);
    o
}

fn weather_qc(p: &Project) -> R<Value> {
    let w = &p.wx;
    let g = &w.ghi;
    let (has_t, has_w) = (w.tamb.len() == HOURS, w.wind.len() == HOURS);
    let has_d = w.dhi.len() == HOURS && w.dni.len() == HOURS;
    let (t_const, w_const) = (!has_t || constant(&w.tamb), !has_w || constant(&w.wind));
    let to = w.time_offset;
    let mut f = Flags::default();
    let k_night = f.add("night", "Irradiance at night (GHI above 5 W/m² with the sun below the horizon)");
    let k_drop = f.add("dropout", "Zero GHI with the sun more than 15° high");
    let k_glim = f.add("ghi_limit", "GHI above the physically possible limit");
    let k_dlim = f.add("dhi_limit", "DHI above the physically possible limit");
    let k_dgt = f.add("dhi_gt_ghi", "DHI above GHI");
    // comparison tests of Long and Shi (2008): the components must add up, and the beam on a horizontal plane cannot exceed GHI
    let k_clos = f.add("closure", "GHI differs from DNI × cos(zenith) + DHI by more than 8 % (sun above 15°) or 15 % (lower sun)");
    let k_beam = f.add("beam_gt_ghi", "Beam on a horizontal plane (DNI × cos zenith) above GHI");
    let k_flat = f.add("flat_ghi", "GHI stuck at one value for 4 daylight hours or more");
    let k_copy = f.add("copy_ghi", "GHI repeated at the same hour on 3 days or more");
    let k_trng = f.add("t_range", "Temperature outside -40 to 60 °C");
    let k_tstep = f.add("t_step", "Temperature step above 10 °C in an hour");
    let k_tflat = f.add("flat_t", "Temperature stuck at one value for 6 h or more");
    let k_tcopy = f.add("copy_t", "Temperature repeated at the same hour on 3 days or more");
    let k_wrng = f.add("wind_range", "Wind speed below 0 or above 40 m/s");
    let k_wflat = f.add("flat_wind", "Wind speed stuck at one value for 6 h or more");
    let mut day = vec![false; HOURS];
    for i in 0..HOURS {
        let fi = i as f64;
        let (a, m, b) = (sun_file(p, fi + to - 0.5), sun_file(p, fi + to), sun_file(p, fi + to + 0.5));
        let (gi, mu) = (g[i], max0(m.cos_zenith).powf(1.2));
        day[i] = m.cos_zenith > 0.0;
        if gi > 5.0 && a.zenith_deg > 92.0 && m.zenith_deg > 92.0 && b.zenith_deg > 92.0 { f.mark(k_night, i, gi); }
        if gi <= 0.0 && m.zenith_deg < 75.0 { f.mark(k_drop, i, gi); }
        if gi > 1.5 * m.extra_normal * mu + 100.0 { f.mark(k_glim, i, gi); }
        if has_d {
            let dh = w.dhi[i];
            if dh > 0.95 * m.extra_normal * mu + 50.0 { f.mark(k_dlim, i, dh); }
            if gi > 50.0 && dh > 1.05 * gi + 10.0 { f.mark(k_dgt, i, dh); }
            let bh = w.dni[i] * max0(m.cos_zenith);
            let sum = bh + dh;
            if sum > 50.0 && m.zenith_deg < 93.0 && (gi / sum - 1.0).abs() > if m.zenith_deg < 75.0 { 0.08 } else { 0.15 } { f.mark(k_clos, i, gi); }
            if bh > 1.05 * gi + 10.0 { f.mark(k_beam, i, w.dni[i]); }
        }
    }
    stuck(&mut f, k_flat, g, |i| day[i], 4);
    copied(&mut f, k_copy, g, |i| day[i] && g[i] > 0.0);
    if !t_const {
        let t = &w.tamb;
        for i in 0..HOURS {
            if t[i] < -40.0 || t[i] > 60.0 { f.mark(k_trng, i, t[i]); }
            if i > 0 && (t[i] - t[i - 1]).abs() > 10.0 { f.mark(k_tstep, i, t[i]); }
        }
        stuck(&mut f, k_tflat, t, |_| true, 6);
        copied(&mut f, k_tcopy, t, |_| true);
    }
    if !w_const {
        for i in 0..HOURS { if w.wind[i] < 0.0 || w.wind[i] > 40.0 { f.mark(k_wrng, i, w.wind[i]); } }
        stuck(&mut f, k_wflat, &w.wind, |_| true, 6);
    }
    let (n, fr) = local_shift(p)?;
    let mut o = f.to_json(n + i32::from(fr >= 0.5), Some(g));
    let mut set = Value::array();
    if t_const { let mut e = Value::object(); e.set("id", "t_absent"); e.set("value", if has_t { Value::from(w.tamb[0]) } else { Value::Null }); set.push(e); }
    if w_const { let mut e = Value::object(); e.set("id", "wind_absent"); e.set("value", if has_w { Value::from(w.wind[0]) } else { Value::Null }); set.push(e); }
    let annual: f64 = sum(g.iter().map(|&x| max0(x) / 1000.0));
    if annual < 700.0 || annual > 2700.0 { let mut e = Value::object(); e.set("id", "ghi_annual"); e.set("kwh_m2", annual); set.push(e); }
    o.set("set", set);
    o.set("timing", timing(p, g));
    Ok(o)
}

/// Level shifts of the daily mean load: binary segmentation on its logarithm, at most 5 change points, each a step of at
/// least 10 % between segments of 30 days or more that lowers the squared error by more than the BIC penalty.
fn level_shifts(l: &[f64]) -> Value {
    let mut mean = vec![0.0; 365];
    for i in 0..HOURS { mean[i / 24] += l[i] / 24.0; }
    let floor_v = (1e-9f64).max(0.01 * quantile(&mean, 0.5));
    let x: Vec<f64> = mean.iter().map(|&m| m.max(floor_v).ln()).collect();
    let (mut s, mut q) = (vec![0.0; 366], vec![0.0; 366]);
    for d in 0..365 { s[d + 1] = s[d] + x[d]; q[d + 1] = q[d] + x[d] * x[d]; }
    let dx: Vec<f64> = (1..365).map(|d| x[d] - x[d - 1]).collect();
    // noise from the day-to-day changes (median-based, so a step does not inflate it): sigma = 1.4826 MAD / sqrt(2), at least 0.5 %
    let med_dx = quantile(&dx, 0.5);
    let ad: Vec<f64> = dx.iter().map(|v| (v - med_dx).abs()).collect();
    let sigma = (0.005f64).max(1.4826 * quantile(&ad, 0.5) / 2f64.sqrt());
    let pen = 2.0 * sigma * sigma * 365f64.ln();
    let sse = |a: usize, b: usize| { let n = (b - a) as f64; let t = s[b] - s[a]; q[b] - q[a] - t * t / n };
    let avg = |a: usize, b: usize| (s[b] - s[a]) / (b - a) as f64;
    let mut cps: Vec<usize> = Vec::new();
    for _ in 0..5 {
        let mut edges = vec![0usize];
        edges.extend(&cps);
        edges.push(365);
        let mut best = pen;
        let mut at: Option<usize> = None;
        for w in edges.windows(2) {
            let (a, b) = (w[0], w[1]);
            let mut k = a + 30;
            while k + 30 <= b {
                if ((avg(k, b) - avg(a, k)).exp() - 1.0).abs() >= 0.1 {
                    let gain = sse(a, b) - sse(a, k) - sse(k, b);
                    if gain > best { best = gain; at = Some(k); }
                }
                k += 1;
            }
        }
        let Some(at) = at else { break };
        let pos = cps.partition_point(|&c| c <= at);
        cps.insert(pos, at);
    }
    let mut out = Value::array();
    for j in 0..cps.len() {
        let a = if j > 0 { cps[j - 1] } else { 0 };
        let (k, b) = (cps[j], if j + 1 < cps.len() { cps[j + 1] } else { 365 });
        let s0: f64 = sum(mean[a..k].iter().copied());
        let s1: f64 = sum(mean[k..b].iter().copied());
        let mut e = Value::object();
        e.set("day", k);
        e.set("before_kw", s0 / (k - a) as f64);
        e.set("after_kw", s1 / (b - k) as f64);
        out.push(e);
    }
    out
}

fn load_qc(p: &Project) -> Value {
    let l = &p.load_kw;
    let p95 = quantile(l, 0.95);
    let (lo, tol) = (0.02 * p95, 1e-9 * p95.max(1.0));
    let mut f = Flags::default();
    let k_out = f.add("outage", "Near-zero load for 2 h or more (below 2 % of the 95th percentile)");
    let k_flat = f.add("flat", "Load stuck at one value for 6 h or more while the rest of the day varies");
    let k_lin = f.add("linear", "Linear infill (4 or more equal steps in a row)");
    let k_spike = f.add("spike", "Spike above the usual load at that hour of the week");
    let mut a = 0;
    while a < HOURS {   // near-zero runs
        if l[a] >= lo { a += 1; continue; }
        let mut b = a;
        while b < HOURS && l[b] < lo { b += 1; }
        if b - a >= 2 { for i in a..b { f.mark(k_out, i, l[i]); } }
        a = b;
    }
    a = 0;
    while a < HOURS {   // the same value for 6 h or more while the rest of its days varies by over 1 % of its mean
        let mut b = a + 1;
        while b < HOURS && l[b] == l[a] { b += 1; }
        if b - a >= 6 && l[a] >= lo {
            let mut rest: Vec<f64> = (a / 24 * 24..HOURS.min((b - 1) / 24 * 24 + 24)).filter(|&i| i < a || i >= b).map(|i| l[i]).collect();
            if rest.len() < 3 {
                rest = (a.saturating_sub(24)..HOURS.min(b + 24)).filter(|&i| i < a || i >= b).map(|i| l[i]).collect();
            }
            if !rest.is_empty() {
                let mn = rest.iter().cloned().fold(f64::INFINITY, f64::min);
                let mx = rest.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let mut m = 0.0;
                for v in &rest { m += v / rest.len() as f64; }
                if mx - mn > 0.01 * m { for i in a..b { f.mark(k_flat, i, l[i]); } }
            }
        }
        a = b;
    }
    a = 1;
    while a < HOURS {   // 4 or more equal non-zero steps: the hours between the first and the last are infilled
        let d = l[a] - l[a - 1];
        if d.abs() <= tol { a += 1; continue; }
        let mut b = a + 1;
        while b < HOURS && (l[b] - l[b - 1] - d).abs() <= tol { b += 1; }
        if b - a >= 4 { for i in a..b - 1 { f.mark(k_lin, i, l[i]); } }
        a = b;
    }
    // above the median + 6 x 1.4826 MAD of the same hour of the week in the 8 weeks before and after, so a level shift or a
    // season does not make a whole period look like spikes
    for i in 0..HOURS {
        let v: Vec<f64> = (-8i64..=8).map(|w| i as i64 + w * 168).filter(|&j| j >= 0 && j < HOURS as i64).map(|j| l[j as usize]).collect();
        let med = quantile(&v, 0.5);
        let dev: Vec<f64> = v.iter().map(|x| (x - med).abs()).collect();
        let mad = quantile(&dev, 0.5);
        if mad > 0.0 && l[i] > med + 6.0 * 1.4826 * mad { f.mark(k_spike, i, l[i]); }
    }
    let mut o = f.to_json(0, None);
    let mut set = Value::array();
    // units: a peak above the genset fleet or below a fifth of one unit, with the unit errors that would fit
    // (a mixed fleet: its whole rating, and its smallest unit)
    let (mut fleet, mut unit) = (f64::from(p.dg.units) * p.dg.unit_kw, p.dg.unit_kw);
    for g in &p.dg.more_groups { fleet += f64::from(g.units.max(0)) * g.unit_kw; if g.units > 0 { unit = unit.min(g.unit_kw); } }
    let peak = l.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if fleet > 0.0 && (peak > fleet || peak < 0.2 * unit) {
        let fits = |x: f64| x >= 0.2 * unit && x <= fleet;
        let mut hints = Value::array();
        if peak > fleet && fits(peak / 1000.0) { hints.push("w"); }
        if peak < 0.2 * unit {
            if fits(peak * 4.0) { hints.push("kwh_15min"); }
            if fits(peak * 2.0) { hints.push("kwh_30min"); }
            if fits(peak * 1000.0) { hints.push("mw"); }
        }
        let mut e = Value::object();
        e.set("id", "units");
        e.set("peak_kw", peak);
        e.set("fleet_kw", fleet);
        e.set("unit_kw", unit);
        e.set("above", peak > fleet);
        e.set("hints", hints);
        set.push(e);
    }
    let shifts = level_shifts(l);
    if !shifts.is_empty() { let mut e = Value::object(); e.set("id", "level_shift"); e.set("shifts", shifts); set.push(e); }
    o.set("set", set);
    o.set("p95_kw", p95);
    o
}

/// `only`: "weather", "load" or empty for both. Returns {weather, load}, each null without data.
pub fn data_qc(p: &Project, only: &str) -> R<Value> {
    if !(p.loc.lat.abs() <= 90.0 && p.loc.lon.abs() <= 180.0) { return fail("Location latitude/longitude out of range."); }
    if !(p.loc.utc_offset.abs() <= 14.0) { return fail("UTC offset must be between -14 h and +14 h."); }
    if !(p.wx.time_offset.abs() <= 24.0) { return fail("The weather time offset must be within 24 h."); }
    let mut o = Value::object();
    o.set("weather", if only != "load" && p.wx.ghi.len() == HOURS { weather_qc(p)? } else { Value::Null });
    o.set("load", if only != "weather" && p.load_kw.len() == HOURS { load_qc(p) } else { Value::Null });
    Ok(o)
}
