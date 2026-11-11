//! Rewrites a fixture for a deliberate change of the engine's answers: run the parity tests with SOLOPTIMA_BLESS=1, check the
//! diff of tests/fixtures, and say in the commit which change moved them (fixtures/README.md).
use soloptima_engine::Value;

pub fn on() -> bool { std::env::var_os("SOLOPTIMA_BLESS").is_some() }

/// Sets each "a/0/b" path of the fixture file `rel` (relative to engine/) to its value and writes the file back.
pub fn write(rel: &str, updates: Vec<(String, Value)>) {
    if updates.is_empty() { return; }
    let path = format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"));
    let mut doc = Value::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
    for (p, v) in updates {
        let mut node = &mut doc;
        for k in p.split('/') {
            node = match node {
                Value::Arr(a) => &mut a[k.parse::<usize>().unwrap()],
                Value::Obj(o) => o.get_mut(k).unwrap_or_else(|| panic!("{rel}: no {p}")),
                _ => panic!("{rel}: {p} is not a container"),
            };
        }
        *node = v;
    }
    std::fs::write(&path, doc.dump()).unwrap();
}
