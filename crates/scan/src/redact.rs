//! Hiding credentials in text people and agents write about their work: a
//! session's prompts, tool calls and messages, its title and what it
//! reported. Unlike [`crate::secrets`], which must be sure before it stops
//! a push, this errs the other way: a word too many hidden costs nothing,
//! a key shown on a public page costs the key.
//!
//! [`redact`] replaces what looks like a credential with [`REDACTED`]:
//! every format [`crate::secrets`] knows, prefixed tokens of any length,
//! `NAME_TOKEN=value` and `password: value`, credential flags, bearer
//! headers, a URL's user and password and its signed query parameters,
//! JWTs, PEM private keys, and long random-looking strings. [`soften`]
//! takes swearing out of a title, so that how someone spoke to their own
//! agent is not what their team reads.

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// What a credential is replaced with.
pub const REDACTED: &str = "[redacted]";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a redaction pattern")
}

/// A key or token by its issuer's prefix: `ghp_…`, `sk-ant-…`, `g1t_…`.
static PREFIXED: LazyLock<Regex> = LazyLock::new(|| {
    re(r"\b(g1t|ghp|gho|ghu|ghs|ghr|github_pat|glpat|gloas|glrt|glptt|gldt|xox[abeprs]|sk-ant|sk-proj|sk-svcacct|sk-admin|sk|rk|whsec|npm|hf|pypi|dop_v1|shpat|shpss|sntrys|lin_api|figd)([-_])([A-Za-z0-9_-]{12,})")
});

/// `AKIA…`, `AIza…`, `SG.….…`: formats whose prefix needs no separator.
static BARE: LazyLock<Regex> =
    LazyLock::new(|| re(r"\b(?:(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b"));

/// `Authorization: Bearer …`, `Proxy-Authorization: Basic …`.
static AUTH_HEADER: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b((?:proxy-)?authorization\s*[:=]\s*(?:(?:bearer|basic|token|bot|digest)\s+)?)[^\s\x22'`,;]+"));

/// `Bearer …` anywhere else.
static BEARER: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"));

/// `G1T_TOKEN=…`, `$env:API_KEY='…'`, `"password": "…"`, `client_secret: …`.
static ASSIGNED: LazyLock<Regex> = LazyLock::new(|| {
    re(r#"(?i)([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?key|signing[_-]?key|session[_-]?key|credentials?|webhook[_-]?url|dsn|connection[_-]?string)["']?\s*(?:=|:)\s*)("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s,;&)}\]]+)"#)
});

/// `--token abc`, `--password=abc`, `--api-key abc`.
static FLAG: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)(--(?:token|password|passwd|secret|api-key|apikey|access-token|auth-token|client-secret|private-key)(?:=|\s+))(\x22[^\x22]*\x22|'[^']*'|\S+)")
});

/// `curl -u name:password`.
static USER_FLAG: LazyLock<Regex> = LazyLock::new(|| re(r"((?:^|\s)(?:-u|--user)\s+[^\s:]+:)\S+"));

/// `https://name:password@host`.
static USERINFO: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/:@]+:[^\s/@]+@"));

/// `?token=…`, `&X-Amz-Signature=…`.
static QUERY: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)([?&](?:access_token|refresh_token|id_token|token|key|api_key|apikey|secret|client_secret|sig|signature|password|code|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s#\x22'`]+")
});

