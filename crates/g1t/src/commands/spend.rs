//! `g1t spend`: what one person's harness sessions (subagents and all)
//! cost in a workspace over a span of days, and how much of it went into
//! work that landed, grouped by work item, repository, harness, model or
//! day.
//!
//! Spend is information about work, not a score for people. Your own you
//! always see in full; someone else's (`--person`) only as the workspace's
//! setting allows. When you may see others', they are listed by name, in
//! the order the API gives (never by what they spent). Every figure is an
//! estimate at list price, from the tokens each session reported.
//!
//! The workspace is `--workspace`, or the current repository's.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::cli::{SpendArgs, SpendBy};
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{Cell, Output, now, parse_time, s};

use super::work::place;

const SECONDS_A_DAY: i64 = 86_400;
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

pub fn run(ctx: &Ctx, args: SpendArgs) -> Result<()> {
    let place = place(ctx, args.workspace.as_deref())?;
    // Spend is a person's: there is none to read signed out.
    if !place.client.has_token() {
        return Err(crate::context::not_signed_in(&place.client.host));
    }
    let today = now().div_euclid(SECONDS_A_DAY);
    let since = args.since.as_deref().map(|given| since_day(given, today)).transpose()?;
    if let Some(until) = &args.until
        && day_number(until).is_none()
    {
        return Err(Error::usage("--until is a day, YYYY-MM-DD."));
    }
    let person = args.person.as_deref().map(|p| p.trim().trim_start_matches('@')).filter(|p| !p.is_empty());
    let spend = place
        .client
        .op("get_spend")
        .arg("workspace", &place.workspace)
        .query_opt("person", person)
        .query_opt("since", since)
        .query_opt("until", args.until.as_deref())
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&spend);
    }
    print_spend(&ctx.out, &spend, args.by)
}

// --- days --------------------------------------------------------------

/// Days since 1970 of a `YYYY-MM-DD` day, when it is one.
fn day_number(day: &str) -> Option<i64> {
    let day = day.trim();
    let shaped = day.len() == 10 && day.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    if !shaped {
        return None;
    }
    let days = parse_time(&format!("{day}T00:00:00Z"))?.div_euclid(SECONDS_A_DAY);
    // Feb 30 and the like come back as another day.
    (day_text(days) == day).then_some(days)
}

