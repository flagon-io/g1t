//! The plan: where each open work item of a workspace stands, and in what
//! order the work is taken.
//!
//! Every open work item is on one [`Horizon`]. New ones start in Triage
//! until someone places them. Within Now, Next and Later its position is
//! its priority: there are no priority levels, only a rank, a fractional
//! key (see [`rank_between`]) so moving one item rewrites only that item.
//! Each horizon is shown within a bound, so no view of the plan grows
//! without end: Now has a soft cap the workspace sets ([`DEFAULT_NOW_CAP`]),
//! Next is shown to its top [`NEXT_SHOWN`], Later as groups, and Set aside
//! only to search.

use serde::{Deserialize, Deserializer, Serialize};

use super::WorkItem;
use crate::repos::RepoPath;
use crate::{User, Viewer};

/// Where an open work item stands in its workspace's plan.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Horizon {
    /// Not placed yet: opened by someone, filed by an agent or imported.
    #[default]
    Triage,
    /// What the workspace has chosen to do and is on.
    Now,
    /// Ranked: the top is what anyone, or any agent, takes next.
    Next,
    /// Wanted, not ranked against Next yet.
    Later,
    /// Let go: out of every view but search, and back with one move.
    SetAside,
}

impl Horizon {
    pub const ALL: [Horizon; 5] = [Horizon::Triage, Horizon::Now, Horizon::Next, Horizon::Later, Horizon::SetAside];

    pub fn as_str(self) -> &'static str {
        match self {
            Horizon::Triage => "triage",
            Horizon::Now => "now",
            Horizon::Next => "next",
            Horizon::Later => "later",
            Horizon::SetAside => "set_aside",
        }
    }

    /// Its name, as people say it.
    pub fn label(self) -> &'static str {
        match self {
            Horizon::Triage => "Triage",
            Horizon::Now => "Now",
            Horizon::Next => "Next",
            Horizon::Later => "Later",
            Horizon::SetAside => "Set aside",
        }
    }

    /// `now`, `Set aside`, `set-aside`: any case, `-`, `_` or a space.
    pub fn parse(name: &str) -> Option<Horizon> {
        let name: String = name.trim().to_ascii_lowercase().chars().map(|c| if c == '-' || c == ' ' { '_' } else { c }).collect();
        Horizon::ALL.into_iter().find(|horizon| horizon.as_str() == name)
    }

    /// Whether moving an item into it, or within it, needs the right to
    /// manage milestones rather than to triage: what the workspace commits
    /// to is decided by those who set its goals.
    pub fn committed(self) -> bool {
        self == Horizon::Now
    }
}

/// How much a piece of work is worth: the time it should take, not a
/// guess at how long it will.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Appetite {
    /// One session.
    Small,
    /// A few sessions, about a week.
    Medium,
    /// A phase: broken into smaller work items before it is taken on.
    Large,
}

impl Appetite {
    pub const ALL: [Appetite; 3] = [Appetite::Small, Appetite::Medium, Appetite::Large];

    pub fn as_str(self) -> &'static str {
        match self {
            Appetite::Small => "small",
            Appetite::Medium => "medium",
            Appetite::Large => "large",
        }
    }

    /// `S`, `M` or `L`.
    pub fn letter(self) -> &'static str {
        match self {
            Appetite::Small => "S",
            Appetite::Medium => "M",
            Appetite::Large => "L",
        }
    }

    /// `small` or `s`, any case.
    pub fn parse(name: &str) -> Option<Appetite> {
        let name = name.trim().to_ascii_lowercase();
        Appetite::ALL.into_iter().find(|appetite| appetite.as_str() == name || appetite.letter().eq_ignore_ascii_case(&name))
    }
}

/// How many work items Now holds before the plan says it is over, when the
/// workspace has not said otherwise. Past it, g1t warns; it never refuses.
pub const DEFAULT_NOW_CAP: u32 = 6;
/// The most a workspace may set Now's cap to.
pub const MAX_NOW_CAP: u32 = 50;
/// How many of Next the plan shows before "n more".
pub const NEXT_SHOWN: u32 = 10;
/// The most spend budget a work item may be given, in dollars.
pub const MAX_BUDGET_USD: f64 = 100_000.0;

