//! Long runs (optimisation, multi-year weather) work in a thread of their own; the interface polls `job` for progress and may
//! cancel. At most 8 jobs are kept: a ninth cancels and drops the oldest.
use crate::json::{Error, Value};
use crate::optimizer::Progress;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Job {
    prog: Progress,
    /// Some once finished: the answer as JSON text, or the error message; with the time it finished
    end: Mutex<Option<(Result<String, String>, Instant)>>,
}

#[derive(Default)]
pub struct Jobs {
    inner: Mutex<(i64, BTreeMap<i64, Arc<Job>>)>,
}

thread_local!(static PANIC_AT: RefCell<String> = const { RefCell::new(String::new()) });
/// The last panic's source line on any thread: a panic in a rayon worker is caught on the caller's thread
static LAST_PANIC_AT: Mutex<String> = Mutex::new(String::new());

/// Remembers the source line of each panic on the thread that panicked, so a defect reported to the interface names it
/// (panic_message). The previous hook still runs. Installed by Engine::new.
pub fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Some(l) = info.location() {
                let at = format!("{}:{}", l.file(), l.line());
                if let Ok(mut g) = LAST_PANIC_AT.lock() { g.clone_from(&at); }
                PANIC_AT.with(|p| *p.borrow_mut() = at);
            }
            prev(info);
        }));
    });
}

/// The message of a panic payload, with the source line when the panic hook saw it. Call it on the thread that panicked.
pub fn panic_message(e: &(dyn std::any::Any + Send)) -> String {
    let msg = e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_else(|| "Unknown error".into());
    let last = LAST_PANIC_AT.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default();
    let at = PANIC_AT.with(|p| std::mem::take(&mut *p.borrow_mut()));
    let at = if at.is_empty() { last } else { at };
    if at.is_empty() { msg } else { format!("{msg} (at {at})") }
}

impl Jobs {
    /// Starts `f` in a thread of its own; answers {"job": id} at once
    pub fn start(&self, f: impl FnOnce(&Progress) -> Result<Value, Error> + Send + 'static) -> String {
        let job = Arc::new(Job::default());
        let id = {
            let mut g = self.inner.lock().unwrap();
            g.0 += 1;
            let id = g.0;
            g.1.insert(id, job.clone());
            while g.1.len() > 8 {
                let (_, old) = g.1.pop_first().unwrap();
                old.prog.cancel.store(true, Relaxed);
            }
            id
        };
        std::thread::spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&job.prog)));
            let r = match r {
                Ok(Ok(v)) => Ok(v.dump()),
                Ok(Err(e)) => Err(e.0),
                Err(p) => Err(panic_message(p.as_ref())),
            };
            *job.end.lock().unwrap() = Some((r, Instant::now()));
        });
        let mut o = Value::object();
        o.set("job", id as f64);
        o.dump()
    }

    /// {done: false, progress, total}, {done: true, result} or {done: true, error}
    pub fn status(&self, id: &str) -> Result<String, Error> {
        let job = self.inner.lock().unwrap().1.get(&i64::from(crate::storage::atoi(id))).cloned();
        let Some(job) = job else { return Err(Error("No such job.".into())) };
        let end = job.end.lock().unwrap();
        let mut o = Value::object();
        o.set("done", end.is_some());
        match &*end {
            None => {
                o.set("progress", job.prog.done.load(Relaxed) as f64);
                o.set("total", job.prog.total.load(Relaxed) as f64);
            }
            Some((Err(e), _)) => o.set("error", e.as_str()),
            Some((Ok(r), _)) => return Ok(format!("{{\"done\":true,\"result\":{r}}}")),
        }
        Ok(o.dump())
    }

    pub fn cancel(&self, id: &str) {
        if let Some(j) = self.inner.lock().unwrap().1.get(&i64::from(crate::storage::atoi(id))) { j.prog.cancel.store(true, Relaxed); }
    }

    /// Drops the results of runs finished over 30 s ago; returns how many
    pub fn clear_finished(&self) -> usize {
        let mut g = self.inner.lock().unwrap();
        let before = g.1.len();
        let cut = Duration::from_secs(30);
        g.1.retain(|_, j| !matches!(&*j.end.lock().unwrap(), Some((_, t)) if t.elapsed() > cut));
        before - g.1.len()
    }
}

#[cfg(test)]
mod panic_tests {
    use super::*;

    #[test]
    fn a_panic_message_names_its_source_line() {
        install_panic_hook();
        let p = std::thread::spawn(|| std::panic::catch_unwind(|| -> () { panic!("boom") }).map_err(|p| panic_message(p.as_ref())))
            .join()
            .unwrap();
        let msg = p.unwrap_err();
        assert!(msg.starts_with("boom (at ") && msg.contains("jobs.rs:"), "{msg}");
    }
}
