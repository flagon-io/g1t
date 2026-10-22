//! Cycles: a workspace's time boxes, one or two weeks long, whose
//! unfinished work rolls over by itself.
//!
//! Cycles are off until a workspace turns them on. While they are on, the
//! plan's Now *is* the current cycle: putting a work item in the cycle puts
//! it in Now, and taking it out of Now takes it out of the cycle. Next is
//! the pool the next cycle is drawn from, and a work item in Next can be
//! planned into the coming cycle ahead of time. Rank stays the only
//! priority. When a cycle's last day is over, the work service's cron
//! closes it, opens the next, and carries every work item still open in it
//! into that one, recording each carry for the cycle's report.
//!
//! Every workspace has at most one open cycle while cycles are on: the
//! current one. It is upcoming before its first day (during a cooldown,
//! say) and running from then until it closes.
//!
//! Days are `YYYY-MM-DD` in UTC, and a cycle holds both its first and its
//! last day. Reading cycles is for whoever may see the workspace's work
//! items; changing the settings needs the right to manage milestones, as
//! the plan's settings do; moving a work item into a cycle needs what
//! moving it into Now needs, and agents may not: what a cycle commits to
//! is a person's call.

use serde::{Deserialize, Serialize};

use super::WorkItem;
use crate::time::{parse_rfc3339, rfc3339};
use crate::{User, Viewer};

/// The lengths a cycle may have, in days.
pub const CYCLE_LENGTHS: [u32; 2] = [7, 14];
/// A cycle's length when the workspace has not said: two weeks.
pub const DEFAULT_CYCLE_LENGTH_DAYS: u32 = 14;
/// The day cycles start on when the workspace has not said: Monday (ISO 1).
pub const DEFAULT_CYCLE_WEEKDAY: u32 = 1;
/// The most days of cooldown between two cycles.
pub const MAX_COOLDOWN_DAYS: u32 = 14;
/// How many past cycles `list_cycles` gives when it is not told.
pub const CYCLES_LISTED: u32 = 12;
/// The most past cycles `list_cycles` gives.
pub const MAX_CYCLES_LISTED: u32 = 100;
/// The most work items a cycle's page reads.
pub const MAX_CYCLE_ITEMS: u32 = 200;
/// The most cycles one run of the cron closes for one workspace, so a cron
/// that was stopped for a long time catches up over a few runs.
pub const MAX_ROLLOVERS_PER_RUN: u32 = 26;

/// What a workspace's cycles are set to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleSettings {
    /// Off by default: Work behaves as it does without cycles.
    pub enabled: bool,
    /// 7 or 14.
    pub length_days: u32,
    /// The ISO day a cycle starts on: 1 for Monday to 7 for Sunday.
    pub starts_weekday: u32,
    /// Days between one cycle's last day and the next one's first.
    pub cooldown_days: u32,
    /// RFC 3339: when someone last changed them; none for the defaults.
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl Default for CycleSettings {
    fn default() -> Self {
        CycleSettings {
            enabled: false,
            length_days: DEFAULT_CYCLE_LENGTH_DAYS,
            starts_weekday: DEFAULT_CYCLE_WEEKDAY,
            cooldown_days: 0,
            updated_at: None,
        }
    }
}

/// Where a cycle is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CycleState {
    /// Open, before its first day: the next one, during a cooldown.
    Upcoming,
    /// Open, from its first day until it closes.
    #[default]
    Running,
    /// Over: what was still open in it carried into the next.
    Closed,
}

impl CycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            CycleState::Upcoming => "upcoming",
            CycleState::Running => "running",
            CycleState::Closed => "closed",
        }
    }

    /// The state of a cycle from `starts_on`, closed or not, on `today`.
    pub fn of(starts_on: &str, closed: bool, today: &str) -> CycleState {
        if closed {
            CycleState::Closed
        } else if today < starts_on {
            CycleState::Upcoming
        } else {
            CycleState::Running
        }
    }
}

/// A cycle of a workspace, with what it holds.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cycle {
    pub workspace: String,
    /// Numbered from 1 in each workspace.
    pub number: u32,
    /// Its first day, `YYYY-MM-DD`.
    pub starts_on: String,
    /// Its last day, `YYYY-MM-DD`.
    pub ends_on: String,
    /// RFC 3339: when it closed.
    #[serde(default)]
    pub closed_at: Option<String>,
    pub state: CycleState,
    /// Every work item it took on: those in it now, closed or not, and
    /// those carried out of it. One closed as not planned is left out.
    #[serde(default)]
    pub scope: u32,
    /// Of its scope, those closed as completed in it.
    #[serde(default)]
    pub done: u32,
    /// Those the cycle before carried into it.
    #[serde(default)]
    pub carried_in: u32,
    /// Those it ended with still open, carried into the next.
    #[serde(default)]
    pub carried_out: u32,
    /// Of its scope, those added after its first day.
    #[serde(default)]
    pub added: u32,
}

