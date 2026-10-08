//! When each entry of the dependency update file is checked: its
//! `schedule` (`interval`, `day`, `time`, `timezone`, `cronjob`), worked
//! out in the entry's time zone. Without a `time`, a time of day is picked
//! for the repository and kept, so that checks do not all start at once.

use g1t_actions::cron;

use crate::timezones;

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;
/// How far ahead a next run is looked for: a yearly schedule's is within it.
const HORIZON_DAYS: i64 = 400;

/// `schedule.interval`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interval {
    /// Every weekday, Monday to Friday.
    Daily,
    /// Once a week, on `day` (Monday by default).
    Weekly,
    /// The first day of each month.
    Monthly,
    /// The first day of January, April, July and October.
    Quarterly,
    /// The first day of January and July.
    Semiannually,
    /// The first day of January.
    Yearly,
    /// When `cronjob` says.
    Cron,
}

impl Interval {
    pub const ALL: [Interval; 7] = [
        Interval::Daily,
        Interval::Weekly,
        Interval::Monthly,
        Interval::Quarterly,
        Interval::Semiannually,
        Interval::Yearly,
        Interval::Cron,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Interval::Daily => "daily",
            Interval::Weekly => "weekly",
            Interval::Monthly => "monthly",
            Interval::Quarterly => "quarterly",
            Interval::Semiannually => "semiannually",
            Interval::Yearly => "yearly",
            Interval::Cron => "cron",
        }
    }

    pub fn parse(text: &str) -> Option<Interval> {
        Interval::ALL.into_iter().find(|interval| interval.as_str() == text)
    }
}

/// `schedule.day`, Sunday first, as cron counts.
pub const WEEKDAYS: [&str; 7] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/// A `schedule`, read and checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Schedule {
    pub interval: Interval,
    /// 0 for Sunday to 6 for Saturday.
    pub day: Option<u32>,
    /// Hours and minutes.
    pub time: Option<(u32, u32)>,
    /// An IANA zone name; UTC when absent.
    pub timezone: Option<String>,
    /// For `cron`: five fields, read from `cronjob`.
    pub cron: Option<String>,
}

/// Days counted from 1970-01-01 to a date (Howard Hinnant's algorithm).
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day counted from 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// 0 for Sunday.
fn weekday(days: i64) -> u32 {
    (days + 4).rem_euclid(7) as u32
}

/// `hh:mm`, 00:00 to 23:59.
pub fn parse_time(text: &str) -> Option<(u32, u32)> {
    let (hours, minutes) = text.trim().split_once(':')?;
    if hours.len() != 2 || minutes.len() != 2 {
        return None;
    }
    let (hours, minutes) = (hours.parse::<u32>().ok()?, minutes.parse::<u32>().ok()?);
    (hours < 24 && minutes < 60).then_some((hours, minutes))
}

/// A time of day said the way people say it: `5pm`, `5:30 pm`, `17:00`,
/// `noon`, `midnight`.
fn spoken_time(text: &str) -> Option<(u32, u32)> {
    let text = text.trim();
    match text {
        "noon" => return Some((12, 0)),
        "midnight" => return Some((0, 0)),
        _ => {}
    }
    let (clock, half) = if let Some(clock) = text.strip_suffix("am") {
        (clock.trim(), Some(false))
    } else if let Some(clock) = text.strip_suffix("pm") {
        (clock.trim(), Some(true))
    } else {
        (text, None)
    };
    let (hours, minutes) = match clock.split_once(':') {
        Some((hours, minutes)) if minutes.len() == 2 => (hours.parse::<u32>().ok()?, minutes.parse::<u32>().ok()?),
        Some(_) => return None,
        None => (clock.parse::<u32>().ok()?, 0),
    };
    if minutes > 59 {
        return None;
    }
    let hours = match half {
        Some(pm) if (1..=12).contains(&hours) => hours % 12 + if pm { 12 } else { 0 },
        Some(_) => return None,
        None if hours < 24 && clock.contains(':') => hours,
        None => return None,
    };
    Some((hours, minutes))
}

