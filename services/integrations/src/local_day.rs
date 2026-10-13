//! When the person asking's day began, in their own time zone (their
//! profile's IANA name, such as `America/Denver`): what "today" means in a
//! question to Ask. The runtime's `Intl` says the wall-clock time there;
//! the rest is arithmetic, tested on its own.

use g1t_contracts::time::{parse_rfc3339, rfc3339};

/// Their day: its date, and when it began as UTC milliseconds.
#[derive(Debug, PartialEq, Eq)]
pub struct Day {
    pub date: String,
    pub started: u64,
}

/// The day in `zone` at `now`, or none when the zone is unknown.
pub fn today(zone: &str, now: u64) -> Option<Day> {
    from_wallclock(&wallclock(zone, now)?, now)
}

/// From the wall-clock time in the zone at `now`, written
/// `MM/DD/YYYY, HH:MM:SS` (en-US, 24-hour), the day it is there and when it
/// began.
pub fn from_wallclock(text: &str, now: u64) -> Option<Day> {
    let (date, time) = text.split_once(", ")?;
    let mut day = date.split('/');
    let (month, day_of, year) = (day.next()?, day.next()?, day.next()?);
    let date = format!("{year:0>4}-{month:0>2}-{day_of:0>2}");
    let wall = parse_rfc3339(&format!("{date}T{}Z", time.trim()))?;
    // The zone's offset from UTC, to the minute.
    let offset = (wall as i64 - now as i64) / 60_000 * 60_000;
    let midnight = parse_rfc3339(&format!("{date}T00:00:00Z"))? as i64;
    let started = u64::try_from(midnight - offset).ok()?;
    Some(Day { date, started })
}

/// The day's start as RFC 3339, to the second.
pub fn started_at(day: &Day) -> String {
    format!("{}Z", rfc3339(day.started).chars().take(19).collect::<String>())
}

#[cfg(target_arch = "wasm32")]
fn wallclock(zone: &str, now: u64) -> Option<String> {
    use worker::js_sys::{Array, Date, Function, Object, Reflect, global};
    use worker::wasm_bindgen::{JsCast, JsValue};
    let options = Object::new();
    for (key, value) in [
        ("timeZone", zone),
        ("hourCycle", "h23"),
        ("year", "numeric"),
        ("month", "2-digit"),
        ("day", "2-digit"),
        ("hour", "2-digit"),
        ("minute", "2-digit"),
        ("second", "2-digit"),
    ] {
        Reflect::set(&options, &key.into(), &value.into()).ok()?;
    }
    // Constructed through Reflect so an unknown zone is an error, not a trap.
    let intl = Reflect::get(&global(), &"Intl".into()).ok()?;
    let class: Function = Reflect::get(&intl, &"DateTimeFormat".into()).ok()?.dyn_into().ok()?;
    let formatter = Reflect::construct(&class, &Array::of2(&"en-US".into(), &options)).ok()?;
    let format: Function = Reflect::get(&formatter, &"format".into()).ok()?.dyn_into().ok()?;
    format.call1(&formatter, &Date::new(&JsValue::from_f64(now as f64))).ok()?.as_string()
}

#[cfg(not(target_arch = "wasm32"))]
fn wallclock(_zone: &str, _now: u64) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_begins_at_local_midnight() {
        // 05:20 UTC on the 13th is 23:20 on the 12th in Denver (UTC−6).
        let now = parse_rfc3339("2026-10-13T05:20:00Z").unwrap();
        let day = from_wallclock("10/12/2026, 23:20:00", now).unwrap();
        assert_eq!(day.date, "2026-10-12");
        assert_eq!(started_at(&day), "2026-10-12T06:00:00Z");
        // East of UTC: 05:20 UTC is 14:20 in Tokyo (UTC+9), whose day began at 15:00 UTC the day before.
        let day = from_wallclock("10/13/2026, 14:20:00", now).unwrap();
        assert_eq!((day.date.as_str(), started_at(&day).as_str()), ("2026-10-13", "2026-10-12T15:00:00Z"));
        // Half-hour zones keep their minutes: India (UTC+5:30).
        let day = from_wallclock("10/13/2026, 10:50:00", now).unwrap();
        assert_eq!(started_at(&day), "2026-10-12T18:30:00Z");
        assert!(from_wallclock("nonsense", now).is_none());
    }
}