/// `YYYY-MM-DD` of days since 1970 (Howard Hinnant's civil_from_days).
fn day_text(days: i64) -> String {
    let (year, month, day) = civil(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `--since`: a day as it is, or `7d`, the last 7 days with `today` the
/// last of them, as the day they start on.
fn since_day(given: &str, today: i64) -> Result<String> {
    let given = given.trim();
    if let Some(count) = given.strip_suffix(['d', 'D']) {
        return match count.parse::<i64>() {
            Ok(count) if count >= 1 => Ok(day_text(today - (count - 1))),
            _ => Err(Error::usage("--since 7d is the last 7 days: a whole number of days, 1 or more.")),
        };
    }
    match day_number(given) {
        Some(_) => Ok(given.to_owned()),
        None => Err(Error::usage("--since is a day, YYYY-MM-DD, or a number of days such as 7d.")),
    }
}

/// `Sep 23 – Oct 22`, with the years when the span crosses one.
fn span(since: &str, until: &str) -> String {
    let short = |day: &str, year: bool| match day_number(day).map(civil) {
        Some((y, m, d)) if year => format!("{} {d}, {y}", MONTHS[m as usize - 1]),
        Some((_, m, d)) => format!("{} {d}", MONTHS[m as usize - 1]),
        None => day.to_owned(),
    };
    if since == until {
        return short(since, false);
    }
    let years_differ = since.get(0..4) != until.get(0..4);
    format!("{} – {}", short(since, years_differ), short(until, years_differ))
}

// --- figures -------------------------------------------------------------

/// `$1,234.56`.
fn money(usd: f64) -> String {
    let cents = format!("{:.2}", usd.max(0.0));
    let (whole, fraction) = cents.split_once('.').unwrap_or((&cents, "00"));
    let mut grouped = String::new();
    for (i, digit) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("${grouped}.{fraction}")
}

fn number(value: &Value, key: &str) -> f64 {
    value[key].as_f64().unwrap_or_default()
}

fn count(value: &Value, key: &str) -> u64 {
    value[key].as_u64().unwrap_or_default()
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// `ada's spend in flagon-io, Sep 23 – Oct 22: $12.34, $9.10 of it on work
/// that landed (74%) · 41 sessions, 3 with no known cost`.
fn headline(spend: &Value) -> String {
    let cost = number(spend, "cost_usd");
    let landed = number(spend, "landed_usd");
    let mut line = format!(
        "{}'s spend in {}, {}: {}",
        s(&spend["person"], "username"),
        s(spend, "workspace"),
        span(s(spend, "since"), s(spend, "until")),
        money(cost)
    );
    if cost > 0.0 {
        let share = (landed / cost * 100.0).round();
        line.push_str(&format!(", {} of it on work that landed ({share}%)", money(landed)));
    }
    line.push_str(&format!(" · {}", plural(count(spend, "sessions"), "session", "sessions")));
    let unknown = count(spend, "unknown_sessions");
    if unknown > 0 {
        line.push_str(&format!(", {unknown} with no known cost"));
    }
    line
}

/// The rows of the spend summed by what `by` groups them by.
#[derive(Debug, PartialEq)]
struct Group {
    label: String,
    sessions: u64,
    cost: f64,
    landed: f64,
}

/// What a row counts under: `#12` or `no work item`, a repository or
/// `elsewhere` (one you cannot read), a harness, a model, or a day.
fn label(row: &Value, by: SpendBy) -> String {
    match by {
        SpendBy::Item => row["item"].as_u64().map_or_else(|| "no work item".to_owned(), |n| format!("#{n}")),
        SpendBy::Repo => row["repo"].as_str().unwrap_or("elsewhere").to_owned(),
        SpendBy::Harness => s(row, "harness").to_owned(),
        SpendBy::Model => row["model"].as_str().unwrap_or("unknown model").to_owned(),
        SpendBy::Day => s(row, "day").to_owned(),
    }
}

/// The groups, the costliest first; days newest first, as a timeline.
fn groups(rows: &[Value], by: SpendBy) -> Vec<Group> {
    let mut summed: BTreeMap<String, Group> = BTreeMap::new();
    for row in rows {
        let label = label(row, by);
        let group = summed.entry(label.clone()).or_insert(Group { label, sessions: 0, cost: 0.0, landed: 0.0 });
        let cost = number(row, "cost_usd");
        group.sessions += count(row, "sessions");
        group.cost += cost;
        if row["landed"] == true {
            group.landed += cost;
        }
    }
    let mut groups: Vec<Group> = summed.into_values().collect();
    if by == SpendBy::Day {
        groups.reverse();
    } else {
        groups.sort_by(|a, b| b.cost.total_cmp(&a.cost).then_with(|| a.label.cmp(&b.label)));
    }
    groups
}

/// Who sees each person's spend under the workspace's setting.
fn who_sees(visibility: &str) -> &'static str {
    match visibility {
        "members" => "every member sees",
        "nobody" => "nobody else sees",
        _ => "its owners and billing managers see",
    }
}

fn print_spend(out: &Output, spend: &Value, by: SpendBy) -> Result<()> {
    println!("{}", out.bold(&headline(spend)));
    let rows = spend["rows"].as_array().cloned().unwrap_or_default();
    println!();
    if rows.is_empty() {
        println!("  {}", out.dim("No sessions in this span."));
    } else {
        let heading = match by {
            SpendBy::Item => "work item",
            SpendBy::Repo => "repository",
            SpendBy::Harness => "harness",
            SpendBy::Model => "model",
            SpendBy::Day => "day",
        };
        let table: Vec<Vec<Cell>> = groups(&rows, by)
            .into_iter()
            .map(|group| {
                let shown = if group.label.starts_with('#') { out.green(&group.label) } else { group.label.clone() };
                vec![
                    Cell::styled(group.label, shown),
                    Cell::new(group.sessions.to_string()),
                    Cell::new(money(group.cost)),
                    Cell::new(money(group.landed)),
                ]
            })
            .collect();
        out.table(&[heading, "sessions", "cost", "landed"], &table)?;
    }
    if spend["can_see_people"] == true {
        println!();
        println!("{}", out.bold("People"));
        let people = spend["people"].as_array().cloned().unwrap_or_default();
        if people.is_empty() {
            println!("  {}", out.dim("Nobody has spend in this span."));
        } else {
            // By name, as the API lists them: never by what they spent.
            let table: Vec<Vec<Cell>> = people
                .iter()
                .map(|person| {
                    vec![
                        Cell::new(s(person, "username")),
                        Cell::new(count(person, "sessions").to_string()),
                        Cell::new(money(number(person, "cost_usd"))),
                    ]
                })
                .collect();
            out.table(&["person", "sessions", "cost"], &table)?;
        }
        println!("{}", out.dim(&format!("For budgets and plan fit: {} each person's spend.", who_sees(s(spend, "visibility")))));
    }
    if let Some(total) = spend["workspace_usd"].as_f64() {
        println!();
        println!("Everyone: {} across {}", money(total), plural(count(spend, "workspace_people"), "person", "people"));
    }
    println!();
    println!("{}", out.dim("Estimates at list price, from the tokens each session reported."));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn days_read_and_count_as_written() {
        assert_eq!(day_number("1970-01-02"), Some(1));
        assert_eq!(day_text(day_number("2026-10-22").unwrap()), "2026-10-22");
        assert_eq!(day_text(day_number("2024-02-29").unwrap()), "2024-02-29");
        assert_eq!(day_number("2026-02-30"), None);
        assert_eq!(day_number("2026-1-5"), None);
        assert_eq!(day_number("yesterday"), None);
    }

    #[test]
    fn since_takes_a_day_or_a_count_of_days_ending_today() {
        let today = day_number("2026-10-22").unwrap();
        assert_eq!(since_day("7d", today).unwrap(), "2026-10-16");
        assert_eq!(since_day("1d", today).unwrap(), "2026-10-22");
        assert_eq!(since_day("30d", today).unwrap(), "2026-09-23");
        assert_eq!(since_day("2026-09-01", today).unwrap(), "2026-09-01");
        assert!(since_day("0d", today).is_err());
        assert!(since_day("a week", today).is_err());
    }

    #[test]
    fn a_span_reads_as_people_say_it() {
        assert_eq!(span("2026-09-23", "2026-10-22"), "Sep 23 – Oct 22");
        assert_eq!(span("2025-12-20", "2026-01-18"), "Dec 20, 2025 – Jan 18, 2026");
        assert_eq!(span("2026-10-22", "2026-10-22"), "Oct 22");
    }

    #[test]
    fn money_is_dollars_and_cents() {
        assert_eq!(money(12.344), "$12.34");
        assert_eq!(money(0.0), "$0.00");
        assert_eq!(money(1234567.891), "$1,234,567.89");
    }

    fn spend() -> Value {
        json!({
            "workspace": "flagon-io",
            "person": { "id": "usr_1", "username": "syntaqx", "own": true },
            "since": "2026-09-23",
            "until": "2026-10-22",
            "cost_usd": 12.34,
            "landed_usd": 9.10,
            "sessions": 41,
            "unknown_sessions": 3,
            "rows": [
                { "day": "2026-10-21", "repo": "flagon-io/g1t", "item": 390, "harness": "claude_code", "model": "m1", "landed": true, "sessions": 6, "cost_usd": 5.0 },
                { "day": "2026-10-20", "repo": "flagon-io/g1t", "item": 390, "harness": "claude_code", "model": "m1", "landed": false, "sessions": 2, "cost_usd": 1.5 },
                { "day": "2026-10-20", "repo": null, "item": null, "harness": "codex", "model": null, "landed": false, "sessions": 1, "cost_usd": 0.5 },
                { "day": "2026-10-19", "repo": "flagon-io/web", "item": 388, "harness": "claude_code", "model": "m2", "landed": true, "sessions": 4, "cost_usd": 4.1 }
            ],
            "visibility": "owners",
            "can_see_people": false,
            "people": [],
            "workspace_usd": null,
            "workspace_people": 0
        })
    }

    #[test]
    fn the_headline_says_whose_what_it_cost_and_what_landed() {
        assert_eq!(
            headline(&spend()),
            "syntaqx's spend in flagon-io, Sep 23 – Oct 22: $12.34, $9.10 of it on work that landed (74%) · 41 sessions, 3 with no known cost"
        );
        let nothing = json!({ "workspace": "acme", "person": { "username": "ada" }, "since": "2026-10-16", "until": "2026-10-22", "cost_usd": 0.0, "sessions": 1 });
        assert_eq!(headline(&nothing), "ada's spend in acme, Oct 16 – Oct 22: $0.00 · 1 session");
    }

    #[test]
    fn rows_sum_into_groups_the_costliest_first() {
        let rows = spend()["rows"].as_array().cloned().unwrap();
        let by_item = groups(&rows, SpendBy::Item);
        let labels: Vec<&str> = by_item.iter().map(|g| g.label.as_str()).collect();
        assert_eq!(labels, ["#390", "#388", "no work item"]);
        assert_eq!(by_item[0], Group { label: "#390".to_owned(), sessions: 8, cost: 6.5, landed: 5.0 });
        let by_repo: Vec<String> = groups(&rows, SpendBy::Repo).into_iter().map(|g| g.label).collect();
        assert_eq!(by_repo, ["flagon-io/g1t", "flagon-io/web", "elsewhere"]);
        let by_model: Vec<String> = groups(&rows, SpendBy::Model).into_iter().map(|g| g.label).collect();
        assert_eq!(by_model, ["m1", "m2", "unknown model"]);
        // Days read as a timeline, the newest first.
        let by_day: Vec<String> = groups(&rows, SpendBy::Day).into_iter().map(|g| g.label).collect();
        assert_eq!(by_day, ["2026-10-21", "2026-10-20", "2026-10-19"]);
    }
}
