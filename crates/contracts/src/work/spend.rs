//! What a person's harness sessions cost in a workspace (`get_spend`), and
//! who may see someone else's (`configure_spend`).
//!
//! Spend is information about work, not a score for people: everyone sees
//! their own in full; someone else's only as the workspace's
//! [`SpendVisibility`] allows; people are listed by name, never ranked by
//! what they spent; and a total over others covers at least
//! [`MIN_ROLLUP_PEOPLE`] people unless the viewer may see each person's.
use serde::{Deserialize, Serialize};

use crate::{User, Viewer};

/// The fewest people a total over others' spend covers, so it never shows
/// one person's figure to someone the workspace's setting keeps it from.
pub const MIN_ROLLUP_PEOPLE: u32 = 3;
/// How many days `get_spend` reads at most.
pub const MAX_SPEND_DAYS: u32 = 400;

/// Who sees each person's spend in a workspace, besides that person.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpendVisibility {
    /// Owners and billing managers: for budgets and plan fit.
    #[default]
    Owners,
    /// Every member.
    Members,
    /// Nobody: each person sees only their own.
    Nobody,
}

impl SpendVisibility {
    pub fn as_str(self) -> &'static str {
        match self {
            SpendVisibility::Owners => "owners",
            SpendVisibility::Members => "members",
            SpendVisibility::Nobody => "nobody",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "owners" => Some(SpendVisibility::Owners),
            "members" => Some(SpendVisibility::Members),
            "nobody" => Some(SpendVisibility::Nobody),
            _ => None,
        }
    }

    /// Whether `user` may see other people's spend in `workspace`.
    pub fn shows_people_to(self, user: &User, workspace: &str) -> bool {
        match self {
            SpendVisibility::Owners => user.manages_billing(workspace),
            SpendVisibility::Members => user.is_member(workspace),
            SpendVisibility::Nobody => false,
        }
    }
}

/// `get_spend`: what one person's harness sessions (subagents and all)
/// that started from `since` through `until` cost in `workspace`'s
/// repositories. `person` (a username) is the viewer when left out;
/// someone else needs the workspace's [`SpendVisibility`] to allow it.
/// Returns `Outcome<Spend>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct GetSpendArgs {
    pub workspace: String,
    pub viewer: Viewer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person: Option<String>,
    /// The first UTC day, `YYYY-MM-DD`; 30 days before `until` when left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    /// The last UTC day, `YYYY-MM-DD`; today when left out. At most
    /// [`MAX_SPEND_DAYS`] after `since`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

/// One person's spend over a span of days.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    pub workspace: String,
    /// Whose it is.
    pub person: SpendPerson,
    pub since: String,
    pub until: String,
    /// What their sessions of known cost cost, in dollars, estimated at
    /// list price from the tokens each reported.
    pub cost_usd: f64,
    /// Of `cost_usd`, what went into work that landed.
    pub landed_usd: f64,
    /// Their sessions, and how many of them reported no usage, so cost no
    /// known amount (an older plugin, or a harness that reports none).
    pub sessions: u32,
    pub unknown_sessions: u32,
    /// By day, repository, work item, harness, model and landed, the
    /// costliest first.
    pub rows: Vec<SpendRow>,
    /// The workspace's setting, and whether the viewer may see other
    /// people's spend under it.
    pub visibility: SpendVisibility,
    pub can_see_people: bool,
    /// Each person with spend in the span, by name (never by what they
    /// spent): only when `can_see_people`.
    pub people: Vec<PersonSpend>,
    /// Everyone's spend in the span: when `can_see_people`, or when it
    /// covers at least [`MIN_ROLLUP_PEOPLE`] people.
    pub workspace_usd: Option<f64>,
    /// How many people `workspace_usd` covers.
    pub workspace_people: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendPerson {
    pub id: String,
    pub username: String,
    /// Whether this is the viewer.
    pub own: bool,
}

/// Part of a person's spend.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct SpendRow {
    /// The UTC day its sessions started, `YYYY-MM-DD`.
    pub day: String,
    /// The repository, as `owner/name`; unset for one the viewer cannot
    /// read (someone else's spend there still counts in their total).
    pub repo: Option<String>,
    /// The work item: the one its pull request is for, else one the
    /// session claimed, landed by a push that names it in a `G1t-Session`
    /// trailer, or said it works on (a subagent with none has its root's).
    /// A session on several splits its cost evenly among them.
    pub item: Option<u32>,
    /// claude_code, codex, cursor, copilot or other.
    pub harness: String,
    pub model: Option<String>,
    /// Whether it went into work that landed: a merged pull request the
    /// session (or its root session) is tied to, or a work item a push
    /// landed whose commit names it.
    pub landed: bool,
    /// Sessions, a subagent counting as one of its own.
    pub sessions: u32,
    pub cost_usd: f64,
}

/// One person's total in the span.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct PersonSpend {
    pub id: String,
    pub username: String,
    pub sessions: u32,
    pub cost_usd: f64,
}

/// `configure_spend`: who sees each person's spend in `workspace`. Only
/// an owner may change it. Returns `Outcome<SpendSettings>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ConfigureSpendArgs {
    pub actor: User,
    pub workspace: String,
    pub visibility: SpendVisibility,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendSettings {
    pub workspace: String,
    pub visibility: SpendVisibility,
}
