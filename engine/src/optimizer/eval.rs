//! One candidate system: its simulation against the diesel-only baseline, constraint check and score (src/optimizer.cpp), and the
//! inputs a sensitivity run changes.
use super::{OptSettings, Progress};
use crate::forecast::Forecaster;
use crate::json::{fmt_g, Error, Value};
use crate::model::Project;
use crate::sim::{compare, mx, simulate, usable_kwh, Forecast, SimInput, SimResult, Sizing, YearResult};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub s: Sizing,
    pub npc: f64, pub lcoe: f64, pub re: f64, pub unmet: f64, pub curtail: f64, pub fuel: f64, pub capex: f64, pub sssi: f64,
    pub lole_h: f64, pub res_short_h: f64,
    /// days the battery alone carries the load, with the autonomy constraint only
    pub autonomy_d: Option<f64>,
    /// unserved deferrable energy / its demand, worst year (with a deferrable load only)
    pub dl_unmet: Option<f64>,
    /// steps with PV and wind falling faster than their ramp limit, worst year (with the limit on only)
    pub ramp_viol: Option<f64>,
    pub npv_savings: f64, pub irr: Option<f64>, pub payback: f64,
    pub viol: f64,
    pub feasible: bool,
    pub crate_idx: usize, pub i: i32, pub j: i32,
    pub why: &'static str,
    /// index of the genset unit rating among the candidates and its kW (with a rating search only)
    pub gen_rating: Option<(usize, f64)>,
    /// year-1 CO2 in tonnes (MOPSO with CO2 as an objective or the front statistics only)
    pub co2: Option<f64>,
}

impl Candidate {
    pub fn rating(&self) -> Option<usize> { self.gen_rating.map(|r| r.0) }
}

impl Default for Candidate {
    fn default() -> Self {
        Candidate {
            s: Sizing::default(), npc: 0.0, lcoe: 0.0, re: 0.0, unmet: 0.0, curtail: 0.0, fuel: 0.0, capex: 0.0, sssi: 0.0,
            lole_h: 0.0, res_short_h: 0.0, autonomy_d: None, dl_unmet: None, ramp_viol: None, npv_savings: 0.0, irr: None, payback: -1.0, viol: 0.0, feasible: false,
            crate_idx: 0, i: -1, j: -1, why: "", gen_rating: None, co2: None,
        }
    }
}

/// What every candidate of one search shares: the project, its PV (and wind) per unit, the forecaster and the baseline
pub(crate) struct Ctx<'a> {
    pub p: &'a Project,
    pub o: &'a OptSettings,
    pub prog: &'a Progress,
    pub pv: &'a [f64],
    pub clip: &'a [f64],
    pub cs: &'a [f64],
    pub wind: &'a [f64],
    pub fc: Option<&'a Forecaster>,
    pub base: &'a SimResult,
    /// the project at each candidate genset rating (empty without a rating search)
    pub rated: &'a [Project],
}

impl Ctx<'_> {
    /// The project a candidate runs: at its genset rating, or as it is
    pub fn proj(&self, r: Option<usize>) -> &Project { r.map_or(self.p, |k| &self.rated[k]) }

    pub fn input(&self) -> SimInput<'_> {
        SimInput { pv_per_kwp: self.pv, pv_clip_per_kwp: self.clip, pv_cs_per_kwp: self.cs, wind_per_turbine: self.wind, forecast: self.fc.map(|f| f as &dyn Forecast) }
    }
}

pub(crate) fn score(c: &Candidate, obj: &str) -> f64 {
    if !c.feasible { return f64::INFINITY; }
    match obj {
        "lcoe" => c.lcoe,
        "re" => -c.re + 1e-12 * c.npc,   // tie-break on cost
        _ => c.npc,
    }
}

pub(crate) type SizeKey = [i64; 6];
/// A size and its genset rating (None: the project's) as a key; sizes within half a unit are one
pub(crate) fn size_key(s: &Sizing, rating: Option<usize>) -> SizeKey {
    [s.pv_kwp.round() as i64, s.bess_kwh.round() as i64, s.bess_kw.round() as i64, s.wind_units.round() as i64, s.gen_units.map_or(-1, i64::from),
     rating.map_or(-1, |k| k as i64)]
}

