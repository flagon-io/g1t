//! Secrets that must never reach a repository: keys and tokens of the
//! formats their issuers made recognisable on purpose, and private keys.
//!
//! Each rule knows a format exactly (its prefix, its alphabet, its length),
//! so a match is almost always a real credential, or a fake made to look
//! like one. Fakes in tests and docs are still found, and [`test_value`]
//! says which look made up (a documented example key, a counting or
//! repeating value), so they are listed apart and never stop a push. A
//! person can also mark a line with [`ALLOW_MARKER`], or dismiss a finding
//! on the project's Security page. Guesswork from entropy alone is left out: it is
//! what makes scanners noisy, and noise is what makes people bypass them.

use sha2::{Digest, Sha256};

/// Written anywhere on a line, in a comment, says what is on it is not a
/// real secret: `const KEY = "AKIA…"; // g1t:allow-secret`.
pub const ALLOW_MARKER: &str = "g1t:allow-secret";

/// What a secret is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SecretKind {
    AwsAccessKey,
    AwsSecretKey,
    GithubToken,
    GitlabToken,
    StripeLiveKey,
    SlackToken,
    SlackWebhook,
    GoogleApiKey,
    PrivateKey,
    AnthropicKey,
    OpenaiKey,
    ServiceJwt,
    NpmToken,
    G1tToken,
    SendgridKey,
}

impl SecretKind {
    pub const ALL: [SecretKind; 15] = [
        SecretKind::AwsAccessKey,
        SecretKind::AwsSecretKey,
        SecretKind::GithubToken,
        SecretKind::GitlabToken,
        SecretKind::StripeLiveKey,
        SecretKind::SlackToken,
        SecretKind::SlackWebhook,
        SecretKind::GoogleApiKey,
        SecretKind::PrivateKey,
        SecretKind::AnthropicKey,
        SecretKind::OpenaiKey,
        SecretKind::ServiceJwt,
        SecretKind::NpmToken,
        SecretKind::G1tToken,
        SecretKind::SendgridKey,
    ];

    /// Stored and sent between services.
    pub fn id(self) -> &'static str {
        match self {
            SecretKind::AwsAccessKey => "aws_access_key",
            SecretKind::AwsSecretKey => "aws_secret_key",
            SecretKind::GithubToken => "github_token",
            SecretKind::GitlabToken => "gitlab_token",
            SecretKind::StripeLiveKey => "stripe_live_key",
            SecretKind::SlackToken => "slack_token",
            SecretKind::SlackWebhook => "slack_webhook",
            SecretKind::GoogleApiKey => "google_api_key",
            SecretKind::PrivateKey => "private_key",
            SecretKind::AnthropicKey => "anthropic_key",
            SecretKind::OpenaiKey => "openai_key",
            SecretKind::ServiceJwt => "service_jwt",
            SecretKind::NpmToken => "npm_token",
            SecretKind::G1tToken => "g1t_token",
            SecretKind::SendgridKey => "sendgrid_key",
        }
    }

    /// For a sentence: "contains an AWS access key".
    pub fn label(self) -> &'static str {
        match self {
            SecretKind::AwsAccessKey => "an AWS access key",
            SecretKind::AwsSecretKey => "an AWS secret access key",
            SecretKind::GithubToken => "a GitHub token",
            SecretKind::GitlabToken => "a GitLab token",
            SecretKind::StripeLiveKey => "a Stripe live key",
            SecretKind::SlackToken => "a Slack token",
            SecretKind::SlackWebhook => "a Slack webhook address",
            SecretKind::GoogleApiKey => "a Google API key",
            SecretKind::PrivateKey => "a private key",
            SecretKind::AnthropicKey => "an Anthropic API key",
            SecretKind::OpenaiKey => "an OpenAI API key",
            SecretKind::ServiceJwt => "a service-role JWT",
            SecretKind::NpmToken => "an npm token",
            SecretKind::G1tToken => "a g1t token",
            SecretKind::SendgridKey => "a SendGrid key",
        }
    }

    pub fn parse(id: &str) -> Option<SecretKind> {
        SecretKind::ALL.into_iter().find(|kind| kind.id() == id)
    }
}

/// A secret found on one line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub kind: SecretKind,
    /// From 1.
    pub line: u32,
    /// The secret itself. Never stored or shown: see [`Hit::fingerprint`]
    /// and [`Hit::preview`].
    pub value: String,
}

