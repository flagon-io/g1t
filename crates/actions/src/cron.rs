//! Five-field cron schedules, in UTC: minute, hour, day of month, month,
//! day of week. Each field takes `*`, a number, a range `a-b`, a list
//! `a,b`, and a step `*/n` or `a-b/n`; days of the week also take `mon` to
//! `sun`, and months `jan` to `dec`. For workflows' `on.schedule`.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Schedule {
    minutes: Vec<bool>,
    hours: Vec<bool>,
    days: Vec<bool>,
    months: Vec<bool>,
    weekdays: Vec<bool>,
    /// Whether day of month and day of week were each restricted: when both
    /// are, either matching is enough, as in every cron.
    days_restricted: bool,
    weekdays_restricted: bool,
}

const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/// Months by name, from 1: the empty first entry stands for 0.
const MONTHS: [&str; 13] = ["", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

fn field(text: &str, low: u32, high: u32, names: &[&str]) -> Result<(Vec<bool>, bool), String> {
    let mut set = vec![false; (high + 1) as usize];
    let value = |part: &str| -> Result<u32, String> {
        if let Some(at) = names.iter().position(|name| !name.is_empty() && part.eq_ignore_ascii_case(name)) {
            return Ok(at as u32);
        }
        part.parse::<u32>().map_err(|_| format!("`{part}` is not a number"))
    };
    for item in text.split(',') {
        let (range, step) = match item.split_once('/') {
            Some((range, step)) => (range, step.parse::<u32>().map_err(|_| format!("`{step}` is not a step"))?),
            None => (item, 1),
        };
        if step == 0 {
            return Err("a step cannot be 0".to_owned());
        }
        let (from, to) = if range == "*" {
            (low, high)
        } else if let Some((a, b)) = range.split_once('-') {
            (value(a)?, value(b)?)
        } else {
            let at = value(range)?;
            (at, if item.contains('/') { high } else { at })
        };
        // Sunday may be written 7.
        let (from, to) = if names.len() == 7 && to == 7 { (from.min(6), 6) } else { (from, to) };
        if from < low || to > high || from > to {
            return Err(format!("`{item}` is outside {low}-{high}"));
        }
        let mut at = from;
        while at <= to {
            set[at as usize] = true;
            at += step;
        }
        if names.len() == 7 && text.split(',').any(|part| part == "7") {
            set[0] = true;
        }
    }
    Ok((set, text != "*"))
}

impl Schedule {
    pub fn parse(text: &str) -> Result<Schedule, String> {
        let parts: Vec<&str> = text.split_whitespace().collect();
        let [minute, hour, day, month, weekday] = parts[..] else {
            return Err("a schedule has five fields: minute hour day month weekday, such as `0 9 * * mon`".to_owned());
        };
        let (minutes, _) = field(minute, 0, 59, &[])?;
        let (hours, _) = field(hour, 0, 23, &[])?;
        let (days, days_restricted) = field(day, 1, 31, &[])?;
        let (months, _) = field(month, 1, 12, &MONTHS)?;
        let (weekdays, weekdays_restricted) = field(weekday, 0, 6, &WEEKDAYS)?;
        Ok(Schedule {
            minutes,
            hours,
            days,
            months,
            weekdays,
            days_restricted,
            weekdays_restricted,
        })
    }

    /// Whether it fires in the minute starting at `ms` since the epoch, UTC.
    pub fn fires_at(&self, ms: u64) -> bool {
        let minutes_total = ms / 60_000;
        let minute = (minutes_total % 60) as usize;
        let hour = (minutes_total / 60 % 24) as usize;
        let days_since_epoch = (minutes_total / 60 / 24) as i64;
        // 1970-01-01 was a Thursday.
        let weekday = ((days_since_epoch + 4) % 7) as usize;
        let (_, month, day) = civil_from_days(days_since_epoch);
        let day_ok = self.days[day as usize];
        let weekday_ok = self.weekdays[weekday];
        let date_ok = match (self.days_restricted, self.weekdays_restricted) {
            (true, true) => day_ok || weekday_ok,
            _ => day_ok && weekday_ok,
        };
        self.minutes[minute] && self.hours[hour] && self.months[month as usize] && date_ok
    }

    /// Whether its minutes come closer together than
    /// [`MIN_INTERVAL_MINUTES`], counting round the hour.
    pub fn too_frequent(&self) -> bool {
        let set: Vec<usize> = (0..60).filter(|&m| self.minutes[m]).collect();
        let Some(&first) = set.first() else { return false };
        let wrap = first + 60 - set[set.len() - 1];
        set.windows(2).map(|pair| pair[1] - pair[0]).chain([wrap]).any(|gap| gap < MIN_INTERVAL_MINUTES as usize)
    }

    /// Whether a workflow on this schedule runs in the minute starting at
    /// `ms`. A schedule no more frequent than every
    /// [`MIN_INTERVAL_MINUTES`] runs when it fires. A more frequent one
    /// runs on the five-minute marks, at each one it fired at or since the
    /// last: at most every five minutes.
    pub fn runs_at(&self, ms: u64) -> bool {
        if !self.too_frequent() {
            return self.fires_at(ms);
        }
        let minute = ms / 60_000;
        minute % MIN_INTERVAL_MINUTES == 0
            && (0..MIN_INTERVAL_MINUTES).any(|back| minute >= back && self.fires_at((minute - back) * 60_000))
    }
}

/// The shortest interval a workflow's schedule runs at, in minutes.
pub const MIN_INTERVAL_MINUTES: u64 = 5;

/// The date of a day counted from 1970-01-01 (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Milliseconds at a UTC date and time.
    fn at(days_since_epoch: u64, hour: u64, minute: u64) -> u64 {
        ((days_since_epoch * 24 + hour) * 60 + minute) * 60_000
    }

    // 2026-10-05 is a Monday: 20_731 days after 1970-01-01.
    const MONDAY: u64 = 20_731;

    #[test]
    fn dates_are_worked_out() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(MONDAY as i64), (2026, 10, 5));
    }

    #[test]
    fn mondays_at_nine() {
        let schedule = Schedule::parse("0 9 * * mon").unwrap();
        assert!(schedule.fires_at(at(MONDAY, 9, 0)));
        assert!(!schedule.fires_at(at(MONDAY, 9, 1)));
        assert!(!schedule.fires_at(at(MONDAY + 1, 9, 0)));
        assert!(Schedule::parse("0 9 * * 1").unwrap().fires_at(at(MONDAY, 9, 0)));
    }

    #[test]
    fn steps_ranges_and_lists() {
        let every_quarter = Schedule::parse("*/15 * * * *").unwrap();
        assert!(every_quarter.fires_at(at(MONDAY, 3, 45)));
        assert!(!every_quarter.fires_at(at(MONDAY, 3, 44)));
        let weekdays = Schedule::parse("30 8-17/3 * * mon-fri").unwrap();
        assert!(weekdays.fires_at(at(MONDAY, 14, 30)));
        assert!(!weekdays.fires_at(at(MONDAY, 15, 30)));
        assert!(!weekdays.fires_at(at(MONDAY + 5, 14, 30)));
        let sunday = Schedule::parse("0 0 * * 7").unwrap();
        assert!(sunday.fires_at(at(MONDAY + 6, 0, 0)));
        // MONDAY is in October.
        assert!(Schedule::parse("0 9 * oct mon").unwrap().fires_at(at(MONDAY, 9, 0)));
        assert!(!Schedule::parse("0 9 * jan-sep *").unwrap().fires_at(at(MONDAY, 9, 0)));
        assert!(Schedule::parse("0 9 * * *").unwrap().fires_at(at(MONDAY, 9, 0)));
    }

    #[test]
    fn day_of_month_or_week_when_both_are_given() {
        // The 1st, or any Monday.
        let schedule = Schedule::parse("0 0 1 * mon").unwrap();
        assert!(schedule.fires_at(at(MONDAY, 0, 0)));
        assert!(!schedule.fires_at(at(MONDAY + 1, 0, 0)));
    }

    #[test]
    fn schedules_run_at_most_every_five_minutes() {
        let runs = |text: &str| -> Vec<u64> {
            let schedule = Schedule::parse(text).unwrap();
            (0..30).filter(|&m| schedule.runs_at(at(MONDAY, 3, m))).collect()
        };
        assert_eq!(runs("* * * * *"), [0, 5, 10, 15, 20, 25]);
        assert_eq!(runs("*/2 * * * *"), [0, 5, 10, 15, 20, 25]);
        // Every five minutes or less often: exactly when it fires.
        assert_eq!(runs("*/5 * * * *"), [0, 5, 10, 15, 20, 25]);
        assert_eq!(runs("7,17 * * * *"), [7, 17]);
        assert_eq!(runs("*/10 * * * *"), [0, 10, 20]);
        // Two minutes close together: the later one waits for the mark.
        assert_eq!(runs("0,3 * * * *"), [0, 5]);
        // Close across the hour counts too.
        assert!(Schedule::parse("2,58 * * * *").unwrap().too_frequent());
        assert!(!Schedule::parse("0 9 * * mon").unwrap().too_frequent());
        // Every minute of one hour: the marks of that hour, and the one
        // that closes it.
        let nine = Schedule::parse("* 9 * * *").unwrap();
        assert!(nine.runs_at(at(MONDAY, 9, 0)));
        assert!(!nine.runs_at(at(MONDAY, 9, 1)));
        assert!(nine.runs_at(at(MONDAY, 10, 0)));
        assert!(!nine.runs_at(at(MONDAY, 10, 5)));
    }

    #[test]
    fn nonsense_is_refused() {
        for text in ["", "* * * *", "61 * * * *", "* * * * funday", "*/0 * * * *", "5-1 * * * *"] {
            assert!(Schedule::parse(text).is_err(), "{text}");
        }
    }
}