/// `cronjob` as five cron fields: a cron expression as it is, or one of
/// the natural forms: `every day at 5pm`, `every weekday at 9:30am`,
/// `every monday at 09:00`, `every hour`, `every 6 hours`.
pub fn cronjob(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.split_whitespace().count() == 5 {
        return cron::Schedule::parse(text).map(|_| text.split_whitespace().collect::<Vec<_>>().join(" "));
    }
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    let unclear = || format!("`{text}` is neither a cron expression, such as `0 9 * * 1`, nor a schedule g1t reads, such as `every day at 5pm`.");
    let Some(("every", rest)) = words.split_first().map(|(first, rest)| (*first, rest)) else {
        return Err(unclear());
    };
    match rest {
        ["hour"] => return Ok("0 * * * *".to_owned()),
        [n, "hours"] => {
            let n: u32 = n.parse().map_err(|_| unclear())?;
            if !(1..=23).contains(&n) {
                return Err(unclear());
            }
            return Ok(format!("0 */{n} * * *"));
        }
        _ => {}
    }
    let at = rest.iter().position(|word| *word == "at").ok_or_else(unclear)?;
    let (when, time) = (&rest[..at], rest[at + 1..].join(" "));
    let (hours, minutes) = spoken_time(&time).ok_or_else(unclear)?;
    let days = match when {
        ["day"] => "*".to_owned(),
        ["weekday"] => "1-5".to_owned(),
        [name] => {
            let name = name.strip_suffix('s').filter(|bare| WEEKDAYS.contains(bare)).unwrap_or(name);
            WEEKDAYS.iter().position(|day| *day == name).ok_or_else(unclear)?.to_string()
        }
        _ => return Err(unclear()),
    };
    Ok(format!("{minutes} {hours} * * {days}"))
}

/// The time of day a schedule without `time` runs at, picked from `seed`
/// (the repository and entry) so it stays the same.
pub fn default_time(seed: &str) -> (u32, u32) {
    // FNV-1a.
    let mut hash: u32 = 0x811c_9dc5;
    for byte in seed.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    let minute = hash % (24 * 60);
    (minute / 60, minute % 60)
}

/// UTC milliseconds for a local time in `zone`.
fn to_utc(zone: &str, local: i64) -> i64 {
    let guess = local - i64::from(timezones::offset_minutes(zone, local.max(0) as u64)) * MINUTE_MS;
    local - i64::from(timezones::offset_minutes(zone, guess.max(0) as u64)) * MINUTE_MS
}

impl Schedule {
    fn zone(&self) -> &str {
        self.timezone.as_deref().unwrap_or("UTC")
    }

    fn runs_on(&self, days: i64) -> bool {
        let (_, month, day) = civil_from_days(days);
        match self.interval {
            Interval::Daily => (1..=5).contains(&weekday(days)),
            Interval::Weekly => weekday(days) == self.day.unwrap_or(1),
            Interval::Monthly => day == 1,
            Interval::Quarterly => day == 1 && matches!(month, 1 | 4 | 7 | 10),
            Interval::Semiannually => day == 1 && matches!(month, 1 | 7),
            Interval::Yearly => day == 1 && month == 1,
            Interval::Cron => false,
        }
    }

    /// The first time after `after_ms` the entry runs, in UTC
    /// milliseconds. `seed` picks the time of day when `time` is absent.
    pub fn next_run(&self, after_ms: u64, seed: &str) -> Option<u64> {
        let after = after_ms as i64;
        let zone = self.zone();
        let local_now = after + i64::from(timezones::offset_minutes(zone, after_ms)) * MINUTE_MS;
        if self.interval == Interval::Cron {
            let schedule = cron::Schedule::parse(self.cron.as_deref()?).ok()?;
            let mut local = (local_now.div_euclid(MINUTE_MS) + 1) * MINUTE_MS;
            let end = local + HORIZON_DAYS * DAY_MS;
            while local < end {
                if schedule.fires_at(local as u64) {
                    let utc = to_utc(zone, local);
                    if utc > after {
                        return Some(utc as u64);
                    }
                }
                local += MINUTE_MS;
            }
            return None;
        }
        let (hours, minutes) = self.time.unwrap_or_else(|| default_time(seed));
        let today = local_now.div_euclid(DAY_MS);
        (today - 1..today + HORIZON_DAYS).find_map(|days| {
            if !self.runs_on(days) {
                return None;
            }
            let utc = to_utc(zone, days * DAY_MS + i64::from(hours) * 3_600_000 + i64::from(minutes) * MINUTE_MS);
            (utc > after).then_some(utc as u64)
        })
    }

