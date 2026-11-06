//! A JSON value with the semantics of src/json.hpp: lenient accessors (`num` also reads numbers from strings and booleans),
//! keys kept sorted, the same parser limits and error messages, and the same writer, so a document written here is the
//! document the C++ engine writes. Known differences: input is `&str` (valid UTF-8), and a lone surrogate escape becomes
//! U+FFFD instead of invalid bytes; strtod's hexadecimal floats are not read.
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::fmt;

/// An error with the message the C++ engine shows (`std::runtime_error::what`)
#[derive(Debug, Clone, PartialEq)]
pub struct Error(pub String);

pub(crate) fn fail<T>(m: impl Into<String>) -> Result<T, Error> { Err(Error(m.into())) }

/// An object from (key, value) pairs
pub(crate) fn obj(kv: Vec<(&str, Value)>) -> Value {
    let mut o = Value::object();
    for (k, v) in kv { o.set(k, v); }
    o
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(BTreeMap<String, Value>),
}

static NULL: Value = Value::Null;

impl Value {
    pub fn parse(text: &str) -> Result<Value, Error> {
        let mut p = Parser { s: text.as_bytes(), p: 0 };
        p.ws();
        let v = p.value(0)?;
        p.ws();
        if p.p != p.s.len() { return Err(p.fail("trailing characters")); }
        Ok(v)
    }

    pub fn object() -> Value { Value::Obj(BTreeMap::new()) }
    pub fn array() -> Value { Value::Arr(Vec::new()) }
    /// Sets member `k` (the value becomes an object when it is not one)
    pub fn set(&mut self, k: &str, v: impl Into<Value>) {
        if !self.is_object() { *self = Value::object(); }
        if let Value::Obj(o) = self { o.insert(k.to_string(), v.into()); }
    }
    /// Appends to an array (the value becomes an array when it is not one)
    pub fn push(&mut self, v: impl Into<Value>) {
        if !self.is_array() { *self = Value::array(); }
        if let Value::Arr(a) = self { a.push(v.into()); }
    }

    pub fn is_null(&self) -> bool { matches!(self, Value::Null) }
    pub fn is_string(&self) -> bool { matches!(self, Value::Str(_)) }
    pub fn is_array(&self) -> bool { matches!(self, Value::Arr(_)) }
    pub fn is_object(&self) -> bool { matches!(self, Value::Obj(_)) }

    /// Number; a boolean is 1 or 0, a string is read like strtod (its numeric prefix); anything else is `def`
    pub fn num(&self, def: f64) -> f64 {
        match self {
            Value::Num(n) => *n,
            Value::Bool(b) => f64::from(u8::from(*b)),
            Value::Str(s) => strtod_prefix(s).map_or(def, |(d, _)| d),
            _ => def,
        }
    }
    pub fn boolean(&self, def: bool) -> bool {
        match self {
            Value::Bool(b) => *b,
            Value::Num(n) => *n != 0.0,
            _ => def,
        }
    }
    pub fn str(&self) -> &str { if let Value::Str(s) = self { s } else { "" } }
    pub fn arr(&self) -> &[Value] { if let Value::Arr(a) = self { a } else { &[] } }
    pub fn obj(&self) -> Option<&BTreeMap<String, Value>> { if let Value::Obj(o) = self { Some(o) } else { None } }

    pub fn has(&self, k: &str) -> bool { matches!(self, Value::Obj(o) if o.contains_key(k)) }
    /// Member `k`, or null (also for a value that is not an object)
    pub fn at(&self, k: &str) -> &Value {
        if let Value::Obj(o) = self { o.get(k).unwrap_or(&NULL) } else { &NULL }
    }
    pub fn idx(&self, i: usize) -> &Value { self.arr().get(i).unwrap_or(&NULL) }
    /// Number of elements of an array or members of an object
    pub fn len(&self) -> usize {
        match self { Value::Arr(a) => a.len(), Value::Obj(o) => o.len(), _ => 0 }
    }
    pub fn is_empty(&self) -> bool { self.len() == 0 }

    pub fn get(&self, k: &str, def: f64) -> f64 { self.at(k).num(def) }
    pub fn getb(&self, k: &str, def: bool) -> bool { self.at(k).boolean(def) }
    pub fn gets(&self, k: &str, def: &str) -> String {
        if let Value::Str(s) = self.at(k) { s.clone() } else { def.to_string() }
    }
    /// Array member `k` as numbers (each element read with `num(0)`)
    pub fn getv(&self, k: &str) -> Vec<f64> { self.at(k).arr().iter().map(|x| x.num(0.0)).collect() }

