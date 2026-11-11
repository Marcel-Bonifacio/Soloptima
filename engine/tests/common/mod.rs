//! Shared by the simulation tests (sim.rs, sim_battery.rs): the example project with the C++ PV and wind profiles of
//! engine/tests/fixtures/sim.json, and the perfect forecasts the C++ self-tests plan on.
#![allow(dead_code)]
use soloptima_engine::sim::{simulate, Hourly, PerfectForecast, SimInput, SimResult, Sizing};
use soloptima_engine::{parse_project, Project, Value, HOURS};
use std::path::PathBuf;
use std::sync::OnceLock;

pub struct Fixture {
    pub doc: Value,
    pub pv: Vec<f64>,
    pub wind: Vec<f64>,
    pub example: Project,
}

pub fn read(rel: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

pub fn fixture() -> &'static Fixture {
    static FX: OnceLock<Fixture> = OnceLock::new();
    FX.get_or_init(|| {
        let doc = Value::parse(&read("tests/fixtures/sim.json")).unwrap();
        let series = |k: &str| doc.at(k).arr()[0].arr().iter().map(|x| x.num(0.0)).collect::<Vec<f64>>();
        let (pv, wind) = (series("pv_profiles"), series("wind_profiles"));
        let example = parse_project(&Value::parse(&read("../web/examples/example_study.json")).unwrap());
        Fixture { doc, pv, wind, example }
    })
}

/// The example project: 20 x 1800 kW gensets, a 16-25 MW process load, 30 MWp PV, 6.6 MWh / 2.32 MW battery, 25 years
pub fn example() -> Project { fixture().example.clone() }

/// The example's sizing (the C++ tests use 1500 kWp, 2000 kWh, 1000 kW on a 0.8-1.2 MW load)
pub const HYB: Sizing = Sizing { pv_kwp: 30000.0, bess_kwh: 6600.0, bess_kw: 2320.0, wind_units: 0.0 };

pub fn size(pv_kwp: f64, bess_kwh: f64, bess_kw: f64) -> Sizing { Sizing { pv_kwp, bess_kwh, bess_kw, wind_units: 0.0 } }

/// Simulates on the fixture PV (and wind, with turbines) with perfect forecasts
pub fn run(p: &Project, s: Sizing, hourly: bool) -> SimResult {
    let fx = fixture();
    let wind: &[f64] = if s.wind_units > 0.5 { &fx.wind } else { &[] };
    let fc = PerfectForecast::new(&fx.pv, &p.load_kw, wind);
    simulate(p, &SimInput { pv_cs_per_kwp: &[], pv_clip_per_kwp: &[], pv_per_kwp: &fx.pv, wind_per_turbine: wind, forecast: Some(&fc) }, &s, hourly).unwrap()
}

/// Year-1 fuel (L) of a case of the C++ fixture
pub fn cpp_fuel(case: &str) -> f64 {
    let c = fixture().doc.at("cases").arr().iter().find(|c| c.at("name").str() == case).unwrap_or_else(|| panic!("no case {case}"));
    c.at("result").at("fuel_l_y1").num(f64::NAN)
}

/// Largest hourly error of the load balance and of the PV split
pub fn balance_error(h: &Hourly) -> f64 {
    let mut e = 0.0f64;
    for t in 0..HOURS {
        e = e.max((h.load[t] - (h.pv_to_load[t] + h.wind_to_load[t] + h.bess_dis[t] + h.gen_to_load[t] + h.unmet[t])).abs());
        e = e.max((h.pv_avail[t] - (h.pv_to_load[t] + h.pv_to_bess[t] + h.pv_curtailed[t])).abs());
    }
    e
}
