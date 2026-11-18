//! What the electrical modules share: complex numbers, cable resistance, the datasheet library, numbers as the interface
//! prints them, and JSON helpers. As the interface's JavaScript had them (ui/src/lib/equip/, ui/src/lib/format.js).
pub(crate) use crate::json::{num_or_null as num, obj};
use crate::json::{Value, NULL};

/// A complex number (per-unit voltages, currents and impedances)
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct C {
    pub re: f64,
    pub im: f64,
}
// plain methods, not the operator traits: the port reads like the JavaScript it replaced
#[allow(clippy::should_implement_trait)]
impl C {
    pub const fn new(re: f64, im: f64) -> C { C { re, im } }
    pub fn add(self, b: C) -> C { C::new(self.re + b.re, self.im + b.im) }
    pub fn sub(self, b: C) -> C { C::new(self.re - b.re, self.im - b.im) }
    pub fn mul(self, b: C) -> C { C::new(self.re * b.re - self.im * b.im, self.re * b.im + self.im * b.re) }
    pub fn div(self, b: C) -> C {
        let d = b.re * b.re + b.im * b.im;
        C::new((self.re * b.re + self.im * b.im) / d, (self.im * b.re - self.re * b.im) / d)
    }
    pub fn conj(self) -> C { C::new(self.re, -self.im) }
    pub fn abs(self) -> f64 { self.re.hypot(self.im) }
    pub fn scale(self, k: f64) -> C { C::new(self.re * k, self.im * k) }
}

pub const SQ3: f64 = 1.732_050_807_568_877_2;

/// Whether a conductor material is aluminium (else copper)
pub fn is_al(material: &str) -> bool { material.to_lowercase().contains("al") }
/// Temperature coefficient of a conductor material: aluminium or copper
pub fn alpha(material: &str) -> f64 { if is_al(material) { 0.00403 } else { 0.00393 } }
/// Resistance of a cable datasheet at T °C, Ω/m
pub fn r_at(cab: &Value, t: f64) -> f64 { cab.get("r20", 0.0) * (1.0 + alpha(cab.at("material").str()) * (t - 20.0)) / 1000.0 }
/// At its 70 °C operating temperature
pub fn r_hot(cab: &Value) -> f64 { r_at(cab, 70.0) }
/// dc, lv or mv, from a cable's rating text
pub fn cable_class(cab: &Value) -> &'static str {
    let r = cab.at("rating").str().to_lowercase();
    if r.contains("dc") { "dc" } else if r.contains("0.6/1") || r.contains("1 kv") || r.contains("0,6") { "lv" } else { "mv" }
}

/// A datasheet of type t with this id in a library, or null
pub fn find_in<'a>(lib: &'a Value, t: &str, id: &str) -> &'a Value {
    lib.at(t).arr().iter().find(|e| e.at("id").str() == id && !id.is_empty()).unwrap_or(&NULL)
}
/// The datasheet of type t the project has selected
pub fn selected_in<'a>(p: &'a Value, t: &str) -> &'a Value {
    let e = p.at("equipment");
    find_in(e.at("lib"), t, e.at("sel").at(t).str())
}
/// The circuit of design d with this key, or null
pub(crate) fn circuit<'a>(d: &'a Value, key: &str) -> &'a Value {
    d.at("circuits").arr().iter().find(|c| c.at("key").str() == key).unwrap_or(&NULL)
}

pub fn sum(a: &[f64]) -> f64 { let mut s = 0.0; for x in a { s += x; } s }
pub fn max_of(a: &[f64]) -> f64 { let mut m = f64::NEG_INFINITY; for &x in a { if x > m { m = x; } } m }

// --- JavaScript semantics on JSON values ---

