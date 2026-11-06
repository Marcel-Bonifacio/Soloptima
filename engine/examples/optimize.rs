//! Headless sizing with the project's "optimizer" block, as `soloptima optimize project.json [out.json]` of the C++ engine:
//!   cargo run --release -p soloptima-engine --example optimize -- web/examples/example_study.json /tmp/out.json
use soloptima_engine::optimizer::{optimize, parse_opt_settings, Progress};
use soloptima_engine::{parse_project, validate_project, Error, Value};
use std::sync::atomic::Ordering::Relaxed;
use std::time::Instant;

fn run(args: &[String]) -> Result<(), Error> {
    let text = std::fs::read_to_string(&args[0]).map_err(|_| Error(format!("Cannot open {}", args[0])))?;
    let v = Value::parse(&text)?;
    let p = parse_project(&v);
    validate_project(&p)?;
    let o = parse_opt_settings(v.at("optimizer"), &p)?;
    let prog = Progress::default();
    let t0 = Instant::now();
    let res = optimize(&p, &o, &prog)?;
    eprintln!("  {} simulations in {:.1} s", prog.done.load(Relaxed), t0.elapsed().as_secs_f64());
    match args.get(1) {
        Some(out) => {
            std::fs::write(out, res.dump()).map_err(|_| Error(format!("Cannot write {out}")))?;
            eprintln!("Wrote {out}");
        }
        None => println!("{}", res.dump()),
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: optimize project.json [out.json]");
        std::process::exit(2);
    }
    if let Err(e) = run(&args) {
        eprintln!("Error: {}", e.0);
        std::process::exit(1);
    }
}
