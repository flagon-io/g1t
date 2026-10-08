//! Masking secrets in a job's log: every form a secret's value can take in
//! output, so that `***` replaces it wherever it shows.
//!
//! A value is masked as it is, each of its lines on its own (a PEM key is
//! printed a line at a time), base64-encoded (as `echo $KEY | base64` or an
//! HTTP basic header shows it, at each of the three byte offsets it can sit
//! at inside longer base64), and JSON-escaped (as a value inside printed
//! JSON). Values of one character are not masked: every log line would lose
//! that character.

/// The shortest value or part of one that is masked.
pub const MIN_MASK_CHARS: usize = 2;

/// Every form of `value` to mask, longest first.
pub fn variants(value: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |text: &str| {
        if text.trim().chars().count() >= MIN_MASK_CHARS && !out.iter().any(|known| known == text) {
            out.push(text.to_owned());
        }
    };
    if value.trim().chars().count() < MIN_MASK_CHARS {
        return Vec::new();
    }
    add(value);
    let trimmed = value.trim_matches(|c| c == '\n' || c == '\r');
    add(trimmed);
    // Each line, as it is printed on its own.
    if trimmed.contains('\n') {
        for line in trimmed.lines() {
            let line = line.trim_end_matches('\r');
            add(line);
            add(line.trim());
        }
    }
    // JSON-escaped, without its quotes.
    let escaped = serde_json::to_string(value).unwrap_or_default();
    add(&escaped[1..escaped.len().saturating_sub(1).max(1)]);
    // Base64, at each offset inside a longer encoding, and on its own.
    for encoded in base64_variants(value.as_bytes()) {
        add(&encoded);
    }
    if trimmed != value {
        for encoded in base64_variants(trimmed.as_bytes()) {
            add(&encoded);
        }
    }
    out.sort_by_key(|mask| std::cmp::Reverse(mask.len()));
    out
}

/// Every form of each of `values`, longest first.
pub fn all_variants<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        for variant in variants(value) {
            if !out.contains(&variant) {
                out.push(variant);
            }
        }
    }
    out.sort_by_key(|mask| std::cmp::Reverse(mask.len()));
    out
}

/// `text` with every mask replaced by `***`. `masks` longest first.
pub fn apply(text: &str, masks: &[String]) -> String {
    let mut out = text.to_owned();
    for mask in masks.iter().filter(|mask| !mask.is_empty()) {
        if out.contains(mask.as_str()) {
            out = out.replace(mask.as_str(), "***");
        }
    }
    out
}

/// Whether `text` holds any of `masks`.
pub fn reveals(text: &str, masks: &[String]) -> bool {
    masks.iter().any(|mask| !mask.is_empty() && text.contains(mask.as_str()))
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The base64 of `bytes` as it reads inside a longer encoding, starting at
/// each of the three byte offsets: only the characters that depend on
/// `bytes` alone, so the mask matches whatever surrounds it. The whole
/// encoding, padding and all, comes first.
fn base64_variants(bytes: &[u8]) -> Vec<String> {
    let mut out = vec![base64(bytes)];
    // Too short to mask without hiding ordinary text.
    if bytes.len() < 3 {
        return out;
    }
    for offset in 0..3usize {
        let mut padded = vec![0u8; offset];
        padded.extend_from_slice(bytes);
        let encoded = base64(&padded);
        // Characters before the first whole group of `bytes` mix in what
        // comes before them; after the last whole group, what comes after.
        let start = if offset == 0 { 0 } else { 4 };
        let whole = (offset + bytes.len()) / 3 * 4;
        if whole > start + 1 {
            out.push(encoded[start..whole].to_owned());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_reads_as_the_standard_alphabet() {
        assert_eq!(base64(b"hunter2"), "aHVudGVyMg==");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"abc"), "YWJj");
    }

    #[test]
    fn a_multi_line_secret_is_masked_a_line_at_a_time() {
        let pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAAS\nCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n";
        let masks = variants(pem);
        // Printed one line at a time, as `cat key.pem` does.
        for line in pem.lines() {
            assert_eq!(apply(line, &masks), "***", "{line}");
        }
        assert_eq!(apply(&format!("key: {pem}"), &masks).matches("***").count(), 1, "the whole value first");
    }

    #[test]
    fn base64_and_json_forms_are_masked() {
        let secret = "s3cr3t-v4lue!";
        let masks = variants(secret);
        // `echo -n $SECRET | base64`.
        assert_eq!(apply(&base64(secret.as_bytes()), &masks), "***");
        // Inside a longer encoding, at any offset: an HTTP basic header.
        for prefix in ["", "u:", "us:", "use:"] {
            let header = base64(format!("{prefix}{secret}").as_bytes());
            assert!(apply(&header, &masks).contains("***"), "{prefix}");
            assert!(!apply(&header, &masks).contains(&base64(secret.as_bytes())[4..12]), "{prefix}");
        }
        // JSON-escaped, as a value printed inside JSON.
        let quoted = "pa\"ss\\word\nline";
        let printed = serde_json::json!({ "password": quoted }).to_string();
        assert_eq!(apply(&printed, &variants(quoted)), "{\"password\":\"***\"}");
    }

    #[test]
    fn short_values_and_blanks() {
        assert!(variants("").is_empty());
        assert!(variants("  \n").is_empty());
        assert!(variants("x").is_empty(), "a single character is not masked");
        assert_eq!(apply("pin is 42", &variants("42")), "pin is ***");
        assert_eq!(apply("abc", &variants("abc")), "***");
    }

    #[test]
    fn outputs_that_reveal_a_secret_are_found() {
        let masks = all_variants(["topsecret", "other\nvalue"]);
        assert!(reveals("x=topsecret", &masks));
        assert!(reveals("value", &masks));
        assert!(reveals(&base64(b"topsecret"), &masks));
        assert!(!reveals("nothing here", &masks));
    }
}