/// What `Some(None)` means in a change: the field is cleared. Absent
/// leaves it as it is; JSON `null` clears it.
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `plan_work_item`: moves a work item in its workspace's plan, and sets
/// what the plan says of it. Whichever fields are given change. Placing it
/// `before` or `after` another open work item puts it next to that one, on
/// that one's horizon; `top` puts it first on its horizon; a new horizon
/// with no position puts it last there. Triaging, and anything in Next,
/// Later or Set aside, needs the Triage role on it; moving into or out of
/// Now, ranking Now, and urgent need the right to manage milestones.
/// Refused for a closed work item. Publishes `work_item.planned`.
/// Returns `Outcome<WorkItem>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PlanWorkItemArgs {
    pub actor: User,
    pub workspace: String,
    pub number: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizon: Option<Horizon>,
    /// The number of the open work item to put it just before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<u32>,
    /// The number of the open work item to put it just after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<u32>,
    /// First on its horizon.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub top: bool,
    /// `null` clears it.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub appetite: Option<Option<Appetite>>,
    /// In dollars, what an agent working on it may spend; `null` clears it.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub budget_usd: Option<Option<f64>>,
    /// First in Now, ahead of its rank, until it closes: for fires.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urgent: Option<bool>,
}

/// `get_plan`: a workspace's plan, as a member sees it: Now in full, Next
/// to its top [`NEXT_SHOWN`] (or in full, with `all`), and how many are
/// in Triage, Later and Set aside, Later grouped by the repository each
/// work item is filed in. With `repo`, only work items linked to it.
/// Returns `Outcome<Plan>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct GetPlanArgs {
    pub workspace: String,
    pub viewer: Viewer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<RepoPath>,
    /// Every one of Next, not only its top.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub all: bool,
}

/// A workspace's plan.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub workspace: String,
    /// Urgent first, then by rank.
    pub now: Vec<WorkItem>,
    /// How many Now holds before the plan says it is over.
    pub now_cap: u32,
    /// By rank, the top first.
    pub next: Vec<WorkItem>,
    /// Every open work item in Next, shown or not.
    pub next_total: u32,
    pub triage_total: u32,
    pub later_total: u32,
    /// Later, by the repository each is filed in (none for those filed in
    /// the workspace), the largest group first.
    pub later: Vec<PlanGroup>,
    pub set_aside_total: u32,
}

/// Work items of one horizon filed in one repository.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanGroup {
    /// `owner/name`; none for work items filed in the workspace.
    pub repo: Option<String>,
    pub count: u32,
}

/// `next_work_item`: the work item to take next in a workspace: the first
/// in Now nobody is on, else the top of Next, leaving out any that is
/// blocked by open work, claimed by someone, or assigned to someone other
/// than the viewer. With `repo`, only work items linked to it. Returns
/// `Outcome<Option<WorkItem>>`: none when nothing is ready.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct NextWorkItemArgs {
    pub workspace: String,
    pub viewer: Viewer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<RepoPath>,
}

/// `configure_plan`: sets how many work items Now holds before the plan
/// says it is over (1 to [`MAX_NOW_CAP`]). Needs the right to manage
/// milestones. Returns `Outcome<Plan>` without its work items.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ConfigurePlanArgs {
    pub actor: User,
    pub workspace: String,
    pub now_cap: u32,
}

// --- Rank ---------------------------------------------------------------------

/// The digits a rank is written in, in the order SQLite compares them.
const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit(c: u8) -> usize {
    DIGITS.iter().position(|d| *d == c).unwrap_or(0)
}

