//! One candidate system: its simulation against the diesel-only baseline, constraint check and score (src/optimizer.cpp), and the
//! inputs a sensitivity run changes.
use super::{OptSettings, Progress};
use crate::forecast::Forecaster;
use crate::json::{fmt_g, Error, Value};
use crate::model::Project;
use crate::sim::{compare, mx, simulate, Forecast, SimInput, SimResult, Sizing};

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub s: Sizing,
    pub npc: f64, pub lcoe: f64, pub re: f64, pub unmet: f64, pub curtail: f64, pub fuel: f64, pub capex: f64, pub sssi: f64,
    pub lole_h: f64, pub res_short_h: f64,
    pub npv_savings: f64, pub irr: Option<f64>, pub payback: f64,
    pub viol: f64,
    pub feasible: bool,
    pub crate_idx: usize, pub i: i32, pub j: i32,
    pub why: &'static str,
}

impl Default for Candidate {
    fn default() -> Self {
        Candidate {
            s: Sizing::default(), npc: 0.0, lcoe: 0.0, re: 0.0, unmet: 0.0, curtail: 0.0, fuel: 0.0, capex: 0.0, sssi: 0.0,
            lole_h: 0.0, res_short_h: 0.0, npv_savings: 0.0, irr: None, payback: -1.0, viol: 0.0, feasible: false,
            crate_idx: 0, i: -1, j: -1, why: "",
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
}

impl Ctx<'_> {
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

pub(crate) type SizeKey = [i64; 4];
pub(crate) fn size_key(s: &Sizing) -> SizeKey {
    [s.pv_kwp.round() as i64, s.bess_kwh.round() as i64, s.bess_kw.round() as i64, s.wind_units.round() as i64]
}

pub(crate) fn evaluate(cx: &Ctx, s: &Sizing) -> Result<Candidate, Error> {
    let (o, r) = (cx.o, simulate(cx.p, &cx.input(), s, false)?);
    let cmp = compare(&r, cx.base);
    let mut c = Candidate { s: *s, npc: r.econ.npc, lcoe: r.econ.lcoe, re: r.re_fraction, sssi: r.metrics.sssi, ..Default::default() };
    c.unmet = mx(r.unmet_fraction, r.unmet_fraction_max);   // every simulated year, so load growth counts
    for y in &r.years { c.lole_h = mx(c.lole_h, y.lol_h); c.res_short_h = mx(c.res_short_h, y.reserve_short_h); }
    c.curtail = r.curtail_fraction; c.fuel = r.fuel_l_y1; c.capex = r.econ.capex_total;
    c.npv_savings = cmp.npv_savings; c.irr = cmp.irr; c.payback = cmp.payback_years;
    let mut chk = |excess: f64, scale: f64, w: &'static str| {
        if excess > 1e-9 { c.viol += excess / scale; if c.why.is_empty() { c.why = w; } }
    };
    chk(c.unmet - o.max_unmet, mx(o.max_unmet, 1e-4), "unmet load");
    chk(o.min_re - c.re, 0.1, "renewable fraction");
    chk(c.curtail - o.max_curtail, 0.1, "curtailment");
    if o.max_lole_h >= 0.0 { chk(c.lole_h - o.max_lole_h, mx(1.0, o.max_lole_h), "loss-of-load hours"); }
    if o.max_reserve_short_h >= 0.0 { chk(c.res_short_h - o.max_reserve_short_h, mx(1.0, o.max_reserve_short_h), "reserve shortfall hours"); }
    if o.max_pv_kwp.is_finite() { chk(s.pv_kwp - o.max_pv_kwp, mx(1.0, o.max_pv_kwp), "land / PV limit"); }
    if o.max_capex.is_finite() { chk(c.capex - o.max_capex, mx(1.0, o.max_capex), "capex budget"); }
    c.feasible = c.viol <= 0.0;
    Ok(c)
}

pub(crate) fn cand_json(c: &Candidate) -> Value {
    let mut v = Value::object();
    v.set("pv_kwp", c.s.pv_kwp); v.set("bess_kwh", c.s.bess_kwh); v.set("bess_kw", c.s.bess_kw); v.set("wind_units", c.s.wind_units);
    v.set("npc", c.npc); v.set("lcoe", c.lcoe); v.set("re", c.re); v.set("sssi", c.sssi); v.set("unmet", c.unmet);
    v.set("curtail", c.curtail); v.set("fuel", c.fuel); v.set("lole_h", c.lole_h); v.set("res_short_h", c.res_short_h);
    v.set("capex", c.capex); v.set("npv_savings", c.npv_savings); v.set("irr", c.irr.map_or(Value::Null, Value::Num));
    v.set("payback", if c.payback >= 0.0 { Value::Num(c.payback) } else { Value::Null });
    v.set("feasible", c.feasible); v.set("why", c.why); v.set("crate_idx", c.crate_idx); v.set("i", c.i); v.set("j", c.j);
    v
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
        "bess_life_scale" => { p.bess.cycle_life *= val; p.bess.calendar_fade /= val; }   // val x longer life
        "bess_cycle_life" => p.bess.cycle_life = val,
        "bess_calendar_fade" => p.bess.calendar_fade = val,
        "bess_replace_kwh" => p.econ.bess_replace_kwh = val,
        "bess_prices_scale" => { p.econ.bess_capex_kwh *= val; p.econ.bess_capex_kw *= val; p.econ.bess_replace_kwh *= val; }
        "bess_replace_soh" => p.bess.replace_soh = val,
        "pv_degradation" => p.pv.degradation = val,
        "diesel_om_unit_hour" => p.econ.diesel_om_unit_hour = val,
        _ => {}
    }
}

/// Values the engine cannot use (a zero life scale, a replacement threshold of 100 %) stop the run with a readable message.
pub(crate) fn check_sensitivity(var: &str, val: f64) -> Result<(), Error> {
    let need = |ok: bool, msg: &str| if ok { Ok(()) } else { Err(Error(format!("Sensitivity value {}: {msg}", fmt_g(val, 6)))) };
    match var {
        "bess_life_scale" | "bess_cycle_life" => need(val > 0.0, "the battery life must be above 0."),
        "bess_calendar_fade" | "bess_replace_kwh" | "bess_prices_scale" | "diesel_om_unit_hour" => need(val >= 0.0, "the value must not be negative."),
        "bess_replace_soh" => need(val > 0.0 && val < 1.0, "the replacement state of health must be above 0 % and below 100 %."),
        "pv_degradation" => need((0.0..1.0).contains(&val), "the PV degradation must be at least 0 % and below 100 % per year."),
        _ => Ok(()),
    }
}
