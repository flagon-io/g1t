//! Validity checks: asking a secret's issuer whether it still works, so an
//! alert can say active or inactive.
//!
//! A check is made only where the issuer has an endpoint that answers
//! "who is this?" without changing anything, and only over HTTPS to the
//! issuer's own API: the secret goes nowhere it was not already meant to
//! go. Formats with no such endpoint, or whose check needs more than the
//! value found (an AWS access key needs its secret key to sign a request),
//! are [`Validity::Unsupported`]; [`check_for`] is where a new one is added.

use serde::{Deserialize, Serialize};

use crate::secrets::SecretKind;

/// What the issuer said.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Validity {
    /// The issuer accepted it: it works and must be rotated.
    Active,
    /// The issuer refused it: revoked, expired or never real.
    Inactive,
    /// The issuer could not say (an error, a rate limit), or it was not
    /// checked.
    Unknown,
    /// There is no safe way to check this kind of secret.
    Unsupported,
}

impl Validity {
    pub fn as_str(self) -> &'static str {
        match self {
            Validity::Active => "active",
            Validity::Inactive => "inactive",
            Validity::Unknown => "unknown",
            Validity::Unsupported => "unsupported",
        }
    }

    pub fn parse(text: &str) -> Validity {
        match text {
            "active" => Validity::Active,
            "inactive" => Validity::Inactive,
            "unsupported" => Validity::Unsupported,
            _ => Validity::Unknown,
        }
    }
}

/// A request that asks the issuer about a secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Probe {
    pub method: &'static str,
    pub url: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<String>,
    /// How to read the answer.
    pub reader: Reader,
}

/// How an issuer's answer says active or inactive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reader {
    /// 2xx is active; 401 (and 403, for these issuers a refused key) inactive.
    Status,
    /// Slack answers 200 either way, with `"ok": true` or an error code.
    SlackOk,
}

/// The kinds a check exists for, as the docs list them.
pub const SUPPORTED: [SecretKind; 8] = [
    SecretKind::GithubToken,
    SecretKind::GitlabToken,
    SecretKind::StripeLiveKey,
    SecretKind::SlackToken,
    SecretKind::NpmToken,
    SecretKind::OpenaiKey,
    SecretKind::AnthropicKey,
    SecretKind::SendgridKey,
];

/// The request that checks `value`, a secret of `kind`, or `None` when
/// there is no safe check for it.
pub fn check_for(kind: SecretKind, value: &str) -> Option<Probe> {
    let bearer = || vec![("authorization", format!("Bearer {value}"))];
    let status = |method, url, headers| Some(Probe { method, url, headers, body: None, reader: Reader::Status });
    match kind {
        // Who the token belongs to; any token, any scope, can ask.
        SecretKind::GithubToken => status("GET", "https://api.github.com/user", {
            let mut headers = bearer();
            headers.push(("accept", "application/vnd.github+json".to_owned()));
            headers
        }),
        SecretKind::GitlabToken if value.starts_with("glpat-") => {
            status("GET", "https://gitlab.com/api/v4/personal_access_tokens/self", vec![("private-token", value.to_owned())])
        }
        // The account's balance: read-only, and readable by restricted keys
        // that are allowed to (a restricted key without it answers 403,
        // which still means the key exists).
        SecretKind::StripeLiveKey => status("GET", "https://api.stripe.com/v1/balance", bearer()),
        SecretKind::SlackToken => Some(Probe {
            method: "POST",
            url: "https://slack.com/api/auth.test",
            headers: bearer(),
            body: None,
            reader: Reader::SlackOk,
        }),
        SecretKind::NpmToken => status("GET", "https://registry.npmjs.org/-/whoami", bearer()),
        SecretKind::OpenaiKey => status("GET", "https://api.openai.com/v1/models", bearer()),
        SecretKind::AnthropicKey => status("GET", "https://api.anthropic.com/v1/models", vec![
            ("x-api-key", value.to_owned()),
            ("anthropic-version", "2023-06-01".to_owned()),
        ]),
        SecretKind::SendgridKey => status("GET", "https://api.sendgrid.com/v3/scopes", bearer()),
        // An access key alone cannot sign a request; its secret key is
        // usually elsewhere. Webhook addresses would post a message. The
        // rest have no read-only identity endpoint.
        _ => None,
    }
}

/// What the issuer's answer means.
pub fn read(reader: Reader, kind: SecretKind, status: u16, body: &str) -> Validity {
    match reader {
        Reader::Status => match status {
            200..=299 => Validity::Active,
            // Stripe: a restricted key without balance access is real.
            403 if kind == SecretKind::StripeLiveKey => Validity::Active,
            401 | 403 => Validity::Inactive,
            _ => Validity::Unknown,
        },
        Reader::SlackOk => {
            let answer: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            match (status, answer["ok"].as_bool(), answer["error"].as_str()) {
                (200, Some(true), _) => Validity::Active,
                (200, Some(false), Some("invalid_auth" | "token_revoked" | "account_inactive" | "token_expired" | "not_authed")) => {
                    Validity::Inactive
                }
                _ => Validity::Unknown,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_go_to_the_issuers_own_api_over_https() {
        for kind in SUPPORTED {
            let probe = check_for(kind, "glpat-value").unwrap_or_else(|| panic!("{kind:?} has a check"));
            assert!(probe.url.starts_with("https://"), "{}", probe.url);
        }
        let github = check_for(SecretKind::GithubToken, "ghp_x").unwrap();
        assert_eq!((github.method, github.url), ("GET", "https://api.github.com/user"));
        assert!(github.headers.contains(&("authorization", "Bearer ghp_x".to_owned())));
        // No check that could not be made safely.
        assert!(check_for(SecretKind::AwsAccessKey, "AKIA…").is_none());
        assert!(check_for(SecretKind::SlackWebhook, "https://hooks.slack.com/…").is_none());
        assert!(check_for(SecretKind::PrivateKey, "-----BEGIN").is_none());
        assert!(check_for(SecretKind::GitlabToken, "glrt-runner").is_none());
    }

    #[test]
    fn answers_are_read_as_active_inactive_or_unknown() {
        assert_eq!(read(Reader::Status, SecretKind::GithubToken, 200, ""), Validity::Active);
        assert_eq!(read(Reader::Status, SecretKind::GithubToken, 401, ""), Validity::Inactive);
        assert_eq!(read(Reader::Status, SecretKind::StripeLiveKey, 403, ""), Validity::Active);
        assert_eq!(read(Reader::Status, SecretKind::OpenaiKey, 429, ""), Validity::Unknown);
        assert_eq!(read(Reader::SlackOk, SecretKind::SlackToken, 200, r#"{"ok":true,"team":"x"}"#), Validity::Active);
        assert_eq!(read(Reader::SlackOk, SecretKind::SlackToken, 200, r#"{"ok":false,"error":"token_revoked"}"#), Validity::Inactive);
        assert_eq!(read(Reader::SlackOk, SecretKind::SlackToken, 200, r#"{"ok":false,"error":"ratelimited"}"#), Validity::Unknown);
        assert_eq!(Validity::parse(Validity::Inactive.as_str()), Validity::Inactive);
    }
}