/// Simulates size `s` with the main genset group at rating `rating` (None: the project's) against the diesel-only baseline
pub(crate) fn evaluate(cx: &Ctx, s: &Sizing, rating: Option<usize>) -> Result<Candidate, Error> {
    let p = cx.proj(rating);
    let (o, r) = (cx.o, simulate(p, &cx.input(), s, false)?);
    let cmp = compare(&r, cx.base);
    let mut c = Candidate { s: *s, npc: r.econ.npc, lcoe: r.econ.lcoe, re: r.re_fraction, sssi: r.metrics.sssi, ..Default::default() };
    c.gen_rating = rating.map(|k| (k, p.dg.unit_kw));
    if o.algorithm == "mopso" && (o.mo_second == "co2" || o.pareto_stats) { c.co2 = Some(r.metrics.co2_t); }
    // the worst of every simulated year, so load growth counts
    let worst = |f: fn(&YearResult) -> f64| r.years.iter().fold(0.0, |a, y| mx(a, f(y)));
    c.unmet = mx(r.unmet_fraction, r.unmet_fraction_max);
    (c.lole_h, c.res_short_h) = (worst(|y| y.lol_h), worst(|y| y.reserve_short_h));
    if r.x.tiers {
        // with a critical share the unmet-load and loss-of-load limits hold for the critical load; the rest may be shed
        c.unmet = mx(r.unmet_crit_fraction, r.unmet_crit_fraction_max);
        c.lole_h = worst(|y| y.lol_crit_h);
    }
    // a deferrable load's shortfall is its own figure, with its own limit (by default that of the unmet load)
    c.dl_unmet = r.x.deferrable.then(|| mx(r.dl_unmet_fraction, r.dl_unmet_fraction_max));
    c.ramp_viol = r.x.re_ramp.then(|| worst(|y| y.re_ramp_viol));
    c.curtail = r.curtail_fraction; c.fuel = r.fuel_l_y1; c.capex = r.econ.capex_total;
    c.npv_savings = cmp.npv_savings; c.irr = cmp.irr; c.payback = cmp.payback_years;
    let mut chk = |excess: f64, scale: f64, w: &'static str| {
        if excess > 1e-9 { c.viol += excess / scale; if c.why.is_empty() { c.why = w; } }
    };
    chk(c.unmet - o.max_unmet, mx(o.max_unmet, 1e-4), "unmet load");
    if let Some(d) = c.dl_unmet { let lim = o.max_dl_unmet.unwrap_or(o.max_unmet); chk(d - lim, mx(lim, 1e-4), "deferrable load"); }
    if let (Some(v), Some(lim)) = (c.ramp_viol, o.max_ramp_viol) { chk(v - lim, mx(1.0, lim), "ramp violations"); }
    chk(o.min_re - c.re, 0.1, "renewable fraction");
    chk(c.curtail - o.max_curtail, 0.1, "curtailment");
    if o.max_lole_h >= 0.0 { chk(c.lole_h - o.max_lole_h, mx(1.0, o.max_lole_h), "loss-of-load hours"); }
    if o.max_reserve_short_h >= 0.0 { chk(c.res_short_h - o.max_reserve_short_h, mx(1.0, o.max_reserve_short_h), "reserve shortfall hours"); }
    if o.min_autonomy_days > 0.0 {
        let d = autonomy_days(cx.p, o, s, r.years[0].site_load() / crate::HOURS as f64);
        c.autonomy_d = Some(d);
        chk(o.min_autonomy_days - d, o.min_autonomy_days, "days of autonomy");
    }
    if o.max_pv_kwp.is_finite() { chk(s.pv_kwp - o.max_pv_kwp, mx(1.0, o.max_pv_kwp), "land / PV limit"); }
    if o.max_capex.is_finite() { chk(c.capex - o.max_capex, mx(1.0, o.max_capex), "capex budget"); }
    c.feasible = c.viol <= 0.0;
    Ok(c)
}

/// Days the usable energy of the battery (nameplate x starting SOH x SOC window x one-way efficiency, as the autonomy of the
/// battery health summary) carries the stated load, or the year-1 mean load (auxiliaries included) with none stated
pub(crate) fn autonomy_days(p: &Project, o: &OptSettings, s: &Sizing, mean_kw: f64) -> f64 {
    let kw = if o.autonomy_load_kw > 0.0 { o.autonomy_load_kw } else { mean_kw };
    if !s.has_bess() { return 0.0; }
    if kw <= 0.0 || kw.is_nan() { return f64::INFINITY; }
    usable_kwh(&p.bess, s.bess_kwh) / (24.0 * kw)
}

