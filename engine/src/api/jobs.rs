//! Long runs (optimisation, multi-year weather) work in a thread of their own; the interface polls `job` for progress and may
//! cancel. At most 8 jobs are kept: a ninth cancels and drops the oldest.
use crate::json::{Error, Value};
use crate::optimizer::Progress;
use std::collections::BTreeMap;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::{Arc, Mutex};
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

/// The message of a panic payload
pub fn panic_message(e: &(dyn std::any::Any + Send)) -> String {
    e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_else(|| "Unknown error".into())
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