/// Number(o[k]) as the JavaScript reads it: a missing key is NaN (undefined), null is 0
pub(crate) fn jn(o: &Value, k: &str) -> f64 {
    match o.at(k) {
        Value::Num(x) => *x,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => if o.has(k) { 0.0 } else { f64::NAN },
        Value::Str(s) => { let t = s.trim(); if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) } }
        _ => f64::NAN,
    }
}
/// JavaScript truthiness of a value
pub(crate) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Num(x) => *x != 0.0 && !x.is_nan(),
        Value::Str(s) => !s.is_empty(),
        Value::Arr(_) | Value::Obj(_) => true,
    }
}
/// Math.max and Math.min of two: NaN wins
pub(crate) fn jmax(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) } }
pub(crate) fn jmin(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) } }
/// Math.round: halves toward +infinity
pub(crate) fn jround(x: f64) -> f64 { let f = x.floor(); if x - f >= 0.5 { f + 1.0 } else { f } }
/// String(x) for a number
pub(crate) fn js_num(x: f64) -> String {
    if x.is_nan() { return "NaN".into(); }
    if x.is_infinite() { return if x > 0.0 { "Infinity" } else { "-Infinity" }.into(); }
    if x == 0.0 { return "0".into(); }
    let a = x.abs();
    if (1e-6..1e21).contains(&a) { return format!("{x}"); }
    let s = format!("{x:e}");
    match s.split_once('e') { Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"), _ => s }
}

/// toFixed: the exact binary value rounded to d decimals, an exact tie away from zero
pub(crate) fn to_fixed(x: f64, d: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 { return js_num(x); }
    let s = format!("{:.*}", d, x);
    let long = format!("{:.*}", d + 40, x);
    let tail = &long[long.len() - 40..];
    if tail.starts_with('5') && tail[1..].bytes().all(|b| b == b'0') {
        let step = 10f64.powi(-(d as i32));
        let r = format!("{:.*}", d, if x < 0.0 { x - step / 2.0 } else { x + step / 2.0 });
        if r != s { return r; }
    }
    s
}
/// Intl.NumberFormat: the shortest decimal that reads back as x, rounded to d decimals half away from zero
fn intl_fixed(x: f64, d: usize) -> String {
    let neg = x.is_sign_negative();
    let s = format!("{}", x.abs());   // shortest round-trip digits, never in exponent form
    let (int, frac) = match s.find('.') { Some(i) => (&s[..i], &s[i + 1..]), None => (s.as_str(), "") };
    let mut digits: Vec<u8> = int.bytes().chain(frac.bytes().chain(std::iter::repeat(b'0')).take(d)).map(|b| b - b'0').collect();
    if frac.len() > d && frac.as_bytes()[d] >= b'5' {
        let mut i = digits.len();
        loop {
            if i == 0 { digits.insert(0, 1); break; }
            i -= 1;
            if digits[i] == 9 { digits[i] = 0; } else { digits[i] += 1; break; }
        }
    }
    let n = digits.len() - d;
    let mut out: String = digits[..n].iter().map(|d| (d + b'0') as char).collect();
    if d > 0 { out.push('.'); out.extend(digits[n..].iter().map(|d| (d + b'0') as char)); }
    if neg { format!("-{out}") } else { out }
}
/// fmtNum: grouped with commas (en-US), d decimals; a dash for no number
pub fn fmt_num(x: f64, d: usize) -> String {
    if !x.is_finite() { return "\u{2013}".into(); }
    let s = intl_fixed(x, d);
    let (sign, s) = if let Some(r) = s.strip_prefix('-') { ("-", r) } else { ("", s.as_str()) };
    let (int, frac) = match s.find('.') { Some(i) => (&s[..i], &s[i..]), None => (s, "") };
    let mut g = String::new();
    for (i, ch) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 { g.push(','); }
        g.push(ch);
    }
    format!("{sign}{g}{frac}")
}
/// fmtPct: a share as a percentage with d decimals and " %"
pub fn fmt_pct(x: f64, d: usize) -> String {
    if !x.is_finite() { return "\u{2013}".into(); }
    to_fixed(x * 100.0, d) + " %"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbers_print_as_the_interface_prints_them() {
        assert_eq!(fmt_num(1234567.891, 0), "1,234,568");
        assert_eq!(fmt_num(2.5, 0), "3");
        assert_eq!(fmt_num(-2.5, 0), "-3");
        assert_eq!(fmt_num(0.125, 2), "0.13");
        assert_eq!(fmt_num(999.995, 2), "1,000.00");   // Intl rounds the shortest decimal, 999.995, not the binary value under it
        assert_eq!(fmt_num(1.005, 2), "1.01");
        assert_eq!(fmt_num(-0.4, 0), "-0");
        assert_eq!(fmt_num(0.5, 0), "1");
        assert_eq!(fmt_num(1e21, 0), "1,000,000,000,000,000,000,000");
        assert_eq!(fmt_pct(0.01005, 2), "1.00 %");   // toFixed rounds the binary value of 1.005 (below the tie)
        assert_eq!(fmt_num(f64::NAN, 1), "\u{2013}");
        assert_eq!(fmt_pct(0.01234, 2), "1.23 %");
        assert_eq!(fmt_num(-1500.0, 0), "-1,500");
    }
}