impl Hit {
    /// Names this secret without holding it: the same secret found again,
    /// in another commit or a rewritten one, has the same fingerprint.
    pub fn fingerprint(&self) -> String {
        fingerprint(self.kind, &self.value)
    }

    /// Enough of the secret for its owner to recognise it, and no more.
    pub fn preview(&self) -> String {
        preview(self.kind, &self.value)
    }

    /// Why this looks like a value made for tests or documentation rather
    /// than a real credential, or `None`. See [`test_value`].
    pub fn test_value(&self) -> Option<&'static str> {
        test_value(self.kind, &self.value)
    }
}

/// Keys their issuers publish in documentation, so that examples never use
/// a real one. Each is split in two here, so that this file holds no whole
/// key for a scanner to find.
const DOCUMENTED_EXAMPLES: &[&str] = &[
    // AWS's documentation: two access keys and their secret keys.
    concat!("AKIA", "IOSFODNN7EXAMPLE"),
    concat!("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
    concat!("AKIA", "I44QH8DHBEXAMPLE"),
    concat!("je7MtGbClwBF/2Zp9Utk/", "h3yCo8nvbEXAMPLEKEY"),
];

/// Words that say a value is not real.
const TEST_WORDS: &[&str] = &[
    "example",
    "sample",
    "dummy",
    "fake",
    "placeholder",
    "changeme",
    "notreal",
    "redacted",
    "xxxxx",
];

/// Why a secret the rules found looks like a value made for tests or
/// documentation, or `None` when it looks real. Judged from the value
/// alone, never from where it is: a key in `tests/` is as real as one in
/// `src/` if it was ever issued.
///
/// A likely test value is still a finding, listed apart from the others;
/// it never stops a push and is never counted as critical.
pub fn test_value(kind: SecretKind, value: &str) -> Option<&'static str> {
    if DOCUMENTED_EXAMPLES.iter().any(|example| value.contains(example)) {
        return Some("a key its issuer publishes as an example");
    }
    let lower = value.to_ascii_lowercase();
    if TEST_WORDS.iter().any(|word| lower.contains(word)) {
        return Some("it says it is an example");
    }
    // A private key is judged by its words only: its body is base64 of
    // structured bytes, which can look patterned without being made up.
    if kind == SecretKind::PrivateKey {
        return None;
    }
    let chars: Vec<char> = body_of(kind, value).chars().map(|c| c.to_ascii_lowercase()).collect();
    if longest(&chars, |a, b| b as u32 == a as u32 + 1) >= 6 {
        return Some("it counts up, like abcdef or 123456");
    }
    if longest(&chars, |a, b| a == b) >= 5 {
        return Some("one character over and over");
    }
    if repeated_piece(&chars) {
        return Some("a short piece repeated");
    }
    if chars.len() >= 20 && entropy(&chars) < 3.0 {
        return Some("too little randomness for a real key");
    }
    None
}

/// The part of a value its issuer generated: what follows the prefix its
/// rule starts with, for the kinds that have one.
fn body_of(kind: SecretKind, value: &str) -> &str {
    RULES
        .iter()
        .filter(|rule| rule.kind == kind)
        .flat_map(|rule| rule.prefixes.iter())
        .filter(|prefix| value.starts_with(**prefix))
        .map(|prefix| &value[prefix.len()..])
        .min_by_key(|body| body.len())
        .unwrap_or(value)
}

/// The longest run of characters each following the one before it by `next`.
fn longest(chars: &[char], next: impl Fn(char, char) -> bool) -> usize {
    let mut best = usize::from(!chars.is_empty());
    let mut run = 1;
    for pair in chars.windows(2) {
        run = if next(pair[0], pair[1]) { run + 1 } else { 1 };
        best = best.max(run);
    }
    best
}

/// Whether the value is one piece of two to eight characters, three times
/// or more.
fn repeated_piece(chars: &[char]) -> bool {
    (2..=8).any(|size| chars.len() >= size * 3 && chars.iter().enumerate().skip(size).all(|(at, c)| *c == chars[at % size]))
}

