//! The command line of the engine (the desktop app is src-tauri):
//!   soloptima simulate project.json [out.json]   headless single simulation
//!   soloptima optimize project.json [out.json]   headless sizing (uses the project's "optimizer" block)
//! The answer is the JSON of the app's simulate and optimize commands; without out.json it goes to standard output.
use soloptima_engine::api::run_simulation;
use soloptima_engine::optimizer::{optimize, parse_opt_settings, Progress};
use soloptima_engine::{parse_project, validate_project, Error, Value};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::time::{Duration, Instant};

fn write_out(path: Option<&String>, v: &Value) -> Result<(), Error> {
    match path {
        None => {
            let mut o = std::io::stdout().lock();
            o.write_all(v.dump().as_bytes()).and_then(|_| o.write_all(b"\n")).map_err(|e| Error(format!("Cannot write the answer: {e}")))
        }
        Some(p) => {
            std::fs::write(p, v.dump()).map_err(|_| Error(format!("Cannot write {p}")))?;
            eprintln!("Wrote {p}");
            Ok(())
        }
    }
}

fn run(cmd: &str, args: &[String]) -> Result<(), Error> {
    let text = std::fs::read_to_string(&args[0]).map_err(|_| Error(format!("Cannot open {}", args[0])))?;
    let v = Value::parse(&text)?;
    let p = parse_project(&v);
    if cmd == "simulate" { return write_out(args.get(1), &run_simulation(&p, &v)?); }
    validate_project(&p)?;
    let o = parse_opt_settings(v.at("optimizer"), &p)?;
    let prog = Progress::default();
    let fin = AtomicBool::new(false);
    let t0 = Instant::now();
    let res = std::thread::scope(|s| {
        s.spawn(|| {
            while !fin.load(Relaxed) {
                eprint!("\r  {} / {} simulations", prog.done.load(Relaxed), prog.total.load(Relaxed));
                std::thread::sleep(Duration::from_millis(500));
            }
        });
        let r = optimize(&p, &o, &prog);
        fin.store(true, Relaxed);
        r
    })?;
    eprintln!("\r  {} simulations in {:.1} s", prog.done.load(Relaxed), t0.elapsed().as_secs_f64());
    write_out(args.get(1), &res)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    if !matches!(cmd, "simulate" | "optimize") || args.len() < 2 {
        eprintln!("usage: soloptima simulate project.json [out.json] | optimize project.json [out.json]\nThe desktop app is the Soloptima shell (src-tauri).");
        std::process::exit(2);
    }
    if let Err(e) = run(cmd, &args[1..]) {
        eprintln!("Error: {}", e.0);
        std::process::exit(1);
    }
}