impl Cycle {
    /// How far along it is, from 0 to 100: done over scope.
    pub fn percent(&self) -> u32 {
        (self.done * 100).checked_div(self.scope).unwrap_or(0)
    }

    /// Days left on `today`, counting today: 1 on its last day, 0 once it
    /// is over; its whole length before it starts.
    pub fn days_left(&self, today: &str) -> u32 {
        days_left(&self.starts_on, &self.ends_on, today)
    }
}

/// The days of a cycle not yet opened.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleDates {
    pub number: u32,
    pub starts_on: String,
    pub ends_on: String,
}

/// A workspace's cycles: its settings, the current cycle and when the next
/// one would run, and the past ones, the latest first.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cycles {
    pub workspace: String,
    pub settings: CycleSettings,
    /// The open cycle, while cycles are on.
    #[serde(default)]
    pub current: Option<Cycle>,
    /// The cycle after the current one, as the settings would make it now.
    #[serde(default)]
    pub next: Option<CycleDates>,
    /// Closed cycles, the latest first.
    #[serde(default)]
    pub past: Vec<Cycle>,
}

/// What a cycle's page says of each of its work items, beside the work
/// item itself.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleMember {
    pub number: u32,
    /// RFC 3339: when it joined the cycle (or the one it was carried from).
    #[serde(default)]
    pub added_at: Option<String>,
    /// It joined after the cycle's first day.
    #[serde(default)]
    pub added: bool,
    /// The cycle before carried it in.
    #[serde(default)]
    pub carried_in: bool,
    /// The cycle ended with it open: it was carried into the next.
    #[serde(default)]
    pub carried_out: bool,
    /// Someone holds a live claim on it.
    #[serde(default)]
    pub claimed: bool,
    /// A session on it has not ended.
    #[serde(default)]
    pub live: bool,
    /// The agent behind its newest pull request made in a fork, such as
    /// `g1t` or `claude-code`, whatever that pull request's state.
    #[serde(default)]
    pub agent: Option<String>,
    /// Its own pull requests, by status.
    #[serde(default)]
    pub draft_pulls: u32,
    #[serde(default)]
    pub open_pulls: u32,
    #[serde(default)]
    pub merged_pulls: u32,
}

/// A cycle and its report.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleDetail {
    pub cycle: Cycle,
    pub settings: CycleSettings,
    /// Its work items the viewer may see: those in it (open ones in the
    /// plan's order, then closed ones, the latest closed first) and, for a
    /// closed cycle, those carried out of it, as they are now.
    pub items: Vec<WorkItem>,
    /// What the cycle says of each of `items`, in the same order.
    pub members: Vec<CycleMember>,
    /// For the current cycle: the work items in Next planned into the
    /// coming one, in rank order.
    #[serde(default)]
    pub planned: Vec<WorkItem>,
    /// For the current cycle: the one after it, as the settings would make
    /// it now.
    #[serde(default)]
    pub next: Option<CycleDates>,
}

/// Where `cycle_work_item` puts a work item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CycleChoice {
    /// The current cycle: Now.
    Current,
    /// The coming cycle: it waits in Next and moves into Now when the
    /// current cycle closes.
    Next,
    /// Out of either: back to Next, unplanned.
    None,
}

impl CycleChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            CycleChoice::Current => "current",
            CycleChoice::Next => "next",
            CycleChoice::None => "none",
        }
    }

    /// `current`, `next`, `none` (or `this`, `out`): any case.
    pub fn parse(name: &str) -> Option<CycleChoice> {
        match name.trim().to_ascii_lowercase().as_str() {
            "current" | "this" | "now" => Some(CycleChoice::Current),
            "next" | "coming" => Some(CycleChoice::Next),
            "none" | "out" | "" => Some(CycleChoice::None),
            _ => None,
        }
    }
}

// --- Days ----------------------------------------------------------------------

/// The days since the Unix epoch of `day` (`YYYY-MM-DD`).
pub fn day_number(day: &str) -> Option<i64> {
    let ms = parse_rfc3339(&format!("{}T00:00:00Z", day.get(..10)?))?;
    i64::try_from(ms / 86_400_000).ok()
}

/// The day (`YYYY-MM-DD`) `number` days after the Unix epoch.
pub fn day_of(number: i64) -> String {
    let ms = u64::try_from(number.max(0)).unwrap_or(0) * 86_400_000;
    rfc3339(ms)[..10].to_owned()
}

/// The day `days` after `day` (before it, when negative).
pub fn add_days(day: &str, days: i64) -> String {
    day_number(day).map_or_else(|| day.to_owned(), |number| day_of(number + days))
}