pub(crate) fn cand_json(c: &Candidate) -> Value {
    let mut v = Value::object();
    v.set("pv_kwp", c.s.pv_kwp); v.set("bess_kwh", c.s.bess_kwh); v.set("bess_kw", c.s.bess_kw); v.set("wind_units", c.s.wind_units);
    if let Some(n) = c.s.gen_units { v.set("gen_units", n); }
    v.set("npc", c.npc); v.set("lcoe", c.lcoe); v.set("re", c.re); v.set("sssi", c.sssi); v.set("unmet", c.unmet);
    v.set("curtail", c.curtail); v.set("fuel", c.fuel); v.set("lole_h", c.lole_h); v.set("res_short_h", c.res_short_h);
    v.set("capex", c.capex); v.set("npv_savings", c.npv_savings); v.set("irr", c.irr);
    v.set("payback", if c.payback >= 0.0 { Value::Num(c.payback) } else { Value::Null });
    v.set("feasible", c.feasible); v.set("why", c.why); v.set("crate_idx", c.crate_idx); v.set("i", c.i); v.set("j", c.j);
    if let Some(d) = c.autonomy_d { v.set("autonomy_d", if d.is_finite() { Value::Num(d) } else { Value::Null }); }
    if let Some(d) = c.dl_unmet { v.set("dl_unmet", d); }
    if let Some(n) = c.ramp_viol { v.set("ramp_viol", n); }
    if let Some((k, kw)) = c.gen_rating { v.set("gen_rating", k); v.set("gen_kw", kw); }
    if let Some(t) = c.co2 { v.set("co2_t", t); }
    v
}

/// The system type of a size: PV, battery, wind and gensets each present or not
pub(crate) fn type_key(p: &Project, s: &Sizing) -> [bool; 4] {
    let others = p.dg.more_groups.iter().any(|g| g.units > 0);   // further groups of a mixed fleet keep their units
    [s.pv_kwp > 0.0, s.has_bess(), s.wind_units > 0.5, s.gen_units.unwrap_or(p.dg.units) > 0 || others]
}

pub(crate) fn type_label(k: [bool; 4]) -> String {
    let names: Vec<&str> = ["PV", "battery", "wind", "diesel"].into_iter().zip(k).filter(|x| x.1).map(|x| x.0).collect();
    if names.is_empty() { "no supply".to_string() } else { names.join(" + ") }
}

/// The system types among `cands` (PV, battery, wind, gensets each present or not), each with the candidates evaluated and
/// feasible and its best feasible design by the objective; the types with a feasible design first, cheapest first.
pub(crate) fn architectures<'a>(p: &Project, o: &OptSettings, cands: impl Iterator<Item = &'a Candidate>) -> Value {
    best_by_type(p, o, cands).into_iter().map(|(k, (n, nf, best))| {
        let mut v = Value::object();
        v.set("label", type_label(k));
        v.set("pv", k[0]); v.set("bess", k[1]); v.set("wind", k[2]); v.set("gensets", k[3]);
        v.set("n_evaluated", n); v.set("n_feasible", nf);
        v.set("best", best.map_or(Value::Null, cand_json));
        v
    }).collect::<Vec<_>>().into()
}

/// Candidates evaluated and feasible of one system type, and its best feasible design
pub(crate) type TypeCount<'a> = (usize, usize, Option<&'a Candidate>);