/// Shannon entropy, in bits per character.
fn entropy(chars: &[char]) -> f64 {
    let mut counts = std::collections::HashMap::new();
    for c in chars {
        *counts.entry(*c).or_insert(0u32) += 1;
    }
    let total = chars.len() as f64;
    counts
        .values()
        .map(|count| {
            let p = f64::from(*count) / total;
            -p * p.log2()
        })
        .sum()
}

pub fn fingerprint(kind: SecretKind, value: &str) -> String {
    let digest = Sha256::digest(format!("{}:{value}", kind.id()).as_bytes());
    digest[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn preview(kind: SecretKind, value: &str) -> String {
    if kind == SecretKind::PrivateKey {
        return value.lines().next().unwrap_or("-----BEGIN PRIVATE KEY-----").to_owned();
    }
    let chars: Vec<char> = value.chars().collect();
    let shown = (chars.len() / 4).clamp(3, 8);
    format!("{}…", chars[..shown.min(chars.len())].iter().collect::<String>())
}

#[derive(Clone, Copy)]
enum Alphabet {
    /// A–Z and 0–9.
    UpperDigit,
    /// Letters and digits.
    Alnum,
    /// Letters, digits and `_`.
    Word,
    /// Letters, digits, `_` and `-`.
    Token,
    /// Lowercase hex.
    Hex,
    /// Letters, digits, `_`, `-` and `.`.
    Dotted,
    /// Letters, digits and `/`.
    Path,
}

impl Alphabet {
    fn has(self, c: char) -> bool {
        match self {
            Alphabet::UpperDigit => c.is_ascii_uppercase() || c.is_ascii_digit(),
            Alphabet::Alnum => c.is_ascii_alphanumeric(),
            Alphabet::Word => c.is_ascii_alphanumeric() || c == '_',
            Alphabet::Token => c.is_ascii_alphanumeric() || c == '_' || c == '-',
            Alphabet::Hex => c.is_ascii_digit() || ('a'..='f').contains(&c),
            Alphabet::Dotted => c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'),
            Alphabet::Path => c.is_ascii_alphanumeric() || c == '/',
        }
    }
}

/// A format: what it starts with, which characters follow, and how many.
struct Rule {
    kind: SecretKind,
    prefixes: &'static [&'static str],
    body: Alphabet,
    min: usize,
    max: usize,
    /// Anything else the body has to be.
    check: Option<fn(&str) -> bool>,
}

const RULES: &[Rule] = &[
    Rule { kind: SecretKind::AwsAccessKey, prefixes: &["AKIA", "ASIA", "ABIA", "ACCA"], body: Alphabet::UpperDigit, min: 16, max: 16, check: None },
    Rule { kind: SecretKind::GithubToken, prefixes: &["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], body: Alphabet::Alnum, min: 36, max: 255, check: None },
    Rule { kind: SecretKind::GithubToken, prefixes: &["github_pat_"], body: Alphabet::Word, min: 50, max: 255, check: None },
    Rule { kind: SecretKind::GitlabToken, prefixes: &["glpat-", "gloas-", "glrt-", "glptt-", "gldt-"], body: Alphabet::Token, min: 20, max: 64, check: None },
    Rule { kind: SecretKind::StripeLiveKey, prefixes: &["sk_live_", "rk_live_"], body: Alphabet::Alnum, min: 20, max: 255, check: None },
    Rule { kind: SecretKind::SlackToken, prefixes: &["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-", "xoxe-"], body: Alphabet::Token, min: 20, max: 255, check: Some(has_digit) },
    Rule { kind: SecretKind::SlackWebhook, prefixes: &["https://hooks.slack.com/services/"], body: Alphabet::Path, min: 30, max: 120, check: Some(slack_webhook) },
    Rule { kind: SecretKind::GoogleApiKey, prefixes: &["AIza"], body: Alphabet::Token, min: 35, max: 35, check: None },
    Rule { kind: SecretKind::AnthropicKey, prefixes: &["sk-ant-"], body: Alphabet::Token, min: 40, max: 255, check: None },
    Rule { kind: SecretKind::OpenaiKey, prefixes: &["sk-proj-", "sk-svcacct-", "sk-admin-"], body: Alphabet::Token, min: 40, max: 255, check: None },
    // The keys OpenAI issued before project keys carry "T3BlbkFJ" in the middle.
    Rule { kind: SecretKind::OpenaiKey, prefixes: &["sk-"], body: Alphabet::Alnum, min: 40, max: 60, check: Some(openai_legacy) },
    Rule { kind: SecretKind::NpmToken, prefixes: &["npm_"], body: Alphabet::Alnum, min: 36, max: 36, check: None },
    Rule { kind: SecretKind::G1tToken, prefixes: &["g1t_"], body: Alphabet::Hex, min: 40, max: 40, check: None },
    Rule { kind: SecretKind::SendgridKey, prefixes: &["SG."], body: Alphabet::Dotted, min: 66, max: 66, check: Some(sendgrid) },
];

fn has_digit(body: &str) -> bool {
    body.chars().any(|c| c.is_ascii_digit())
}

fn slack_webhook(body: &str) -> bool {
    let parts: Vec<&str> = body.split('/').collect();
    parts.len() == 3 && parts[0].starts_with('T') && parts[1].starts_with('B') && parts[2].len() >= 20
}

fn openai_legacy(body: &str) -> bool {
    body.contains("T3BlbkFJ")
}

fn sendgrid(body: &str) -> bool {
    let parts: Vec<&str> = body.split('.').collect();
    parts.len() == 2 && parts[0].len() == 22 && parts[1].len() == 43
}

/// A run of one character over and over, or a handful of them, is a
/// placeholder in documentation: `ghp_xxxxxxxx…`, `AKIA0000…`.
fn placeholder(body: &str) -> bool {
    let mut seen = std::collections::HashSet::new();
    for c in body.chars() {
        seen.insert(c.to_ascii_lowercase());
    }
    seen.len() < 6
}

fn boundary_before(line: &str, at: usize) -> bool {
    line[..at]
        .chars()
        .next_back()
        .is_none_or(|c| !c.is_ascii_alphanumeric())
}

/// The secrets of the formats in [`RULES`] on one line.
fn by_rules(line: &str, found: &mut Vec<(SecretKind, String)>) {
    for rule in RULES {
        for prefix in rule.prefixes {
            let mut from = 0;
            while let Some(offset) = line[from..].find(prefix) {
                let at = from + offset;
                from = at + prefix.len();
                if !boundary_before(line, at) {
                    continue;
                }
                let body: String = line[from..].chars().take_while(|c| rule.body.has(*c)).collect();
                let length = body.chars().count();
                if length < rule.min || length > rule.max || placeholder(&body) {
                    continue;
                }
                if rule.check.is_some_and(|check| !check(&body)) {
                    continue;
                }
                found.push((rule.kind, format!("{prefix}{body}")));
            }
        }
    }
}

/// `aws_secret_access_key = "…"`: forty characters of base64 are only an
/// AWS secret when the line says so.
fn aws_secret(line: &str, found: &mut Vec<(SecretKind, String)>) {
    let lower = line.to_ascii_lowercase();
    if !lower.contains("aws") || !lower.contains("secret") {
        return;
    }
    for (at, _) in line.match_indices(['=', ':']) {
        let value: String = line[at + 1..]
            .trim_start_matches([' ', '"', '\'', '\t'])
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '+'))
            .collect();
        let mixed = value.chars().any(|c| c.is_ascii_uppercase())
            && value.chars().any(|c| c.is_ascii_lowercase())
            && value.chars().any(|c| c.is_ascii_digit());
        if value.len() == 40 && mixed && !placeholder(&value) {
            found.push((SecretKind::AwsSecretKey, value));
        }
    }
}

fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(input.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0);
    for byte in input.bytes().filter(|byte| *byte != b'=') {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
        }
    }
    Some(bytes)
}

