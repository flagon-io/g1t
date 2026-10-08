//! Merge windows: when a branch takes merges, by the week, with freezes and
//! exceptions on a calendar.

use g1t_contracts::rules::{MergeWindowRule, Period, Weekday};
use g1t_contracts::time::{parse_rfc3339, rfc3339};

const MINUTE: u64 = 60 * 1000;
const DAY_MINUTES: i64 = 24 * 60;

/// A time zone's offset from UTC in minutes: `+02:00`, `-0530`, `UTC`.
pub fn offset_minutes(zone: &str) -> Option<i64> {
    let zone = zone.trim();
    if zone.is_empty() || zone.eq_ignore_ascii_case("utc") || zone == "Z" {
        return Some(0);
    }
    let zone = zone.strip_prefix("UTC").or_else(|| zone.strip_prefix("utc")).unwrap_or(zone);
    let (sign, rest) = match zone.chars().next()? {
        '+' => (1, &zone[1..]),
        '-' => (-1, &zone[1..]),
        _ => return None,
    };
    let (hours, minutes) = match rest.split_once(':') {
        Some((hours, minutes)) => (hours, minutes),
        None if rest.len() == 4 => rest.split_at(2),
        None => (rest, "0"),
    };
    let (hours, minutes) = (hours.parse::<i64>().ok()?, minutes.parse::<i64>().ok()?);
    if hours > 14 || minutes > 59 {
        return None;
    }
    Some(sign * (hours * 60 + minutes))
}

/// Minutes into the day of `HH:MM`.
pub fn clock(text: &str) -> Option<i64> {
    let (hours, minutes) = text.trim().split_once(':')?;
    let (hours, minutes) = (hours.parse::<i64>().ok()?, minutes.parse::<i64>().ok()?);
    if hours > 24 || minutes > 59 || (hours == 24 && minutes > 0) {
        return None;
    }
    Some(hours * 60 + minutes)
}

/// The day of the week of a count of days since 1970-01-01, a Thursday.
fn weekday(days: i64) -> Weekday {
    Weekday::ALL[(days + 3).rem_euclid(7) as usize]
}

fn in_period(period: &Period, now: u64) -> bool {
    let Some(start) = parse_rfc3339(&period.start) else { return false };
    let end = period.end.as_deref().and_then(parse_rfc3339);
    start <= now && end.is_none_or(|end| now < end)
}

/// Why merging is closed now, or `None` when it is open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Closed {
    /// A freeze covers now: its reason, and when it ends if it does.
    Frozen { reason: String, until: Option<String> },
    /// Outside every weekly window: when the next one opens, RFC 3339.
    Outside { opens: Option<String> },
}

/// Whether merging is allowed at `now` (milliseconds since the epoch).
pub fn closed(rule: &MergeWindowRule, now: u64) -> Option<Closed> {
    if rule.exceptions.iter().any(|period| in_period(period, now)) {
        return None;
    }
    if let Some(freeze) = rule.freezes.iter().find(|period| in_period(period, now)) {
        return Some(Closed::Frozen { reason: freeze.reason.trim().to_owned(), until: freeze.end.clone() });
    }
    if rule.windows.is_empty() {
        return None;
    }
    let offset = offset_minutes(&rule.time_zone).unwrap_or(0);
    let local = (now / MINUTE) as i64 + offset;
    if open_at(rule, local) {
        return None;
    }
    // The next minute a window opens, within a week and a day.
    let opens = (1..=(8 * DAY_MINUTES))
        .map(|ahead| local + ahead)
        .find(|minute| open_at(rule, *minute) && !open_at(rule, minute - 1))
        .map(|minute| rfc3339(((minute - offset) as u64) * MINUTE));
    Some(Closed::Outside { opens })
}

/// Whether a local minute (since the epoch) falls in a weekly window.
fn open_at(rule: &MergeWindowRule, local: i64) -> bool {
    let (day, minute) = (local.div_euclid(DAY_MINUTES), local.rem_euclid(DAY_MINUTES));
    rule.windows.iter().any(|window| {
        let (Some(start), Some(end)) = (clock(&window.start), clock(&window.end)) else {
            return false;
        };
        if start <= end {
            window.days.contains(&weekday(day)) && start <= minute && minute < end
        } else {
            // Past midnight: the evening of a listed day, or the morning after.
            (window.days.contains(&weekday(day)) && minute >= start)
                || (window.days.contains(&weekday(day - 1)) && minute < end)
        }
    })
}

