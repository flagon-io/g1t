//! Calling outside systems. Every answer comes back as a status and a body,
//! so each provider decides what a refusal means.

use serde_json::Value;
use worker::{Fetch, Headers, Method, Request, RequestInit, Result};

pub struct Answer {
    pub status: u16,
    pub body: String,
}

impl Answer {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }

    /// What went wrong, briefly, for a person to read.
    pub fn problem(&self, system: &str) -> String {
        let said = self.json();
        let message = said["message"]
            .as_str()
            .or_else(|| said["detail"].as_str())
            .or_else(|| said["error"]["message"].as_str())
            .or_else(|| said["errorMessages"][0].as_str())
            .or_else(|| said["errors"][0]["message"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| self.body.chars().take(200).collect());
        match self.status {
            401 => format!("{system} did not accept the credentials ({message})."),
            403 => format!("{system} refused: the credentials cannot do this ({message})."),
            404 => format!("{system} has nothing there ({message})."),
            status => format!("{system} answered {status}: {message}"),
        }
    }
}

pub async fn send(method: Method, url: &str, headers: &[(&str, &str)], body: Option<String>) -> Result<Answer> {
    let sent = Headers::new();
    sent.set("user-agent", "g1t (+https://g1t.sh)")?;
    sent.set("accept", "application/json")?;
    for (name, value) in headers {
        sent.set(name, value)?;
    }
    if body.is_some() && !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-type")) {
        sent.set("content-type", "application/json")?;
    }
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(sent);
    if let Some(body) = body {
        init.with_body(Some(body.into()));
    }
    let mut response = Fetch::Request(Request::new_with_init(url, &init)?).send().await?;
    Ok(Answer {
        status: response.status_code(),
        body: response.text().await.unwrap_or_default(),
    })
}

/// `text`, cut to `max` characters at a line break where one is near.
pub fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let cut: String = text.chars().take(max).collect();
    let at = cut.rfind('\n').filter(|at| *at > max / 2).unwrap_or(cut.len());
    format!("{}\n\n…", cut[..at].trim_end())
}