/// A JWT whose claims make it a service's key rather than a user's
/// session: one that bypasses row-level security, signed to last.
fn service_jwt(line: &str, found: &mut Vec<(SecretKind, String)>) {
    let mut from = 0;
    while let Some(offset) = line[from..].find("eyJ") {
        let at = from + offset;
        from = at + 3;
        if !boundary_before(line, at) {
            continue;
        }
        let token: String = line[at..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
            .collect();
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 || parts[0].len() < 10 || parts[1].len() < 10 || parts[2].len() < 20 {
            continue;
        }
        let Some(claims) = base64url_decode(parts[1]) else {
            continue;
        };
        let claims = String::from_utf8_lossy(&claims);
        if claims.contains("\"service_role\"") {
            from = at + token.len();
            found.push((SecretKind::ServiceJwt, token));
        }
    }
}

const PEM_BODY: usize = 40;

fn looks_like_pem_body(text: &str) -> bool {
    let text = text.trim().trim_start_matches(['"', '\'']);
    text.starts_with("Proc-Type:")
        || text
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
            .count()
            >= PEM_BODY
}

/// The header of a PEM private key, when a key follows it: on the next
/// line, or after an escaped newline on the same one, as a key pasted into
/// a string does. A header alone is code that handles keys, not a key.
fn private_key(line: &str, next: Option<&str>, found: &mut Vec<(SecretKind, String)>) {
    let Some(start) = line.find("-----BEGIN ") else {
        return;
    };
    let rest = &line[start..];
    let Some(end) = rest[11..].find("-----") else {
        return;
    };
    let header = &rest[..11 + end + 5];
    if !header.contains("PRIVATE KEY") {
        return;
    }
    let after = rest[header.len()..].trim_start_matches("\\n").trim_start_matches("\\r\\n");
    let body = if looks_like_pem_body(after) {
        Some(after)
    } else {
        next.filter(|next| looks_like_pem_body(next))
    };
    if let Some(body) = body {
        let body: String = body
            .trim()
            .trim_start_matches(['"', '\''])
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != '\\' && *c != '"')
            .collect();
        found.push((SecretKind::PrivateKey, format!("{header}\n{body}")));
    }
}

