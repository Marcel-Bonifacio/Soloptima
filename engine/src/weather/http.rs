//! URL fetching behind a small trait so weather services run offline in tests (`MockHttp`) and on the network in the app
//! (`UreqHttp`). Mirrors `http_get` of src/weather.cpp: 120 s limit, 64 MB max, gzip, redirects but never https to http, non-2xx
//! turned into the service's message.
use crate::json::{Error, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

pub const USER_AGENT: &str = "Soloptima/1.0";
const MAX_DOWNLOAD: u64 = 64 * 1024 * 1024;

pub trait Http: Send + Sync {
    fn get(&self, url: &str, user_agent: &str) -> Result<String, Error>;
}

/// The message of a failed request: the service's own "message" member, else the start of the body
pub fn http_error(status: u16, body: &str) -> String {
    let mut cut = body.len().min(300);
    while !body.is_char_boundary(cut) { cut -= 1; }
    let mut msg = body[..cut].to_string();
    if let Ok(e) = Value::parse(body) { if e.has("message") { msg = e.at("message").str().to_string(); } }
    format!("Data service returned HTTP {status}: {msg}")
}

pub struct UreqHttp {
    agent: ureq::Agent,
}

impl Default for UreqHttp {
    fn default() -> Self {
        UreqHttp { agent: ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(120)).build() }
    }
}

impl Http for UreqHttp {
    fn get(&self, url: &str, user_agent: &str) -> Result<String, Error> {
        let secure = url.starts_with("https://");
        let mut url = url.to_string();
        for _ in 0..10 {
            let res = match self.agent.get(&url).set("User-Agent", user_agent).call() {
                Ok(r) => r,
                Err(ureq::Error::Status(code, r)) => {
                    let body = r.into_string().unwrap_or_default();
                    return Err(Error(http_error(code, &body)));
                }
                Err(e) => return Err(Error(format!("Download failed: {e}"))),
            };
            let status = res.status();
            if (300..400).contains(&status) {
                let Some(loc) = res.header("Location") else { return Err(Error(http_error(status, ""))) };
                let next = url::Url::parse(&url).and_then(|b| b.join(loc)).map_err(|e| Error(format!("Download failed: bad redirect ({e}).")))?;
                if secure && next.scheme() != "https" { return Err(Error("Download failed: a redirect to plain http was refused.".into())); }
                url = next.to_string();
                continue;
            }
            let mut body = Vec::new();
            res.into_reader().take(MAX_DOWNLOAD + 1).read_to_end(&mut body).map_err(|e| Error(format!("Download failed: {e}")))?;
            if body.len() as u64 > MAX_DOWNLOAD {
                return Err(Error(format!("Download failed: the response is larger than {} MB.", MAX_DOWNLOAD >> 20)));
            }
            return Ok(String::from_utf8_lossy(&body).into_owned());
        }
        Err(Error("Download failed: too many redirects.".into()))
    }
}

/// Saved responses by URL; a URL without one answers with an error. Counts the requests.
#[derive(Default)]
pub struct MockHttp {
    pub responses: Mutex<BTreeMap<String, Result<String, String>>>,
    pub requests: Mutex<Vec<(String, String)>>,
}

impl MockHttp {
    pub fn ok(&self, url: &str, body: impl Into<String>) { self.responses.lock().unwrap().insert(url.to_string(), Ok(body.into())); }
    pub fn fail(&self, url: &str, msg: &str) { self.responses.lock().unwrap().insert(url.to_string(), Err(msg.to_string())); }
    pub fn urls(&self) -> Vec<String> { self.requests.lock().unwrap().iter().map(|r| r.0.clone()).collect() }
}

impl Http for MockHttp {
    fn get(&self, url: &str, user_agent: &str) -> Result<String, Error> {
        self.requests.lock().unwrap().push((url.to_string(), user_agent.to_string()));
        match self.responses.lock().unwrap().get(url) {
            Some(Ok(b)) => Ok(b.clone()),
            Some(Err(m)) => Err(Error(m.clone())),
            None => Err(Error(format!("Download failed: no saved response for {url}"))),
        }
    }
}
