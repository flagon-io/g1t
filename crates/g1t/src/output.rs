//! How results are shown.
//!
//! On a terminal: aligned tables and short summaries, in color unless
//! `NO_COLOR` is set. Piped: one record a line, tab-separated, with no
//! header and no color, so `cut` and `awk` work. With `--json`: the API's
//! own objects, compact and with their keys in a stable order; `--json
//! a,b` keeps only those keys, and `--jq` runs a jq expression over it.

use serde_json::{Map, Value};
use std::io::{IsTerminal, Write};

use crate::error::{Error, Result};

#[derive(Clone, Debug, Default)]
pub struct Output {
    /// `--json`: `Some(vec![])` for every field.
    pub json: Option<Vec<String>>,
    pub jq: Option<String>,
    pub tty: bool,
    pub color: bool,
    pub width: usize,
}

impl Output {
    pub fn detect(json: Option<String>, jq: Option<String>) -> Output {
        let tty = std::io::stdout().is_terminal();
        let forced = std::env::var("CLICOLOR_FORCE").is_ok_and(|v| !v.is_empty() && v != "0");
        let no_color = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty());
        let color = !no_color && (forced || tty) && enable_ansi();
        let width = std::env::var("COLUMNS")
            .ok()
            .and_then(|c| c.parse().ok())
            .or_else(|| terminal_size::terminal_size().map(|(w, _)| w.0 as usize))
            .unwrap_or(120);
        let json = json.map(|fields| {
            fields
                .split(',')
                .map(|f| f.trim().to_owned())
                .filter(|f| !f.is_empty())
                .collect()
        });
        Output {
            json,
            jq,
            tty,
            color,
            width,
        }
    }

    /// Whether JSON is wanted instead of the human form.
    pub fn structured(&self) -> bool {
        self.json.is_some() || self.jq.is_some()
    }

    /// Prints `value` as `--json`/`--jq` ask.
    pub fn emit(&self, value: &Value) -> Result<()> {
        let value = match &self.json {
            Some(fields) if !fields.is_empty() => select(value, fields)?,
            _ => value.clone(),
        };
        let mut out = std::io::stdout().lock();
        if let Some(filter) = &self.jq {
            for result in crate::jq::run(filter, &value)? {
                writeln!(out, "{}", crate::jq::line(&result))?;
            }
            return Ok(());
        }
        let value = sorted(&value);
        let text = if self.tty {
            serde_json::to_string_pretty(&value)
        } else {
            serde_json::to_string(&value)
        }
        .expect("json");
        writeln!(out, "{text}")?;
        Ok(())
    }

    /// Prints one record of a stream as `--json`/`--jq` ask: compact, on
    /// one line, terminal or not, so each line can be read as it comes.
    pub fn emit_line(&self, value: &Value) -> Result<()> {
        if self.jq.is_some() {
            return self.emit(value);
        }
        writeln!(std::io::stdout().lock(), "{}", json_line(self, value)?)?;
        Ok(())
    }

    pub fn paint(&self, code: &str, text: &str) -> String {
        if self.color && !text.is_empty() {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_owned()
        }
    }
    pub fn bold(&self, t: &str) -> String {
        self.paint("1", t)
    }
    pub fn dim(&self, t: &str) -> String {
        self.paint("2", t)
    }
    pub fn green(&self, t: &str) -> String {
        self.paint("32", t)
    }
    pub fn red(&self, t: &str) -> String {
        self.paint("31", t)
    }
    pub fn yellow(&self, t: &str) -> String {
        self.paint("33", t)
    }
    pub fn magenta(&self, t: &str) -> String {
        self.paint("35", t)
    }
    pub fn cyan(&self, t: &str) -> String {
        self.paint("36", t)
    }

    /// A state word in the color it is usually shown in.
    pub fn state(&self, state: &str) -> String {
        match state {
            "open" | "success" | "passed" | "approved" | "active" | "completed" | "ready" => {
                self.green(state)
            }
            "merged" => self.magenta(state),
            "closed" | "failure" | "failed" | "error" | "cancelled" | "timed_out" | "denied"
            | "request_changes" => self.red(state),
            "draft" | "skipped" | "neutral" | "inactive" | "not_planned" => self.dim(state),
            "" => String::new(),
            _ => self.yellow(state),
        }
    }

    /// Prints rows: aligned with a header on a terminal, tab-separated
    /// without one when piped.
    pub fn table(&self, header: &[&str], rows: &[Vec<Cell>]) -> Result<()> {
        let mut out = std::io::stdout().lock();
        if !self.tty {
            for row in rows {
                let line: Vec<&str> = row.iter().map(|c| c.plain.as_str()).collect();
                writeln!(out, "{}", line.join("\t"))?;
            }
            return Ok(());
        }
        let columns = header.len();
        let mut widths: Vec<usize> = header.iter().map(|h| h.chars().count()).collect();
        for row in rows {
            for (i, cell) in row.iter().enumerate().take(columns) {
                widths[i] = widths[i].max(cell.plain.chars().count());
            }
        }
        // Squeeze the widest column to fit the terminal.
        let gaps = 2 * columns.saturating_sub(1);
        let total: usize = widths.iter().sum::<usize>() + gaps;
        if total > self.width
            && let Some((widest, _)) = widths.iter().enumerate().max_by_key(|(_, w)| **w)
        {
            let others: usize = widths.iter().sum::<usize>() - widths[widest] + gaps;
            widths[widest] = self.width.saturating_sub(others).max(8);
        }
        let heads: Vec<Cell> = header
            .iter()
            .map(|h| Cell::styled(h.to_uppercase(), self.dim(&h.to_uppercase())))
            .collect();
        for row in std::iter::once(&heads).chain(rows.iter()) {
            let mut line = String::new();
            for (i, cell) in row.iter().enumerate().take(columns) {
                let last = i + 1 == columns;
                line.push_str(&cell.fit(widths[i], !last));
                if !last {
                    line.push_str("  ");
                }
            }
            writeln!(out, "{}", line.trim_end())?;
        }
        Ok(())
    }
}