/// The secrets on one line. `next` is the line after it, which a private
/// key's header needs to tell a key from code that mentions one.
pub fn scan_line(line: &str, next: Option<&str>) -> Vec<(SecretKind, String)> {
    let mut found = Vec::new();
    if line.contains(ALLOW_MARKER) {
        return found;
    }
    by_rules(line, &mut found);
    aws_secret(line, &mut found);
    service_jwt(line, &mut found);
    private_key(line, next, &mut found);
    // Two rules can find one secret (`sk-` and `sk-proj-`); keep the first.
    let mut seen = std::collections::HashSet::new();
    found.retain(|(_, value)| seen.insert(value.clone()));
    found
}

/// Every secret in `text`, on the lines `wanted` accepts (numbered from 1).
pub fn scan_lines(text: &str, wanted: impl Fn(u32) -> bool) -> Vec<Hit> {
    let lines: Vec<&str> = text.lines().collect();
    let mut hits = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let number = index as u32 + 1;
        if !wanted(number) {
            continue;
        }
        for (kind, value) in scan_line(line, lines.get(index + 1).copied()) {
            hits.push(Hit { kind, line: number, value });
        }
    }
    hits
}

/// Every secret in `text`.
pub fn scan_text(text: &str) -> Vec<Hit> {
    scan_lines(text, |_| true)
}