/// A JSON Web Token.
static JWT: LazyLock<Regex> = LazyLock::new(|| re(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"));

/// A PEM private key, to its end or to the end of the text.
static PEM: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)"));

/// A long run that may be random: judged by [`random_looking`]. A `/`
/// ends a run, so a path is judged a folder at a time: joined, its names
/// read as one random string (`AppData/Local/Temp/claude/c--Users-…`).
static LONG: LazyLock<Regex> = LazyLock::new(|| re(r"[A-Za-z0-9+_=-]{32,}"));

/// A value that names a secret rather than holding one: `$TOKEN`,
/// `${{ secrets.X }}`, `process.env.X`, or one already hidden.
fn reference(value: &str) -> bool {
    let value = value.trim_matches(['"', '\'', '`']);
    value.is_empty()
        || value.starts_with('$')
        || value.starts_with('%')
        || value.starts_with('<')
        || value.contains("secrets.")
        || value.contains("env.")
        || value.contains("[redacted")
        || value == "…"
}

/// `secret: the` in a sentence: after a colon, an unquoted plain word
/// short of a password's length is the sentence going on, not a value.
/// `password: hunter2!` (a digit, a symbol) and a long run still count;
/// after `=` everything does.
fn prose(head: &str, value: &str) -> bool {
    head.trim_end().ends_with(':')
        && !value.starts_with(['"', '\'', '`'])
        && value.chars().count() < 16
        && value.chars().all(|c| c.is_alphabetic() || matches!(c, '\'' | '’' | '-'))
}

fn shannon(text: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    for c in text.chars() {
        *counts.entry(c).or_insert(0usize) += 1;
    }
    let length = text.chars().count() as f64;
    counts
        .values()
        .map(|count| {
            let p = *count as f64 / length;
            -p * p.log2()
        })
        .sum()
}

/// Upper case, lower case and digits mixed with the spread of a random
/// string: a key with no prefix. A commit (lowercase hex), a path, a
/// CamelCase name or a word run together does not look like this.
fn random_looking(run: &str) -> bool {
    let digits = run.chars().filter(char::is_ascii_digit).count();
    run.chars().any(|c| c.is_ascii_uppercase())
        && run.chars().any(|c| c.is_ascii_lowercase())
        && digits >= 3
        && !run.contains("//")
        && shannon(run) >= 4.3
}

fn has_letter_and_digit(body: &str) -> bool {
    body.chars().any(|c| c.is_ascii_alphabetic()) && body.chars().any(|c| c.is_ascii_digit())
}

/// `text` with what looks like a credential replaced by [`REDACTED`].
pub fn redact(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    // Exact formats first, whatever surrounds them.
    let mut out = text.to_owned();
    let mut values: Vec<String> = crate::secrets::scan_text(text).into_iter().map(|hit| hit.value).collect();
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    for value in values {
        // A private key's value is its header and the start of its body.
        let value = value.split('\n').next_back().unwrap_or(&value).to_owned();
        if value.len() >= 8 {
            out = out.replace(&value, REDACTED);
        }
    }
    let out = PEM.replace_all(&out, REDACTED);
    let out = JWT.replace_all(&out, REDACTED);
    let out = PREFIXED.replace_all(&out, |c: &Captures| {
        if has_letter_and_digit(&c[3]) { format!("{}{}{REDACTED}", &c[1], &c[2]) } else { c[0].to_owned() }
    });
    let out = BARE.replace_all(&out, REDACTED);
    let out = AUTH_HEADER.replace_all(&out, |c: &Captures| {
        let value = &c[0][c[1].len()..];
        if reference(value) { c[0].to_owned() } else { format!("{}{REDACTED}", &c[1]) }
    });
    let out = BEARER.replace_all(&out, |c: &Captures| {
        let value = &c[0][c[1].len()..];
        if reference(value) { c[0].to_owned() } else { format!("{}{REDACTED}", &c[1]) }
    });
    let out = USERINFO.replace_all(&out, format!("${{1}}{REDACTED}@").as_str());
    let out = QUERY.replace_all(&out, format!("${{1}}{REDACTED}").as_str());
    let out = FLAG.replace_all(&out, |c: &Captures| {
        if reference(&c[2]) { c[0].to_owned() } else { format!("{}{REDACTED}", &c[1]) }
    });
    let out = USER_FLAG.replace_all(&out, format!("${{1}}{REDACTED}").as_str());
    let out = ASSIGNED.replace_all(&out, |c: &Captures| {
        let value = &c[2];
        // `token: string` in code is a type, not a token.
        let typed = matches!(value, "string" | "String" | "str" | "&str" | "number" | "bool" | "boolean" | "null" | "None" | "undefined" | "true" | "false" | "Option<String>");
        if reference(value) || typed || prose(&c[1], value) { c[0].to_owned() } else { format!("{}{REDACTED}", &c[1]) }
    });
    let out = LONG.replace_all(&out, |c: &Captures| {
        if random_looking(&c[0]) { REDACTED.to_owned() } else { c[0].to_owned() }
    });
    out.into_owned()
}

/// Words that say how someone felt, not what they asked for.
const SWEARING: &[&str] = &[
    "fuck", "fucking", "fucked", "fucker", "fuckin", "motherfucker", "motherfucking", "shit", "shitty", "bullshit", "horseshit",
    "damn", "damned", "dammit", "damnit", "goddamn", "goddamned", "goddammit", "wtf", "wth", "ffs", "stfu", "omfg", "asshole",
    "bitch", "bitching", "crap", "crappy", "idiot", "idiotic", "moron", "moronic", "dumbass", "retard", "retarded", "bastard",
    "pissed", "jfc", "fml",
];

fn swearing(word: &str) -> bool {
    let bare: String = word.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    !bare.is_empty() && (SWEARING.contains(&bare.as_str()) || bare.starts_with("fuck") || bare.starts_with("shit"))
}

/// A title as the team reads it: credentials hidden and swearing left out.
/// Empty when nothing else was said.
pub fn soften(title: &str) -> String {
    let redacted = redact(title);
    let mut words: Vec<&str> = Vec::new();
    for word in redacted.split_whitespace() {
        if swearing(word) {
            // Its punctuation stays with the sentence: "this, fucking thing" reads "this, thing".
            continue;
        }
        words.push(word);
    }
    let text = words.join(" ");
    let text = text.trim_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | ':' | '-'));
    let mut chars = text.chars();
    match chars.next() {
        // A title that lost its first word still starts as a sentence.
        Some(first) if words.len() < redacted.split_whitespace().count() => first.to_uppercase().chain(chars).collect(),
        Some(_) => text.to_owned(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hidden(text: &str, secret: &str) {
        let out = redact(text);
        assert!(!out.contains(secret), "{secret} shows in {out}");
        assert!(out.contains(REDACTED), "nothing hidden in {out}");
    }

    #[test]
    fn tokens_by_their_prefix() {
        hidden("source ~/.bashrc; curl -H 'x' g1t_0123456789abcdef0123456789abcdef01234567", "0123456789abcdef0123");
        hidden("use ghp_A1b2C3d4E5f6G7h8I9j0 please", "A1b2C3d4E5f6G7h8I9j0");
        hidden("key sk-ant-api03-abcDEF123456ghiJKL", "abcDEF123456ghiJKL");
        hidden("whsec_1234567890abcdefXYZ", "1234567890abcdefXYZ");
        hidden("AKIAIOSFODNN7EXAMPLE was it", "IOSFODNN7EXAMPLE");
        // Names that only share a prefix are left alone.
        assert_eq!(redact("npm_config_user_agent is set"), "npm_config_user_agent is set");
        assert_eq!(redact("sk-learn-classifier"), "sk-learn-classifier");
    }

    #[test]
    fn assignments_flags_and_headers() {
        hidden("G1T_TOKEN=abc123def456 g1t whoami", "abc123def456");
        hidden("$env:G1T_TOKEN='abc123def456'; g1t whoami", "abc123def456");
        hidden(r#"{"password": "hunter2!"}"#, "hunter2");
        hidden("client_secret: s3cr3tvalue", "s3cr3tvalue");
        hidden("DATABASE_PASSWORD=\"correct horse\"", "correct horse");
        hidden("g1t auth login --token abc123", "abc123");
        hidden("x --password=pa55", "pa55");
        hidden("curl -u admin:pa55word https://x", "pa55word");
        hidden(r#"curl -H "Authorization: Bearer abc.def-123" https://api"#, "abc.def-123");
        hidden("Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz");
        hidden("send it with bearer abcdefgh12345678", "abcdefgh12345678");
        hidden("X-Api-Key: 1234abcd5678", "1234abcd5678");
    }

    #[test]
    fn a_sentence_after_a_colon_is_not_a_value() {
        for ordinary in [
            "A path is not a secret: the redactor's rule read it as one",
            "The API key: what it is and where to keep it",
            "password: the one you set at sign-up",
        ] {
            assert_eq!(redact(ordinary), ordinary);
        }
        hidden("password: hunter2", "hunter2");
        hidden("db_password: correcthorsebatterystaple", "correcthorsebatterystaple");
        hidden("api_key: 'plainword'", "plainword");
        hidden("SECRET=plainword", "plainword");
    }

    #[test]
    fn references_and_types_are_not_secrets() {
        let line = "TOKEN=$G1T_TOKEN; token: ${{ secrets.DEPLOY }}; password: process.env.PW; fn f(token: String)";
        assert_eq!(redact(line), line);
        assert_eq!(redact(r#"-H "Authorization: Bearer …""#), r#"-H "Authorization: Bearer …""#);
    }

    #[test]
    fn urls_jwts_and_keys() {
        hidden("git clone https://x-access-token:abc123@g1t.sh/a/b", "abc123");
        hidden("postgres://app:pa55@db:5432/app", "pa55");
        hidden("open https://x.com/cb?code=abc&state=1&token=t0k3n", "t0k3n");
        hidden("GET /file?X-Amz-Signature=deadbeef1234&x=1", "deadbeef1234");
        hidden("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3");
        let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\nafter"; // g1t:allow-secret
        let out = redact(pem);
        assert!(!out.contains("b3BlbnNzaC1"), "{out}");
        assert!(out.ends_with("after"));
        hidden("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn", "MIIEpAIBAAKCAQEA"); // g1t:allow-secret
    }

    #[test]
    fn random_strings_go_and_ordinary_ones_stay() {
        hidden("the key is Xk9fQ2mZr7Lp4Wv8Ty3Nb6Hc1Jd5Ge0S", "Xk9fQ2mZr7Lp4Wv8Ty3Nb6Hc1Jd5Ge0S");
        for ordinary in [
            "git show 58def4040e93a1dcda5f388f55360f3cd46cd97e",
            "services/work/src/coordination/sessions.rs",
            r#"cat "C:/Users/syntaqx/AppData/Local/Temp/claude/c--Users-syntaqx-Code-syntaqx-g1t/3fcf65eb-fb45-440a-81ed-c3586c68531a/tasks/bzf08tti3.output""#,
            "CoordinationOp::StartAgentSession and ListWorkSessionsArgs",
            "MSYS_NO_PATHCONV=1 git show origin/40-g1t_upkeep:.g1t/upkeep.yml",
            "Fix the merge queue: it re-tests every pull request after a push",
        ] {
            assert_eq!(redact(ordinary), ordinary);
        }
    }

    #[test]
    fn swearing_is_left_out_of_titles() {
        assert_eq!(soften("Fix this fucking bug"), "Fix this bug");
        assert_eq!(soften("wtf, why is the PR page slow"), "Why is the PR page slow");
        assert_eq!(soften("Make the shitty button work"), "Make the button work");
        assert_eq!(soften("fuck"), "");
        assert_eq!(soften("Shell scripts and hello world"), "Shell scripts and hello world");
        assert_eq!(soften("Rotate G1T_TOKEN=abc123def456 now"), format!("Rotate G1T_TOKEN={REDACTED} now"));
    }
}