/// A table cell: its text, and how it looks on a terminal.
#[derive(Clone, Debug)]
pub struct Cell {
    pub plain: String,
    pub shown: String,
}

impl Cell {
    pub fn new(text: impl Into<String>) -> Cell {
        let plain = text.into();
        Cell {
            shown: plain.clone(),
            plain,
        }
    }

    pub fn styled(plain: impl Into<String>, shown: String) -> Cell {
        Cell {
            plain: plain.into(),
            shown,
        }
    }

    fn fit(&self, width: usize, pad: bool) -> String {
        let len = self.plain.chars().count();
        if len > width {
            let cut: String = self.plain.chars().take(width.saturating_sub(1)).collect();
            return format!("{cut}…");
        }
        if pad {
            format!("{}{}", self.shown, " ".repeat(width - len))
        } else {
            self.shown.clone()
        }
    }
}

/// `value` with every object's keys in sorted order. Printed JSON must not
/// depend on serde_json's `preserve_order`, which other crates in the
/// workspace turn on for a shared build.
pub fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), sorted(&map[k]))).collect())
        }
        Value::Array(list) => Value::Array(list.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// `value` as one compact line of JSON, with only the `--json` fields asked for.
pub fn json_line(out: &Output, value: &Value) -> Result<String> {
    let value = match &out.json {
        Some(fields) if !fields.is_empty() => select(value, fields)?,
        _ => value.clone(),
    };
    Ok(serde_json::to_string(&sorted(&value)).expect("json"))
}

/// Keeps only `fields` of each object in `value`.
pub fn select(value: &Value, fields: &[String]) -> Result<Value> {
    let objects: Vec<&Map<String, Value>> = match value {
        Value::Array(items) => items.iter().filter_map(Value::as_object).collect(),
        Value::Object(map) => vec![map],
        _ => return Ok(value.clone()),
    };
    if let Some(first) = objects.first() {
        let unknown: Vec<&String> = fields
            .iter()
            .filter(|f| !objects.iter().any(|o| o.contains_key(f.as_str())))
            .collect();
        if !unknown.is_empty() {
            let mut available: Vec<&String> = first.keys().collect();
            available.sort();
            let available: Vec<&str> = available.iter().map(|s| s.as_str()).collect();
            return Err(Error::usage(format!(
                "Unknown JSON field `{}`. Available: {}",
                unknown[0],
                available.join(", ")
            )));
        }
    }
    let pick = |map: &Map<String, Value>| {
        let mut out = Map::new();
        for f in fields {
            out.insert(f.clone(), map.get(f).cloned().unwrap_or(Value::Null));
        }
        Value::Object(out)
    };
    Ok(match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| v.as_object().map(pick).unwrap_or_else(|| v.clone()))
                .collect(),
        ),
        Value::Object(map) => pick(map),
        other => other.clone(),
    })
}