/// The ISO weekday of day `number` (1 Monday to 7 Sunday). The epoch was a
/// Thursday.
pub fn iso_weekday(number: i64) -> u32 {
    u32::try_from((number + 3).rem_euclid(7)).unwrap_or(0) + 1
}

/// The day of the ISO weekday, as people say it.
pub fn weekday_name(weekday: u32) -> &'static str {
    match weekday {
        1 => "Monday",
        2 => "Tuesday",
        3 => "Wednesday",
        4 => "Thursday",
        5 => "Friday",
        6 => "Saturday",
        7 => "Sunday",
        _ => "",
    }
}

/// `monday`, `Mon`, `1`: an ISO weekday.
pub fn parse_weekday(name: &str) -> Option<u32> {
    let name = name.trim().to_ascii_lowercase();
    if let Ok(number) = name.parse::<u32>() {
        return (1..=7).contains(&number).then_some(number);
    }
    if name.len() < 2 {
        return None;
    }
    (1..=7).find(|weekday| weekday_name(*weekday).to_ascii_lowercase().starts_with(&name))
}

/// The first day of a workspace's first cycle when it turns cycles on
/// `today`: the latest day on or before today that is `weekday`, so the
/// cycle is under way at once.
pub fn first_cycle_start(today: &str, weekday: u32) -> String {
    let Some(number) = day_number(today) else {
        return today.to_owned();
    };
    let back = (i64::from(iso_weekday(number)) - i64::from(weekday)).rem_euclid(7);
    day_of(number - back)
}

/// The last day of a cycle that starts on `starts_on` and is `length` days.
pub fn cycle_end(starts_on: &str, length: u32) -> String {
    add_days(starts_on, i64::from(length.max(1)) - 1)
}

/// The days of the cycle after one that ends on `ends_on`: the first day
/// past its cooldown that is the settings' weekday, for the settings'
/// length.
pub fn following_cycle(ends_on: &str, settings: &CycleSettings) -> (String, String) {
    let Some(end) = day_number(ends_on) else {
        return (ends_on.to_owned(), ends_on.to_owned());
    };
    let earliest = end + 1 + i64::from(settings.cooldown_days);
    let ahead = (i64::from(settings.starts_weekday) - i64::from(iso_weekday(earliest))).rem_euclid(7);
    let starts_on = day_of(earliest + ahead);
    let ends_on = cycle_end(&starts_on, settings.length_days);
    (starts_on, ends_on)
}

/// Days left in a cycle from `starts_on` to `ends_on` on `today`, counting
/// today: 1 on its last day, 0 once it is over, its whole length before it
/// starts.
pub fn days_left(starts_on: &str, ends_on: &str, today: &str) -> u32 {
    let (Some(start), Some(end), Some(now)) = (day_number(starts_on), day_number(ends_on), day_number(today)) else {
        return 0;
    };
    u32::try_from((end - now.max(start) + 1).max(0)).unwrap_or(0)
}

/// Settings as given, checked: a refusal names what is wrong.
pub fn check_cycle_settings(settings: &CycleSettings) -> Result<(), String> {
    if !CYCLE_LENGTHS.contains(&settings.length_days) {
        return Err("A cycle is 7 or 14 days long.".to_owned());
    }
    if !(1..=7).contains(&settings.starts_weekday) {
        return Err("A cycle starts on a day of the week: 1 for Monday to 7 for Sunday.".to_owned());
    }
    if settings.cooldown_days > MAX_COOLDOWN_DAYS {
        return Err(format!("A cooldown is at most {MAX_COOLDOWN_DAYS} days."));
    }
    Ok(())
}

// --- Arguments --------------------------------------------------------------

/// `list_cycles`: a workspace's cycle settings, its current cycle and the
/// next one's days, and its past cycles, the latest first: `limit` of them
/// (up to [`MAX_CYCLES_LISTED`]; [`CYCLES_LISTED`] when left out, and 0 for
/// none). Returns `Outcome<Cycles>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ListCyclesArgs {
    pub workspace: String,
    pub viewer: Viewer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// `get_cycle`: a cycle and its report, by number, or the current one when
/// `number` is left out (refused while cycles are off). Returns
/// `Outcome<CycleDetail>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct GetCycleArgs {
    pub workspace: String,
    pub viewer: Viewer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
}

/// `configure_cycles`: changes whichever of a workspace's cycle settings
/// are given. Turning cycles on opens the first cycle, from the latest
/// start day on or before today, with everything in Now in it; turning
/// them off closes the current one without carrying anything. A new length,
/// start day or cooldown applies from the next cycle. Needs the right to
/// manage milestones. Returns `Outcome<Cycles>` without past cycles.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ConfigureCyclesArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length_days: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starts_weekday: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_days: Option<u32>,
}