    /// The document as the C++ engine writes it: compact, keys sorted, numbers as in `write_number`
    pub fn dump(&self) -> String {
        let mut out = String::with_capacity(1024);
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Num(n) => write_number(out, *n),
            Value::Str(s) => write_string(out, s),
            Value::Arr(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 { out.push(','); }
                    x.write(out);
                }
                out.push(']');
            }
            Value::Obj(o) => {
                out.push('{');
                for (i, (k, v)) in o.iter().enumerate() {
                    if i > 0 { out.push(','); }
                    write_string(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }

    pub fn to_serde(&self) -> serde_json::Value {
        match self {
            Value::Null => serde_json::Value::Null,
            Value::Bool(b) => (*b).into(),
            Value::Num(n) => serde_json::Number::from_f64(*n).map_or(serde_json::Value::Null, Into::into),   // NaN, inf: null, as dump
            Value::Str(s) => s.clone().into(),
            Value::Arr(a) => serde_json::Value::Array(a.iter().map(Value::to_serde).collect()),
            Value::Obj(o) => serde_json::Value::Object(o.iter().map(|(k, v)| (k.clone(), v.to_serde())).collect()),
        }
    }
}

macro_rules! from_num { ($($t:ty),*) => {$(impl From<$t> for Value { fn from(n: $t) -> Value { Value::Num(n as f64) } })*}; }
from_num!(f64, i32, i64, u32, u64, usize);
impl From<bool> for Value { fn from(b: bool) -> Value { Value::Bool(b) } }
impl From<&str> for Value { fn from(s: &str) -> Value { Value::Str(s.to_string()) } }
impl From<String> for Value { fn from(s: String) -> Value { Value::Str(s) } }
impl From<Vec<f64>> for Value { fn from(v: Vec<f64>) -> Value { Value::Arr(v.into_iter().map(Value::Num).collect()) } }
impl From<Vec<Value>> for Value { fn from(v: Vec<Value>) -> Value { Value::Arr(v) } }

impl From<serde_json::Value> for Value {
    fn from(v: serde_json::Value) -> Value {
        match v {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(b) => Value::Bool(b),
            serde_json::Value::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(s) => Value::Str(s),
            serde_json::Value::Array(a) => Value::Arr(a.into_iter().map(Value::from).collect()),
            serde_json::Value::Object(o) => Value::Obj(o.into_iter().map(|(k, v)| (k, Value::from(v))).collect()),
        }
    }
}
impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> { self.to_serde().serialize(s) }
}
impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Value, D::Error> { Ok(serde_json::Value::deserialize(d)?.into()) }
}

/// C's `%.{prec}g`
pub fn fmt_g(d: f64, prec: usize) -> String {
    if d == 0.0 { return if d.is_sign_negative() { "-0".into() } else { "0".into() }; }
    let e = format!("{:.*e}", prec - 1, d);   // d.ddddde[-]x, correctly rounded
    let (mant, exp) = e.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let trim = |s: &str| if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s.to_string() };
    if exp < -4 || exp >= prec as i32 {
        format!("{}e{}{:02}", trim(mant), if exp < 0 { '-' } else { '+' }, exp.abs())
    } else {
        trim(&format!("{:.*}", (prec as i32 - 1 - exp).max(0) as usize, d))
    }
}

fn write_number(out: &mut String, d: f64) {
    if !d.is_finite() { out.push_str("null"); return; }
    if d == d.floor() && d.abs() < 1e15 && !(d == 0.0 && d.is_sign_negative()) {
        out.push_str(&(d as i64).to_string());
    } else {
        // 15 digits when they read back exactly, else 17, so saved projects keep every value
        let s = fmt_g(d, 15);
        out.push_str(&if s.parse::<f64>() == Ok(d) { s } else { fmt_g(d, 17) });
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// strtod: the number at the start of `s` (after white space) and the bytes it used; None when there is none
fn strtod_prefix(s: &str) -> Option<(f64, usize)> { strtod_bytes(s.as_bytes()) }

pub(crate) fn strtod_bytes(b: &[u8]) -> Option<(f64, usize)> {
    let mut i = 0;
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) { i += 1; }
    let start = i;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') { i += 1; }
    for (word, len) in [("infinity", 8usize), ("inf", 3), ("nan", 3)] {
        if b.len() >= i + len && b[i..i + len].eq_ignore_ascii_case(word.as_bytes()) {
            return std::str::from_utf8(&b[start..i + len]).ok()?.to_ascii_lowercase().parse::<f64>().ok().map(|d| (d, i + len));
        }
    }
    let digits = |mut j: usize| { let k = j; while j < b.len() && b[j].is_ascii_digit() { j += 1; } (j, j - k) };
    let (j, int) = digits(i);
    let (mut j, mut frac) = (j, 0);
    if j < b.len() && b[j] == b'.' { let (e, n) = digits(j + 1); frac = n; j = e; }
    if int + frac == 0 { return None; }
    if j < b.len() && (b[j] == b'e' || b[j] == b'E') {
        let mut k = j + 1;
        if k < b.len() && (b[k] == b'+' || b[k] == b'-') { k += 1; }
        let (e, n) = digits(k);
        if n > 0 { j = e; }
    }
    std::str::from_utf8(&b[start..j]).ok()?.parse::<f64>().ok().map(|d| (d, j))
}

struct Parser<'a> {
    s: &'a [u8],
    p: usize,
}