/// What a closed window tells people.
pub fn explain(closed: &Closed) -> String {
    match closed {
        Closed::Frozen { reason, until } => {
            let why = if reason.is_empty() { String::new() } else { format!(" ({reason})") };
            match until {
                Some(until) => format!("Merging is frozen{why} until {until}."),
                None => format!("Merging is frozen{why} until the freeze is lifted."),
            }
        }
        Closed::Outside { opens: Some(opens) } => format!("Merging is outside the merge window; it next opens at {opens}."),
        Closed::Outside { opens: None } => "Merging is outside the merge window.".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::rules::WeeklyWindow;

    /// 2026-10-07 is a Wednesday.
    fn at(text: &str) -> u64 {
        parse_rfc3339(text).unwrap()
    }

    fn weekdays(start: &str, end: &str) -> MergeWindowRule {
        MergeWindowRule {
            windows: vec![WeeklyWindow {
                days: vec![Weekday::Mon, Weekday::Tue, Weekday::Wed, Weekday::Thu],
                start: start.into(),
                end: end.into(),
            }],
            ..MergeWindowRule::default()
        }
    }

    #[test]
    fn zones_and_clocks_parse() {
        assert_eq!(offset_minutes("UTC"), Some(0));
        assert_eq!(offset_minutes(""), Some(0));
        assert_eq!(offset_minutes("+02:00"), Some(120));
        assert_eq!(offset_minutes("-0530"), Some(-330));
        assert_eq!(offset_minutes("UTC+1"), Some(60));
        assert_eq!(offset_minutes("Europe/Paris"), None);
        assert_eq!(clock("09:30"), Some(570));
        assert_eq!(clock("24:00"), Some(1440));
        assert_eq!(clock("25:00"), None);
    }

    #[test]
    fn days_of_the_week_are_counted_from_a_thursday() {
        assert_eq!(weekday(0), Weekday::Thu);
        assert_eq!(weekday(at("2026-10-07T12:00:00Z") as i64 / 86_400_000), Weekday::Wed);
    }

    #[test]
    fn inside_the_window_merging_is_open() {
        let rule = weekdays("09:00", "17:00");
        assert_eq!(closed(&rule, at("2026-10-07T10:00:00Z")), None);
        assert_eq!(closed(&MergeWindowRule::default(), at("2026-10-10T03:00:00Z")), None);
    }

    #[test]
    fn outside_it_says_when_it_opens() {
        let rule = weekdays("09:00", "17:00");
        // Wednesday evening: Thursday morning.
        assert_eq!(
            closed(&rule, at("2026-10-07T18:00:00Z")),
            Some(Closed::Outside { opens: Some("2026-10-08T09:00:00.000Z".into()) })
        );
        // Friday: the next Monday.
        assert_eq!(
            closed(&rule, at("2026-10-09T10:00:00Z")),
            Some(Closed::Outside { opens: Some("2026-10-12T09:00:00.000Z".into()) })
        );
    }

    #[test]
    fn the_window_is_in_its_time_zone() {
        let rule = MergeWindowRule { time_zone: "-05:00".into(), ..weekdays("09:00", "17:00") };
        // 13:00 UTC is 08:00 there: not yet.
        assert!(closed(&rule, at("2026-10-07T13:00:00Z")).is_some());
        assert_eq!(closed(&rule, at("2026-10-07T15:00:00Z")), None);
    }

    #[test]
    fn a_window_can_run_past_midnight() {
        let rule = MergeWindowRule {
            windows: vec![WeeklyWindow { days: vec![Weekday::Fri], start: "22:00".into(), end: "02:00".into() }],
            ..MergeWindowRule::default()
        };
        assert_eq!(closed(&rule, at("2026-10-09T23:00:00Z")), None);
        assert_eq!(closed(&rule, at("2026-10-10T01:00:00Z")), None);
        assert!(closed(&rule, at("2026-10-10T03:00:00Z")).is_some());
    }

    #[test]
    fn freezes_close_it_and_exceptions_open_it() {
        let mut rule = weekdays("00:00", "24:00");
        rule.freezes.push(Period { start: "2026-10-07T00:00:00Z".into(), end: Some("2026-10-08T00:00:00Z".into()), reason: "Release".into() });
        rule.freezes.push(Period { start: "2026-10-12T00:00:00Z".into(), end: None, reason: String::new() });
        assert_eq!(
            explain(&closed(&rule, at("2026-10-07T10:00:00Z")).unwrap()),
            "Merging is frozen (Release) until 2026-10-08T00:00:00Z."
        );
        assert_eq!(closed(&rule, at("2026-10-08T10:00:00Z")), None);
        assert_eq!(explain(&closed(&rule, at("2026-10-13T10:00:00Z")).unwrap()), "Merging is frozen until the freeze is lifted.");
        rule.exceptions.push(Period { start: "2026-10-07T12:00:00Z".into(), end: Some("2026-10-07T13:00:00Z".into()), reason: "Hotfix".into() });
        assert_eq!(closed(&rule, at("2026-10-07T12:30:00Z")), None);
    }
}