/// Paths whose contents are never secrets of their own: lockfiles and
/// vendored or generated code, where a match is someone else's fixture.
pub fn skipped_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    matches!(
        name,
        "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock" | "Cargo.lock" | "go.sum" | "poetry.lock"
    ) || path.split('/').any(|part| part == "node_modules" || part == "vendor")
        || name.ends_with(".min.js")
        || name.ends_with(".map")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Key-shaped values are put together at run time, so that no whole
    /// key sits in this file for any scanner, this one included, to flag.
    fn join(a: &str, b: &str) -> String {
        format!("{a}{b}")
    }

    fn kinds(line: &str) -> Vec<SecretKind> {
        scan_line(line, None).into_iter().map(|(kind, _)| kind).collect()
    }

    #[test]
    fn real_formats_are_found() {
        let cases = [
            (join("aws_access_key_id = AK", "IAZ7Q4N2XWLM3KDTRV"), SecretKind::AwsAccessKey),
            (join("token: gh", "p_Zq8wN3vR7tY2uI5oP1aS6dF4gH9jK0lXmC3b"), SecretKind::GithubToken),
            (join("GITLAB=glp", "at-x7Rk2PqLm9VwT4bN8cZs"), SecretKind::GitlabToken),
            (join("STRIPE_KEY=sk_l", "ive_51HabcdEFGhijKLMnop7QRSTuv"), SecretKind::StripeLiveKey),
            (join("SLACK=xo", "xb-2048-1029384756-Zq8wN3vR7tY2uI5oP1aS"), SecretKind::SlackToken),
            (join("url = https://hooks.slack.com/serv", "ices/T024BE7LD/B01ABCDEFGH/Zq8wN3vR7tY2uI5oP1aS6dF4"), SecretKind::SlackWebhook),
            (join("key: AI", "zaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"), SecretKind::GoogleApiKey),
            (join("ANTHROPIC_API_KEY=sk-an", "t-api03-Zq8wN3vR7tY2uI5oP1aS6dF4gH9jK0lXmC3bVn8wQ2"), SecretKind::AnthropicKey),
            (join("OPENAI_API_KEY=sk-pr", "oj-Zq8wN3vR7tY2uI5oP1aS6dF4gH9jK0lXmC3bVn8wQ2xx"), SecretKind::OpenaiKey),
            (join("key = \"sk-Zq8wN3vR7tY2uI5oP1a", "T3BlbkFJS6dF4gH9jK0lXmC3b\""), SecretKind::OpenaiKey),
            (join("//registry.npmjs.org/:_authToken=np", "m_Zq8wN3vR7tY2uI5oP1aS6dF4gH9jK0lXmC3b"), SecretKind::NpmToken),
            (join("G1T_TOKEN=g1", "t_3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a"), SecretKind::G1tToken),
            (join("SENDGRID=SG", ".Zq8wN3vR7tY2uI5oP1aS6x.dF4gH9jK0lXmC3bVn8wQ2xZq8wN3vR7tY2uI5oP1aS6"), SecretKind::SendgridKey),
            (join("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "Q2x9Lm3Kd7"), SecretKind::AwsSecretKey),
        ];
        for (line, kind) in cases {
            assert_eq!(kinds(&line), [kind], "{line}");
        }
    }

    #[test]
    fn fakes_are_found_too_and_the_marker_allows_them() {
        let example = join("AWS_KEY=AK", "IAIOSFODNN7EXAMPLE");
        assert_eq!(kinds(&example), [SecretKind::AwsAccessKey]);
        assert!(kinds(&format!("{example} # g1t:allow-secret")).is_empty());
        assert!(kinds(&format!("{example} // {ALLOW_MARKER}")).is_empty());
    }

    fn test_value_of(line: &str) -> Option<&'static str> {
        let hits = scan_text(line);
        assert_eq!(hits.len(), 1, "{line}");
        hits[0].test_value()
    }

    #[test]
    fn test_values_are_told_from_real_ones() {
        // Documented examples, words, counting, repeats, and too little randomness.
        for (line, why) in [
            (join("AWS: AK", "IAIOSFODNN7EXAMPLE"), "publishes as an example"),
            (join("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "EXAMPLEKEY"), "publishes as an example"),
            (join("use gh", "p_abcdefghijklmnopqrstuvwxyz0123456789 to clone"), "counts up"),
            (join("STRIPE_KEY=sk_l", "ive_51HabcdefghijklmnopQRSTUV"), "counts up"),
            (join("SLACK=xo", "xb-2048-1000000-Zq8wN3vR7tY2uI5oP1aS"), "over and over"),
            (join("token: gh", "p_q8Zw3Rq8Zw3Rq8Zw3Rq8Zw3Rq8Zw3Rq8Zw3R"), "piece repeated"),
            (join("key: sk-an", "t-api03-FAKEFAKEZq8wN3vR7tY2uI5oP1aS6dF4gH9jK0lXmC3b"), "says it is an example"),
            (join("G1T_TOKEN=g1", "t_aa1aa2aa3aa4aa5aa6aa1aa2aa3aa4aa5aa6aa1a"), "too little randomness"),
        ] {
            let found = test_value_of(&line).unwrap_or_else(|| panic!("{line} looks real"));
            assert!(found.contains(why), "{line}: {found}");
        }
        // Keys that look issued are not.
        for line in [
            join("aws_access_key_id = AK", "IAZ7Q4N2XWLM3KDTRV"),
            join("token: gh", "p_Zq8wN3vR7tY2uI5oP1aS6dF4gH9jK0lXmC3b"),
            join("G1T_TOKEN=g1", "t_3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a"),
            join("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "Q2x9Lm3Kd7"),
            join("ANTHROPIC_API_KEY=sk-an", "t-api03-Zq8wN3vR7tY2uI5oP1aS6dF4gH9jK0lXmC3bVn8wQ2"),
        ] {
            assert_eq!(test_value_of(&line), None, "{line}");
        }
        // A file's path is never the reason: the same value is judged the same.
        let key = join("AK", "IAZ7Q4N2XWLM3KDTRV");
        assert_eq!(test_value(SecretKind::AwsAccessKey, &key), None);
    }

    #[test]
    fn ordinary_code_is_left_alone() {
        for line in [
            "Commit 9f2c4e1a7b3d5f60812a4c6e8b0d2f4a6c8e0b13 introduced the flaky retry.",
            "const prefix = \"ghp_\";",
            "STRIPE_KEY=sk_test_51HabcdEFGhijKLMnop7QRSTuv",
            "GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "if pem.starts_with(\"-----BEGIN PRIVATE KEY-----\") {",
            "\"integrity\": \"sha512-Zq8wN3vR7tY2uI5oP1aS6dF4gH9jK0lXmC3bVn8wQ2xZq8wN3vR7tY2uI5oP1aS6dF==\"",
            "password = hunter2hunter2",
            "let task = ASIAN_MARKETS;",
            "import { AIzaClient } from './maps';",
            "-----BEGIN PUBLIC KEY-----",
            "secret = process.env.AWS_SECRET_ACCESS_KEY",
            "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX",
        ] {
            assert!(kinds(line).is_empty(), "{line}");
        }
    }

    #[test]
    fn a_private_key_needs_its_body() {
        let header = join("-----BEGIN RSA PRIVA", "TE KEY-----");
        let body = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun";
        assert_eq!(kinds_with_next(&header, Some(body)), [SecretKind::PrivateKey]);
        assert!(kinds_with_next(&header, Some("...")).is_empty());
        let escaped = format!("key: \"{header}\\n{body}\\n\"");
        assert_eq!(kinds(&escaped), [SecretKind::PrivateKey]);
        let hits = scan_text(&format!("x\n{header}\n{body}\n-----END RSA PRIVATE KEY-----\n"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert!(hits[0].preview().contains("BEGIN RSA"));
    }

    fn kinds_with_next(line: &str, next: Option<&str>) -> Vec<SecretKind> {
        scan_line(line, next).into_iter().map(|(kind, _)| kind).collect()
    }

    #[test]
    fn a_service_role_jwt_is_found_and_a_user_jwt_is_not() {
        // {"alg":"HS256","typ":"JWT"} . {"role":"service_role","iss":"supabase"}
        let service = join(
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ",
            ".dGhpc2lzbm90YXJlYWxzaWduYXR1cmVidXRsb25nZW5vdWdo",
        );
        assert_eq!(kinds(&format!("SUPABASE_SERVICE_KEY={service}")), [SecretKind::ServiceJwt]);
        // {"role":"anon"}
        let anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.dGhpc2lzbm90YXJlYWxzaWduYXR1cmVidXRsb25nZW5vdWdo";
        assert!(kinds(anon).is_empty());
    }

    #[test]
    fn fingerprints_name_the_secret_not_where_it_is() {
        let line = join("AK", "IAZ7Q4N2XWLM3KDTRV");
        let a = scan_lines(&format!("a\n{line}\n"), |_| true);
        let b = scan_lines(&format!("{line}\n"), |_| true);
        assert_eq!(a[0].line, 2);
        assert_eq!(b[0].line, 1);
        assert_eq!(a[0].fingerprint(), b[0].fingerprint());
        assert_eq!(a[0].fingerprint().len(), 32);
        assert!(!a[0].preview().contains(&a[0].value));
        assert!(a[0].preview().starts_with("AKIA"));
    }

    #[test]
    fn only_the_wanted_lines_are_scanned() {
        let key = join("AK", "IAZ7Q4N2XWLM3KDTRV");
        let text = format!("{key}\nplain\n{key}\n");
        let hits = scan_lines(&text, |line| line == 3);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 3);
    }

    #[test]
    fn kinds_round_trip() {
        for kind in SecretKind::ALL {
            assert_eq!(SecretKind::parse(kind.id()), Some(kind));
            assert!(!kind.label().is_empty());
        }
    }

    #[test]
    fn lockfiles_and_vendored_code_are_skipped() {
        assert!(skipped_path("web/package-lock.json"));
        assert!(skipped_path("vendor/github.com/x/y.go"));
        assert!(skipped_path("node_modules/a/index.js"));
        assert!(!skipped_path("src/config.ts"));
    }
}
