use crate::Viewer;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryInsightsArgs {
    pub repo_ids: Vec<String>,
    pub viewer: Viewer,
    pub from: String,
    pub until: String,
}

/// One repository's delivery: counts over the period's UTC days, and what
/// waits now. `checking` and `failed` count each open pull request once, by
/// its head's checks (statuses, check runs and g1t Actions jobs) as its
/// page adds them up; one with no checks is in neither.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct DeliveryMetrics {
    pub repo_id: String,
    pub opened: u32,
    pub merged: u32,
    pub active: u32,
    pub unreviewed: u32,
    pub checking: u32,
    pub failed: u32,
    pub queued: u32,
    pub lead_seconds: f64,
    pub review_seconds: f64,
    pub reviewed: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryInsights {
    pub projects: Vec<DeliveryMetrics>,
    pub days: Vec<DeliveryDay>,
    /// g1t Actions could not be read, so `checking` and `failed` are not known.
    pub checks_unavailable: bool,
}

#[derive(Deserialize, Serialize)]
pub struct DeliveryDay {
    pub day: String,
    pub merged: u32,
}
