//! The exchange rate path between the project currency and the other currency of the loan or the tariff.

use super::FinanceParams;

/// Project currency per unit of the other currency for years 0 (COD) to `t_end`: flat, escalating each year, or a table of
/// yearly rates whose last value holds; the operating years are multiplied by `fx_shock`. All 1 when no other currency is set.
pub fn path(f: &FinanceParams, t_end: usize) -> Vec<f64> {
    let mut x = vec![1.0; t_end + 1];
    if !f.fx_on() { return x; }
    x[0] = f.fx_rate;
    for (t, v) in x.iter_mut().enumerate().skip(1) {
        let base = match f.fx_mode.as_str() {
            "escalate" => f.fx_rate * (1.0 + f.fx_escalation).powf(t as f64),
            "table" => f.fx_table.get(t - 1).or(f.fx_table.last()).copied().unwrap_or(f.fx_rate),
            _ => f.fx_rate,
        };
        *v = base * f.fx_shock;
    }
    x
}

/// The rate shocks of the sensitivity table: the project currency 20 % stronger to 30 % weaker than the path
pub const SHOCKS: [f64; 6] = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3];

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(mode: &str) -> FinanceParams {
        FinanceParams { fx_currency: "USD".into(), debt_fx: true, fx_rate: 100.0, fx_mode: mode.into(), fx_escalation: 0.1, fx_table: vec![110.0, 125.0], ..Default::default() }
    }

    #[test]
    fn flat_escalating_and_table_paths() {
        assert_eq!(path(&fp("flat"), 3), vec![100.0, 100.0, 100.0, 100.0]);
        let e = path(&fp("escalate"), 2);
        assert!((e[1] - 110.0).abs() < 1e-9 && (e[2] - 121.0).abs() < 1e-9);
        assert_eq!(path(&fp("table"), 4), vec![100.0, 110.0, 125.0, 125.0, 125.0]);
        let mut s = fp("flat");
        s.fx_shock = 1.2;
        assert_eq!(path(&s, 1), vec![100.0, 120.0]);   // COD keeps its rate
        assert_eq!(path(&FinanceParams::default(), 2), vec![1.0; 3]);
    }
}