fn enable_ansi() -> bool {
    #[cfg(windows)]
    {
        anstyle_query::windows::enable_ansi_colors().unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// Seconds since 1970 for an RFC 3339 time like `2026-10-01T18:04:11.482Z`.
pub fn parse_time(text: &str) -> Option<i64> {
    let text = text.trim();
    if text.len() < 19 {
        return None;
    }
    let num = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    // Days from civil (Howard Hinnant's algorithm).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let mut secs = days * 86_400 + h * 3600 + mi * 60 + s;
    // An offset like +02:00 at the end.
    let tail = &text[19..];
    let tail = tail.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if let Some(sign) = tail.chars().next().filter(|c| *c == '+' || *c == '-') {
        let oh: i64 = tail.get(1..3)?.parse().ok()?;
        let om: i64 = tail.get(4..6).and_then(|m| m.parse().ok()).unwrap_or(0);
        let offset = oh * 3600 + om * 60;
        secs -= if sign == '+' { offset } else { -offset };
    }
    Some(secs)
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// `3m ago`, `2h ago`, `5d ago`, or the date for older ones.
pub fn ago(text: &str) -> String {
    let Some(then) = parse_time(text) else {
        return text.to_owned();
    };
    let secs = (now() - then).max(0);
    match secs {
        0..60 => "just now".to_owned(),
        60..3600 => format!("{}m ago", secs / 60),
        3600..86_400 => format!("{}h ago", secs / 3600),
        86_400..2_592_000 => format!("{}d ago", secs / 86_400),
        _ => text.get(0..10).unwrap_or(text).to_owned(),
    }
}

/// `1m32s` for a span of seconds.
pub fn duration(secs: i64) -> String {
    let secs = secs.max(0);
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m{}s", secs / 60, secs % 60),
        _ => format!("{}h{}m", secs / 3600, (secs % 3600) / 60),
    }
}

/// How long between two times, when both are known.
pub fn elapsed(start: &Value, end: &Value) -> String {
    match (
        start.as_str().and_then(parse_time),
        end.as_str().and_then(parse_time),
    ) {
        (Some(a), Some(b)) => duration(b - a),
        (Some(a), None) => duration(now() - a),
        _ => String::new(),
    }
}

/// A string field, or "".
pub fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fields_are_selected() {
        let list = json!([{ "number": 1, "title": "a", "body": "x" }, { "number": 2, "title": "b", "body": "y" }]);
        let picked = select(&list, &["number".into(), "title".into()]).unwrap();
        assert_eq!(
            picked,
            json!([{ "number": 1, "title": "a" }, { "number": 2, "title": "b" }])
        );
        let one = select(&json!({ "a": 1, "b": 2 }), &["b".into()]).unwrap();
        assert_eq!(one, json!({ "b": 2 }));
        let err = select(&list, &["nope".into()]).unwrap_err();
        assert_eq!(err.kind, crate::error::Kind::Usage);
        assert!(
            err.message.contains("Available: body, number, title"),
            "{}",
            err.message
        );
        // Nothing to check against: an empty list stays empty.
        assert_eq!(select(&json!([]), &["nope".into()]).unwrap(), json!([]));
    }

    #[test]
    fn json_is_compact_and_ordered() {
        let value: Value = serde_json::from_str(r#"{"title":"a","number":1}"#).unwrap();
        assert_eq!(
            serde_json::to_string(&sorted(&value)).unwrap(),
            r#"{"number":1,"title":"a"}"#
        );
    }

    #[test]
    fn times_parse() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time("2026-10-01T18:04:11.482Z"), Some(1_790_877_851));
        assert_eq!(parse_time("2026-10-01T20:04:11+02:00"), Some(1_790_877_851));
        assert_eq!(parse_time("yesterday"), None);
        assert_eq!(duration(92), "1m32s");
        assert_eq!(duration(3700), "1h1m");
    }

    #[test]
    fn cells_fit_their_column() {
        let cell = Cell::new("a long title");
        assert_eq!(cell.fit(6, true), "a lon…");
        assert_eq!(cell.fit(14, true), "a long title  ");
        assert_eq!(cell.fit(14, false), "a long title");
    }

    #[test]
    fn plain_output_has_no_color() {
        let out = Output {
            color: false,
            ..Output::default()
        };
        assert_eq!(out.state("open"), "open");
        let out = Output {
            color: true,
            ..Output::default()
        };
        assert_eq!(out.state("open"), "\x1b[32mopen\x1b[0m");
    }
}