/// Each system type among `cands` with the candidates evaluated and feasible and its best feasible design, the types with a
/// feasible design first, cheapest first
pub(crate) fn best_by_type<'a>(p: &Project, o: &OptSettings, cands: impl Iterator<Item = &'a Candidate>) -> Vec<([bool; 4], TypeCount<'a>)> {
    let mut types: BTreeMap<[bool; 4], TypeCount> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for c in cands {
        if !seen.insert(size_key(&c.s, c.rating())) { continue; }
        let t = types.entry(type_key(p, &c.s)).or_insert((0, 0, None));
        t.0 += 1;
        if c.feasible {
            t.1 += 1;
            if t.2.is_none_or(|b| score(c, &o.objective) < score(b, &o.objective)) { t.2 = Some(c); }
        }
    }
    let mut rows: Vec<_> = types.into_iter().collect();
    rows.sort_by(|a, b| {
        let f = |r: &TypeCount| r.2.map_or(f64::INFINITY, |c| score(c, &o.objective));
        f(&a.1).partial_cmp(&f(&b.1)).unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

pub(crate) fn linspace(a: f64, b: f64, n: i32) -> Vec<f64> {
    if n <= 1 || b <= a { return vec![a]; }
    (0..n).map(|k| a + (b - a) * f64::from(k) / f64::from(n - 1)).collect()
}

/// eol_soh is left out on purpose: it also sets the fade per cycle, so the cycle part always reaches it after
/// cycle_life x cycle_life_dod EFC.
pub(crate) fn apply_sensitivity(p: &mut Project, var: &str, val: f64) {
    match var {
        "fuel_price" => p.econ.fuel_price = val,
        "discount_rate" => p.econ.discount_rate = val,
        "pv_capex_kwp" => p.econ.pv_capex_kwp = val,
        "bess_capex_kwh" => p.econ.bess_capex_kwh = val,
        "fuel_escalation" => p.econ.fuel_escalation = val,
        "load_scale" => for x in &mut p.load_kw { *x *= val; },
        "bess_life_scale" => {   // val x longer life
            p.bess.cycle_life *= val;
            p.bess.calendar_fade /= val;
            for pt in &mut p.bess.cycle_curve { pt.1 *= val; }
        }
        "bess_cycle_life" => {   // a cycle-life curve moves in proportion
            let f = val / p.bess.cycle_life;
            for pt in &mut p.bess.cycle_curve { pt.1 *= f; }
            p.bess.cycle_life = val;
        }
        "bess_calendar_fade" => p.bess.calendar_fade = val,
        "bess_replace_kwh" => p.econ.bess_replace_kwh = val,
        "bess_prices_scale" => { p.econ.bess_capex_kwh *= val; p.econ.bess_capex_kw *= val; p.econ.bess_replace_kwh *= val; }
        "bess_replace_soh" => p.bess.replace_soh = val,
        "pv_degradation" => p.pv.degradation = val,
        "diesel_om_unit_hour" => p.econ.diesel_om_unit_hour = val,
        "irradiance_scale" => p.pv.irradiance_scale *= val,   // x the project's own scale (1 unless set)
        "wind_speed_scale" => p.wind.speed_scale *= val,
        _ => {}
    }
}

/// The inputs a sensitivity run or a map can change
pub(crate) const SENS_VARS: [&str; 16] = ["fuel_price", "fuel_escalation", "discount_rate", "pv_capex_kwp", "bess_capex_kwh", "load_scale",
    "bess_life_scale", "bess_cycle_life", "bess_calendar_fade", "bess_replace_kwh", "bess_prices_scale", "bess_replace_soh", "pv_degradation",
    "diesel_om_unit_hour", "irradiance_scale", "wind_speed_scale"];

/// Values the engine cannot use (a zero life scale, a replacement threshold of 100 %) stop the run with a readable message.
pub(crate) fn check_sensitivity(var: &str, val: f64) -> Result<(), Error> {
    let need = |ok: bool, msg: &str| if ok { Ok(()) } else { Err(Error(format!("Sensitivity value {}: {msg}", fmt_g(val, 6)))) };
    match var {
        "bess_life_scale" | "bess_cycle_life" => need(val > 0.0, "the battery life must be above 0."),
        "bess_calendar_fade" | "bess_replace_kwh" | "bess_prices_scale" | "diesel_om_unit_hour" => need(val >= 0.0, "the value must not be negative."),
        "bess_replace_soh" => need(val > 0.0 && val < 1.0, "the replacement state of health must be above 0 % and below 100 %."),
        "pv_degradation" => need((0.0..1.0).contains(&val), "the PV degradation must be at least 0 % and below 100 % per year."),
        "irradiance_scale" | "wind_speed_scale" => need(val > 0.0 && val <= 2.0, "a resource scale must be above 0 and at most 2."),
        _ => Ok(()),
    }
}
