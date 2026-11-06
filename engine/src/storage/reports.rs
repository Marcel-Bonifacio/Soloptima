//! Bug and feedback reports: one JSON file and one Markdown copy per report, an index, ids SOL-0001 to SOL-999999 never reused
//! (src/storage.cpp).
use super::files::*;
use super::{fail, ls, now_iso, Storage, R};
use crate::json::Value;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

static REPORTS: Mutex<()> = Mutex::new(());   // id allocation, revisions and the index are shared by concurrent requests

// Labels as in web/js/reports.js
const KINDS: [(&str, &str); 4] = [("bug", "Bug"), ("error", "Error (captured)"), ("feedback", "Feedback"), ("feature", "Feature request")];
const STATUSES: [(&str, &str); 7] = [("new", "New"), ("confirmed", "Confirmed"), ("in_progress", "In progress"), ("fixed", "Fixed"), ("closed", "Closed"),
    ("wont_fix", "Will not fix"), ("duplicate", "Duplicate")];
const SEVERITIES: [(&str, &str); 4] = [("low", "Low"), ("medium", "Medium"), ("high", "High"), ("critical", "Critical")];

fn label(m: &[(&str, &str)], k: &str) -> String { m.iter().find(|x| x.0 == k).map_or(k.to_string(), |x| x.1.to_string()) }
fn known(m: &[(&str, &str)], k: &str) -> bool { m.iter().any(|x| x.0 == k) }

/// SOL-0001 ... SOL-999999
fn valid_report_id(s: &str) -> bool { s.len() >= 8 && s.len() <= 10 && s.starts_with("SOL-") && s.bytes().skip(4).all(|c| c.is_ascii_digit()) }

/// One Markdown table cell: no line breaks or pipes, at most 90 characters
fn cell(s: &str) -> String {
    let t: String = s.chars().map(|c| if matches!(c, '\n' | '\r' | '|') { ' ' } else { c }).collect();
    if utf8_prefix(&t, 90) == t { t } else { format!("{}...", utf8_prefix(&t, 87)) }
}

/// Highest report number on disk or ever issued (reports/.last-id), so deleted numbers are not reused
fn last_report_number(d: &Path) -> R<i32> {
    let mut n = read_text(&d.join(".last-id")).map_or(0, |t| atoi(&t));
    if d.exists() {
        for e in ls(d)? {
            let p = e.path();
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if p.extension().is_some_and(|x| x == "json") && valid_report_id(&stem) { n = n.max(atoi(&stem[4..])); }
        }
    }
    Ok(n)
}

impl Storage {
    pub fn list_reports(&self) -> R<Value> {
        let d = self.reports_dir()?;
        let mut v: Vec<Value> = Vec::new();
        if d.exists() {
            for e in ls(&d)? {
                let p = e.path();
                let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                if !p.extension().is_some_and(|x| x == "json") || !valid_report_id(&stem) { continue; }
                let Ok(text) = read_text(&p) else { continue };
                let Ok(r) = Value::parse(&text) else { continue };
                let mut s = Value::object();   // summary for the list; the full report is loaded on demand
                for k in ["kind", "status", "severity", "title", "created", "updated", "count", "signature"] {
                    if r.has(k) { s.set(k, r.at(k).clone()); }
                }
                s.set("id", stem);
                v.push(s);
            }
        }
        v.sort_by(|a, b| b.gets("id", "").cmp(&a.gets("id", "")));
        Ok(Value::Arr(v))
    }

    /// The report as JSON text
    pub fn load_report(&self, id: &str) -> R<String> {
        if !valid_report_id(id) { return fail("Invalid report id."); }
        let mut r = Value::parse(&read_text(&self.reports_dir()?.join(format!("{id}.json")))?)?;
        r.set("id", id);
        Ok(r.dump())
    }

    /// Assigns an id to a new report; a save of an existing one must carry its current revision
    pub fn save_report(&self, report_in: &Value, markdown: &str) -> R<Value> {
        if !report_in.is_object() { return fail("A report must be a JSON object."); }
        if !known(&KINDS, &report_in.gets("kind", "")) || !known(&STATUSES, &report_in.gets("status", "")) || !known(&SEVERITIES, &report_in.gets("severity", "")) {
            return fail("A report needs a known kind, status and severity.");
        }
        let _g = REPORTS.lock().unwrap_or_else(|e| e.into_inner());
        let d = self.reports_dir()?;
        make_private_dirs(&d)?;
        let mut id = report_in.gets("id", "");
        let now = now_iso();
        let mut r = report_in.clone();
        if id.is_empty() {
            // a captured error that another tab filed a moment ago: hand back that report instead of a duplicate
            let sig = report_in.gets("signature", "");
            if !sig.is_empty() {
                let all = self.list_reports()?;
                for x in all.arr() {
                    if x.gets("signature", "") == sig {
                        let mut e = Value::parse(&self.load_report(&x.gets("id", ""))?)?;
                        e.set("existing", true);
                        return Ok(e);
                    }
                }
            }
            let n = last_report_number(&d)? + 1;
            id = format!("SOL-{n:04}");
            write_atomic(&d.join(".last-id"), &n.to_string())?;
            r.set("created", now.clone());
            r.set("revision", 1);
        } else {
            if !valid_report_id(&id) { return fail("Invalid report id."); }
            let Ok(old) = read_text(&d.join(format!("{id}.json"))).and_then(|t| Value::parse(&t)) else { return fail("This report was deleted.") };
            // optimistic concurrency: a save based on an older copy is refused, and the GUI reloads and reapplies its change
            let rev = old.get("revision", 0.0);
            if report_in.get("revision", 0.0) != rev { return fail("The report changed since it was opened."); }
            r.set("created", old.gets("created", &now));
            r.set("revision", rev + 1.0);
        }
        r.set("id", id.clone());
        r.set("updated", now);
        write_atomic(&d.join(format!("{id}.json")), &r.dump())?;
        // the Markdown copy names the report by its id; the client writes it with a placeholder until the id is known
        write_atomic(&d.join(format!("{id}.md")), &markdown.replace("{{id}}", &id))?;
        self.write_report_index()?;
        Ok(r)
    }

    pub fn delete_report(&self, id: &str) -> R<()> {
        if !valid_report_id(id) { return fail("Invalid report id."); }
        let _g = REPORTS.lock().unwrap_or_else(|e| e.into_inner());
        let d = self.reports_dir()?;
        for f in [format!("{id}.json"), format!("{id}.md")] {
            match fs::remove_file(d.join(f)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(fs_error(&e)),
            }
        }
        self.write_report_index()
    }

    /// README.md in the reports folder: every report, newest first
    fn write_report_index(&self) -> R<()> {
        let d = self.reports_dir()?;
        make_private_dirs(&d)?;
        let all = self.list_reports()?;
        let mut ix = String::from("# Soloptima bug and feedback reports\n\nOne file per report: `SOL-nnnn.md` (readable history) and `SOL-nnnn.json` (data).\n\n| Report | Kind | Status | Title | Created | Updated |\n|---|---|---|---|---|---|\n");
        let date = |s: String| String::from_utf8_lossy(&s.as_bytes()[..s.len().min(10)]).into_owned();
        for x in all.arr() {
            let id = x.gets("id", "");
            ix += &format!("| [{id}]({id}.md) | {} | {} | {} | {} | {} |\n", label(&KINDS, &x.gets("kind", "")), label(&STATUSES, &x.gets("status", "")),
                           cell(&x.gets("title", "")), date(x.gets("created", "")), date(x.gets("updated", "")));
        }
        write_atomic(&d.join("README.md"), &ix)
    }
}