    /// The schedule in words: "Weekdays at 05:00 (UTC)".
    pub fn describe(&self, seed: &str) -> String {
        let zone = self.zone();
        if self.interval == Interval::Cron {
            return format!("Cron `{}` ({zone})", self.cron.as_deref().unwrap_or_default());
        }
        let (hours, minutes) = self.time.unwrap_or_else(|| default_time(seed));
        let at = format!("{hours:02}:{minutes:02} ({zone})");
        let picked = if self.time.is_none() { ", a time picked for this repository" } else { "" };
        let when = match self.interval {
            Interval::Daily => "Weekdays".to_owned(),
            Interval::Weekly => {
                let day = WEEKDAYS[self.day.unwrap_or(1) as usize];
                format!("{}{}s", day[..1].to_uppercase(), &day[1..])
            }
            Interval::Monthly => "The 1st of each month".to_owned(),
            Interval::Quarterly => "The 1st of January, April, July and October".to_owned(),
            Interval::Semiannually => "The 1st of January and July".to_owned(),
            Interval::Yearly => "January 1st".to_owned(),
            Interval::Cron => unreachable!(),
        };
        format!("{when} at {at}{picked}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::time::{parse_rfc3339, rfc3339};

    fn at(text: &str) -> u64 {
        parse_rfc3339(text).unwrap()
    }

    fn schedule(interval: Interval) -> Schedule {
        Schedule { interval, day: None, time: Some((5, 0)), timezone: None, cron: None }
    }

    fn next(schedule: &Schedule, after: &str) -> String {
        rfc3339(schedule.next_run(at(after), "seed").unwrap())
    }

    #[test]
    fn dates_round_trip() {
        for days in [-1000, 0, 19_000, 20_733, 60_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(civil_from_days(days_from_civil(2026, 10, 7)), (2026, 10, 7));
        // 2026-10-07 is a Wednesday.
        assert_eq!(weekday(days_from_civil(2026, 10, 7)), 3);
    }

    #[test]
    fn daily_runs_on_weekdays() {
        let daily = schedule(Interval::Daily);
        // Wednesday 04:00 runs at 05:00 the same day; 06:00 runs Thursday.
        assert_eq!(next(&daily, "2026-10-07T04:00:00Z"), "2026-10-07T05:00:00.000Z");
        assert_eq!(next(&daily, "2026-10-07T06:00:00Z"), "2026-10-08T05:00:00.000Z");
        // Friday evening goes to Monday.
        assert_eq!(next(&daily, "2026-10-09T06:00:00Z"), "2026-10-12T05:00:00.000Z");
    }

    #[test]
    fn weekly_monthly_and_longer() {
        let mut weekly = schedule(Interval::Weekly);
        assert_eq!(next(&weekly, "2026-10-07T00:00:00Z"), "2026-10-12T05:00:00.000Z");
        weekly.day = Some(5);
        assert_eq!(next(&weekly, "2026-10-07T00:00:00Z"), "2026-10-09T05:00:00.000Z");
        assert_eq!(next(&schedule(Interval::Monthly), "2026-10-07T00:00:00Z"), "2026-11-01T05:00:00.000Z");
        assert_eq!(next(&schedule(Interval::Quarterly), "2026-10-07T00:00:00Z"), "2027-01-01T05:00:00.000Z");
        assert_eq!(next(&schedule(Interval::Quarterly), "2026-02-07T00:00:00Z"), "2026-04-01T05:00:00.000Z");
        assert_eq!(next(&schedule(Interval::Semiannually), "2026-02-07T00:00:00Z"), "2026-07-01T05:00:00.000Z");
        assert_eq!(next(&schedule(Interval::Yearly), "2026-02-07T00:00:00Z"), "2027-01-01T05:00:00.000Z");
    }

    #[test]
    fn time_zones_move_the_hour_with_daylight_saving() {
        let mut daily = schedule(Interval::Daily);
        daily.time = Some((9, 30));
        daily.timezone = Some("America/New_York".into());
        // Summer: 09:30 EDT is 13:30 UTC; winter: 14:30 UTC.
        assert_eq!(next(&daily, "2026-07-01T00:00:00Z"), "2026-07-01T13:30:00.000Z");
        assert_eq!(next(&daily, "2026-12-01T00:00:00Z"), "2026-12-01T14:30:00.000Z");
        // Late in the UTC day it is still the same local day.
        assert_eq!(next(&daily, "2026-07-01T03:00:00Z"), "2026-07-01T13:30:00.000Z");
        let mut tokyo = schedule(Interval::Weekly);
        tokyo.time = Some((8, 0));
        tokyo.timezone = Some("Asia/Tokyo".into());
        // Monday 08:00 in Tokyo is Sunday 23:00 UTC.
        assert_eq!(next(&tokyo, "2026-10-07T00:00:00Z"), "2026-10-11T23:00:00.000Z");
    }

    #[test]
    fn cron_runs_in_its_zone() {
        let mut cron = schedule(Interval::Cron);
        cron.cron = Some("0 9 * * 1-5".into());
        assert_eq!(next(&cron, "2026-10-07T09:00:00Z"), "2026-10-08T09:00:00.000Z");
        cron.timezone = Some("America/New_York".into());
        assert_eq!(next(&cron, "2026-10-07T00:00:00Z"), "2026-10-07T13:00:00.000Z");
        cron.cron = Some("30 2 1 1 *".into());
        assert_eq!(next(&cron, "2026-10-07T00:00:00Z"), "2027-01-01T07:30:00.000Z");
    }

    #[test]
    fn without_a_time_one_is_picked_and_kept() {
        let mut daily = schedule(Interval::Daily);
        daily.time = None;
        let (hours, minutes) = default_time("rep_1:npm:/");
        assert!(hours < 24 && minutes < 60);
        assert_eq!(default_time("rep_1:npm:/"), (hours, minutes));
        assert_ne!(default_time("rep_1:npm:/"), default_time("rep_2:npm:/"));
        assert!(daily.describe("rep_1:npm:/").contains("a time picked for this repository"));
    }

    #[test]
    fn cronjobs_take_cron_or_words() {
        assert_eq!(cronjob("0 9 * * *").unwrap(), "0 9 * * *");
        assert_eq!(cronjob("every day at 5pm").unwrap(), "0 17 * * *");
        assert_eq!(cronjob("every weekday at 9:30am").unwrap(), "30 9 * * 1-5");
        assert_eq!(cronjob("Every Monday at 09:00").unwrap(), "0 9 * * 1");
        assert_eq!(cronjob("every fridays at noon").unwrap(), "0 12 * * 5");
        assert_eq!(cronjob("every 6 hours").unwrap(), "0 */6 * * *");
        assert_eq!(cronjob("every hour").unwrap(), "0 * * * *");
        assert!(cronjob("0 9 * *").unwrap_err().contains("neither a cron expression"));
        assert!(cronjob("61 9 * * *").is_err());
        assert!(cronjob("every day at 25pm").is_err());
        assert!(cronjob("sometimes").is_err());
    }

    #[test]
    fn times_and_words() {
        assert_eq!(parse_time("03:00"), Some((3, 0)));
        assert_eq!(parse_time("23:59"), Some((23, 59)));
        assert_eq!(parse_time("24:00"), None);
        assert_eq!(parse_time("3:00"), None);
        let mut weekly = schedule(Interval::Weekly);
        weekly.day = Some(0);
        assert_eq!(weekly.describe("x"), "Sundays at 05:00 (UTC)");
        assert_eq!(schedule(Interval::Daily).describe("x"), "Weekdays at 05:00 (UTC)");
        let mut cron = schedule(Interval::Cron);
        cron.cron = Some("0 9 * * *".into());
        cron.timezone = Some("Europe/London".into());
        assert_eq!(cron.describe("x"), "Cron `0 9 * * *` (Europe/London)");
    }
}