/// `cycle_work_item`: puts an open work item in the current cycle (Now),
/// plans it into the coming one (it waits in Next, and moves into Now when
/// the current cycle closes), or takes it out of either (back to Next).
/// Refused while cycles are off, and for an agent: a person commits a
/// cycle. Needs the right to manage milestones, as Now does. Publishes
/// `work_item.planned`. Returns `Outcome<WorkItem>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CycleWorkItemArgs {
    pub actor: User,
    pub workspace: String,
    pub number: u32,
    pub cycle: CycleChoice,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_count_from_the_epoch_and_know_their_weekday() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_of(day_number("2026-10-21").unwrap()), "2026-10-21");
        // 2026-10-19 is a Monday, 2026-10-25 a Sunday.
        assert_eq!(iso_weekday(day_number("2026-10-19").unwrap()), 1);
        assert_eq!(iso_weekday(day_number("2026-10-25").unwrap()), 7);
        assert_eq!(add_days("2026-12-31", 1), "2027-01-01");
        assert_eq!(add_days("2026-03-01", -1), "2026-02-28");
        assert_eq!(parse_weekday("Mon"), Some(1));
        assert_eq!(parse_weekday("sunday"), Some(7));
        assert_eq!(parse_weekday("3"), Some(3));
        assert_eq!(parse_weekday("m"), None);
        assert_eq!(parse_weekday("8"), None);
    }

    #[test]
    fn the_first_cycle_is_under_way_at_once() {
        // Turned on on a Wednesday: from the Monday before.
        assert_eq!(first_cycle_start("2026-10-21", 1), "2026-10-19");
        // On the day itself: from today.
        assert_eq!(first_cycle_start("2026-10-19", 1), "2026-10-19");
        // Starting on Thursdays, turned on on a Wednesday: last Thursday.
        assert_eq!(first_cycle_start("2026-10-21", 4), "2026-10-15");
        assert_eq!(cycle_end("2026-10-19", 14), "2026-11-01");
        assert_eq!(cycle_end("2026-10-19", 7), "2026-10-25");
    }

    #[test]
    fn the_next_cycle_starts_on_the_day_after_its_cooldown() {
        let two_weeks = CycleSettings { enabled: true, ..CycleSettings::default() };
        assert_eq!(following_cycle("2026-11-01", &two_weeks), ("2026-11-02".into(), "2026-11-15".into()));
        // A week of cooldown.
        let cooled = CycleSettings { cooldown_days: 7, ..two_weeks.clone() };
        assert_eq!(following_cycle("2026-11-01", &cooled), ("2026-11-09".into(), "2026-11-22".into()));
        // Two days of cooldown: the Monday after them.
        let short = CycleSettings { cooldown_days: 2, length_days: 7, ..two_weeks.clone() };
        assert_eq!(following_cycle("2026-11-01", &short), ("2026-11-09".into(), "2026-11-15".into()));
        // The start day changed mid-cycle: the next one starts on the new day.
        let fridays = CycleSettings { starts_weekday: 5, ..two_weeks };
        assert_eq!(following_cycle("2026-11-01", &fridays), ("2026-11-06".into(), "2026-11-19".into()));
    }

    #[test]
    fn days_left_count_today() {
        assert_eq!(days_left("2026-10-19", "2026-11-01", "2026-10-29"), 4);
        assert_eq!(days_left("2026-10-19", "2026-11-01", "2026-11-01"), 1);
        assert_eq!(days_left("2026-10-19", "2026-11-01", "2026-11-02"), 0);
        // Before it starts: all of it.
        assert_eq!(days_left("2026-10-19", "2026-11-01", "2026-10-10"), 14);
        assert_eq!(CycleState::of("2026-10-19", false, "2026-10-18"), CycleState::Upcoming);
        assert_eq!(CycleState::of("2026-10-19", false, "2026-10-19"), CycleState::Running);
        assert_eq!(CycleState::of("2026-10-19", true, "2026-10-19"), CycleState::Closed);
    }

    #[test]
    fn settings_are_checked() {
        assert!(check_cycle_settings(&CycleSettings::default()).is_ok());
        assert!(check_cycle_settings(&CycleSettings { length_days: 10, ..CycleSettings::default() }).is_err());
        assert!(check_cycle_settings(&CycleSettings { starts_weekday: 0, ..CycleSettings::default() }).is_err());
        assert!(check_cycle_settings(&CycleSettings { cooldown_days: 15, ..CycleSettings::default() }).is_err());
        assert_eq!(CycleChoice::parse("This"), Some(CycleChoice::Current));
        assert_eq!(CycleChoice::parse("next"), Some(CycleChoice::Next));
        assert_eq!(CycleChoice::parse("later"), None);
        assert_eq!(serde_json::to_value(CycleChoice::None).unwrap(), "none");
        let cycle = Cycle { scope: 14, done: 9, ..Cycle::default() };
        assert_eq!(cycle.percent(), 64);
    }
}