impl Parser<'_> {
    fn fail(&self, msg: &str) -> Error { Error(format!("JSON parse error: {msg} at offset {}", self.p)) }
    fn ws(&mut self) { while self.p < self.s.len() && matches!(self.s[self.p], b' ' | b'\n' | b'\r' | b'\t') { self.p += 1; } }
    fn peek(&self) -> u8 { self.s.get(self.p).copied().unwrap_or(0) }
    fn lit(&mut self, w: &str) -> bool {
        if self.s[self.p..].starts_with(w.as_bytes()) { self.p += w.len(); true } else { false }
    }

    fn value(&mut self, depth: u32) -> Result<Value, Error> {
        if depth > 200 { return Err(self.fail("nesting too deep")); }
        match self.peek() {
            b'{' => self.object(depth),
            b'[' => self.array(depth),
            b'"' => Ok(Value::Str(self.string()?)),
            _ if self.lit("true") => Ok(Value::Bool(true)),
            _ if self.lit("false") => Ok(Value::Bool(false)),
            _ if self.lit("null") => Ok(Value::Null),
            _ => self.number(),
        }
    }
    fn object(&mut self, depth: u32) -> Result<Value, Error> {
        self.p += 1;
        let mut o = BTreeMap::new();
        self.ws();
        if self.peek() == b'}' { self.p += 1; return Ok(Value::Obj(o)); }
        loop {
            self.ws();
            if self.peek() != b'"' { return Err(self.fail("expected key")); }
            let k = self.string()?;
            self.ws();
            if self.peek() != b':' { return Err(self.fail("expected ':'")); }
            self.p += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            o.insert(k, v);
            self.ws();
            match self.peek() {
                b',' => self.p += 1,
                b'}' => { self.p += 1; break; }
                _ => return Err(self.fail("expected ',' or '}'")),
            }
        }
        Ok(Value::Obj(o))
    }
    fn array(&mut self, depth: u32) -> Result<Value, Error> {
        self.p += 1;
        let mut a = Vec::new();
        self.ws();
        if self.peek() == b']' { self.p += 1; return Ok(Value::Arr(a)); }
        loop {
            self.ws();
            a.push(self.value(depth + 1)?);
            self.ws();
            match self.peek() {
                b',' => self.p += 1,
                b']' => { self.p += 1; break; }
                _ => return Err(self.fail("expected ',' or ']'")),
            }
        }
        Ok(Value::Arr(a))
    }
    fn hex4(&mut self) -> Result<u32, Error> {
        if self.p + 4 > self.s.len() { return Err(self.fail("bad \\u escape")); }
        let mut v = 0;
        for _ in 0..4 {
            let c = self.s[self.p];
            self.p += 1;
            v = v << 4 | match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => return Err(self.fail("bad hex digit")),
            } as u32;
        }
        Ok(v)
    }
    fn string(&mut self) -> Result<String, Error> {
        self.p += 1;
        let mut out: Vec<u8> = Vec::new();
        while self.p < self.s.len() {
            let c = self.s[self.p];
            self.p += 1;
            if c == b'"' { return Ok(String::from_utf8_lossy(&out).into_owned()); }
            if c != b'\\' { out.push(c); continue; }
            if self.p >= self.s.len() { break; }
            let e = self.s[self.p];
            self.p += 1;
            match e {
                b'"' => out.push(b'"'),
                b'\\' => out.push(b'\\'),
                b'/' => out.push(b'/'),
                b'b' => out.push(8),
                b'f' => out.push(12),
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'u' => {
                    let mut cp = self.hex4()?;
                    if (0xD800..=0xDBFF).contains(&cp) && self.p + 6 <= self.s.len() && self.s[self.p] == b'\\' && self.s[self.p + 1] == b'u' {
                        self.p += 2;
                        let lo = self.hex4()?;
                        if (0xDC00..=0xDFFF).contains(&lo) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); } else { self.p -= 6; }
                    }
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(char::from_u32(cp).unwrap_or('\u{FFFD}').encode_utf8(&mut buf).as_bytes());
                }
                _ => return Err(self.fail("bad escape")),
            }
        }
        Err(self.fail("unterminated string"))
    }
    fn number(&mut self) -> Result<Value, Error> {
        match strtod_bytes(&self.s[self.p..]) {
            Some((d, n)) => { self.p += n; Ok(Value::Num(d)) }
            None => Err(self.fail("unexpected character")),
        }
    }
}