/// A rank that sorts after `before` and ahead of `after` (`None`: no bound
/// on that side). Ranks are strings of base-62 digits, compared as text,
/// never ending in `0`, so there is always room between two of them.
/// `before` must sort ahead of `after` when both are given.
pub fn rank_between(before: Option<&str>, after: Option<&str>) -> String {
    let low = before.unwrap_or("").as_bytes();
    let high = after.map(str::as_bytes);
    let mut out = Vec::new();
    let mut at = 0;
    loop {
        let lo = low.get(at).map_or(0, |c| digit(*c));
        // Past the end of `after`, or below it already, there is no upper
        // bound on this digit.
        let hi = match high {
            Some(high) if out.as_slice() == &high[..at.min(high.len())] => high.get(at).map_or(DIGITS.len(), |c| digit(*c)),
            _ => DIGITS.len(),
        };
        if hi.saturating_sub(lo) > 1 {
            out.push(DIGITS[(lo + hi).div_ceil(2).min(hi - 1).max(lo + 1)]);
            return String::from_utf8(out).unwrap_or_default();
        }
        out.push(DIGITS[lo]);
        at += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn between(before: Option<&str>, after: Option<&str>) -> String {
        let rank = rank_between(before, after);
        assert!(!rank.ends_with('0'), "{rank} ends in 0");
        if let Some(before) = before {
            assert!(before < rank.as_str(), "{before} < {rank}");
        }
        if let Some(after) = after {
            assert!(rank.as_str() < after, "{rank} < {after}");
        }
        rank
    }

    #[test]
    fn a_rank_always_fits_between_two_others() {
        let first = between(None, None);
        let next = between(Some(&first), None);
        let ahead = between(None, Some(&first));
        between(Some(&ahead), Some(&first));
        between(Some(&first), Some(&next));
        // Neighbours: one digit apart, then none apart.
        between(Some("a"), Some("b"));
        between(Some("a"), Some("a1"));
        between(Some("a0z"), Some("a1"));
        between(Some("zzz"), None);
        between(None, Some("01"));
        between(None, Some("001"));
    }

    #[test]
    fn ranking_one_place_over_and_over_stays_ordered() {
        // Always before the same item: ranks grow, but keep their order.
        let mut ranks = vec![between(None, None)];
        let last = ranks[0].clone();
        let mut low: Option<String> = None;
        for _ in 0..200 {
            let rank = between(low.as_deref(), Some(&last));
            low = Some(rank.clone());
            ranks.push(rank);
        }
        // And always at the top.
        let mut top = ranks[0].clone();
        for _ in 0..200 {
            top = between(None, Some(&top));
        }
        assert!(top.len() < 60);
    }

    #[test]
    fn horizons_and_appetites_read_as_people_write_them() {
        assert_eq!(Horizon::parse("Set aside"), Some(Horizon::SetAside));
        assert_eq!(Horizon::parse("set-aside"), Some(Horizon::SetAside));
        assert_eq!(Horizon::parse(" NOW "), Some(Horizon::Now));
        assert_eq!(Horizon::parse("soon"), None);
        assert_eq!(serde_json::to_value(Horizon::SetAside).unwrap(), "set_aside");
        assert_eq!(Appetite::parse("M"), Some(Appetite::Medium));
        assert_eq!(Appetite::parse("large"), Some(Appetite::Large));
        assert_eq!(Appetite::parse("xl"), None);
    }

    #[test]
    fn a_change_tells_clearing_from_leaving_alone() {
        let args: PlanWorkItemArgs =
            serde_json::from_value(serde_json::json!({ "actor": { "id": "usr_1", "username": "ana" }, "workspace": "acme", "number": 3 }))
                .unwrap();
        assert_eq!(args.appetite, None);
        let args: PlanWorkItemArgs = serde_json::from_value(serde_json::json!({
            "actor": { "id": "usr_1", "username": "ana" }, "workspace": "acme", "number": 3, "appetite": null, "budget_usd": 25.0
        }))
        .unwrap();
        assert_eq!(args.appetite, Some(None));
        assert_eq!(args.budget_usd, Some(Some(25.0)));
    }
}
