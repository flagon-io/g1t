//! Datasets: the safe query layer behind dashboards (Artifacts mode).
//! Mirrors `packages/contracts/src/datasets.ts`; the tests here keep the
//! catalog the same and run both validators over `datasets.fixtures.json`.
//!
//! Not SQL: a query names a dataset from a declared catalog, one measure,
//! at most one dimension, an interval, filters on declared fields and a
//! range. The service that owns the data ([`DatasetSpec::service`]) answers
//! `query_dataset` for the viewer, over only what the viewer can read, with
//! a fixed query per measure and dimension, and caps the rows. The Rust
//! owners (work, actions, billing) validate with [`DatasetQuery::validate`]
//! before they run anything.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetId {
    Issues,
    PullRequests,
    WorkflowRuns,
    Deployments,
    Spend,
    AgentSessions,
}

impl DatasetId {
    pub const ALL: [DatasetId; 6] = [
        DatasetId::Issues,
        DatasetId::PullRequests,
        DatasetId::WorkflowRuns,
        DatasetId::Deployments,
        DatasetId::Spend,
        DatasetId::AgentSessions,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            DatasetId::Issues => "issues",
            DatasetId::PullRequests => "pull_requests",
            DatasetId::WorkflowRuns => "workflow_runs",
            DatasetId::Deployments => "deployments",
            DatasetId::Spend => "spend",
            DatasetId::AgentSessions => "agent_sessions",
        }
    }

    /// Its entry in [`DATASETS`].
    pub fn spec(self) -> &'static DatasetSpec {
        DATASETS.iter().find(|spec| spec.id == self).expect("every dataset is in the catalog")
    }
}

/// How rows are summed up. `count` takes no field; `rate` a rate field; the
/// rest a measure field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasureOp {
    Count,
    Sum,
    Avg,
    P50,
    P95,
    Rate,
}

impl MeasureOp {
    pub fn as_str(self) -> &'static str {
        match self {
            MeasureOp::Count => "count",
            MeasureOp::Sum => "sum",
            MeasureOp::Avg => "avg",
            MeasureOp::P50 => "p50",
            MeasureOp::P95 => "p95",
            MeasureOp::Rate => "rate",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Measure {
    pub op: MeasureOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Interval {
    Day,
    Week,
    Month,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Neq,
    In,
    Gte,
    Lte,
}

impl FilterOp {
    pub fn as_str(self) -> &'static str {
        match self {
            FilterOp::Eq => "eq",
            FilterOp::Neq => "neq",
            FilterOp::In => "in",
            FilterOp::Gte => "gte",
            FilterOp::Lte => "lte",
        }
    }
}

/// Text for `eq`/`neq` on a dimension, a list for `in`, a number on a
/// measure.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterValue {
    Text(String),
    Number(f64),
    List(Vec<String>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Filter {
    pub field: String,
    pub op: FilterOp,
    pub value: FilterValue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RangePreset {
    #[serde(rename = "7d")]
    Days7,
    #[serde(rename = "30d")]
    Days30,
    #[serde(rename = "90d")]
    Days90,
}

impl RangePreset {
    pub fn days(self) -> u32 {
        match self {
            RangePreset::Days7 => 7,
            RangePreset::Days30 => 30,
            RangePreset::Days90 => 90,
        }
    }
}

/// A preset counted back from now, or between two times: dates
/// (`2026-10-01`) or RFC 3339 UTC times; `to` is exclusive.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DatasetRange {
    Preset(RangePreset),
    Between { from: String, to: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DatasetQuery {
    pub dataset: DatasetId,
    pub measure: Measure,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<Interval>,
    /// Which of the dataset's time fields the range and interval use; its
    /// first when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<Vec<Filter>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<DatasetRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnType {
    String,
    Number,
    Time,
    Money,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DatasetColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ColumnType,
}

/// What `query_dataset` answers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DatasetResult {
    pub columns: Vec<DatasetColumn>,
    /// Each a string, a number or null.
    pub rows: Vec<Vec<serde_json::Value>>,
    /// More rows matched than were returned.
    pub truncated: bool,
    /// The viewer cannot read everything the query covers.
    pub partial: bool,
    /// RFC 3339.
    pub as_of: String,
}

/// The service that owns a dataset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatasetService {
    Work,
    Actions,
    Deployments,
    Billing,
    Agents,
}

impl DatasetService {
    pub fn as_str(self) -> &'static str {
        match self {
            DatasetService::Work => "work",
            DatasetService::Actions => "actions",
            DatasetService::Deployments => "deployments",
            DatasetService::Billing => "billing",
            DatasetService::Agents => "agents",
        }
    }
}

/// What a viewer needs to query a dataset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatasetNeeds {
    Member,
    /// The workspace's billing role.
    Billing,
}

impl DatasetNeeds {
    pub fn as_str(self) -> &'static str {
        match self {
            DatasetNeeds::Member => "member",
            DatasetNeeds::Billing => "billing",
        }
    }
}

#[derive(Debug)]
pub struct DatasetSpec {
    pub id: DatasetId,
    pub label: &'static str,
    pub service: DatasetService,
    pub needs: DatasetNeeds,
    /// Time fields, the default first.
    pub times: &'static [&'static str],
    /// Text fields to group and filter by.
    pub dimensions: &'static [&'static str],
    /// Number fields for sum, avg, p50, p95, and number filters.
    pub measures: &'static [&'static str],
    /// Yes-or-no fields `rate` gives the share of.
    pub rates: &'static [&'static str],
}

/// The catalog.
pub const DATASETS: [DatasetSpec; 6] = [
    DatasetSpec {
        id: DatasetId::Issues,
        label: "Issues",
        service: DatasetService::Work,
        needs: DatasetNeeds::Member,
        times: &["created_at", "closed_at"],
        dimensions: &["repo", "label", "state", "author_kind", "assignee_kind", "milestone"],
        measures: &["time_to_close_hours", "comments"],
        rates: &["closed"],
    },
    DatasetSpec {
        id: DatasetId::PullRequests,
        label: "Pull requests",
        service: DatasetService::Work,
        needs: DatasetNeeds::Member,
        times: &["created_at", "merged_at", "closed_at"],
        dimensions: &["repo", "label", "state", "author_kind", "base_branch"],
        measures: &["cycle_time_hours", "time_to_first_review_hours", "review_count", "additions", "deletions", "changed_files"],
        rates: &["merged"],
    },
    DatasetSpec {
        id: DatasetId::WorkflowRuns,
        label: "Workflow runs",
        service: DatasetService::Actions,
        needs: DatasetNeeds::Member,
        times: &["started_at", "completed_at"],
        dimensions: &["repo", "workflow", "branch", "event", "conclusion", "runner_kind"],
        measures: &["duration_seconds", "queue_seconds"],
        rates: &["succeeded"],
    },
    DatasetSpec {
        id: DatasetId::Deployments,
        label: "Deployments",
        service: DatasetService::Deployments,
        needs: DatasetNeeds::Member,
        times: &["created_at"],
        dimensions: &["repo", "project", "environment", "state"],
        measures: &["duration_seconds", "time_to_restore_hours"],
        rates: &["failed"],
    },
    DatasetSpec {
        id: DatasetId::Spend,
        label: "Spend",
        service: DatasetService::Billing,
        needs: DatasetNeeds::Billing,
        times: &["day"],
        dimensions: &["product", "project", "person", "model"],
        measures: &["amount_micros"],
        rates: &[],
    },
    DatasetSpec {
        id: DatasetId::AgentSessions,
        label: "Agent sessions",
        service: DatasetService::Agents,
        needs: DatasetNeeds::Member,
        times: &["started_at"],
        dimensions: &["agent", "repo", "outcome", "model", "trigger"],
        measures: &["duration_seconds", "cost_micros", "tokens"],
        rates: &["succeeded"],
    },
];

/// The most rows a query returns.
pub const MAX_ROWS: u32 = 100;
/// The most filters on one query.
pub const MAX_FILTERS: usize = 10;
/// The most values in an `in` filter.
pub const MAX_IN_VALUES: usize = 50;
/// The longest `{ from, to }` range, in days.
pub const MAX_RANGE_DAYS: u64 = 366;

const DAY_MS: u64 = 86_400_000;

/// A range end as milliseconds since the epoch: a real date (`2026-10-01`)
/// or an RFC 3339 UTC time with at most milliseconds. `None` otherwise.
pub fn range_time(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u64> {
        let part = text.get(range)?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let full = if bytes.len() == 10 {
        format!("{text}T00:00:00Z")
    } else {
        // T hh:mm:ss, optional .f{1,3}, Z.
        if bytes.len() < 20 || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' || *bytes.last()? != b'Z' {
            return None;
        }
        let (hour, minute, second) = (digits(11..13)?, digits(14..16)?, digits(17..19)?);
        if hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        match bytes.len() {
            20 => {}
            22..=24 if bytes[19] == b'.' => {
                digits(20..bytes.len() - 1)?;
            }
            _ => return None,
        }
        text.to_owned()
    };
    crate::time::parse_rfc3339(&full)
}

fn days_in_month(year: u64, month: u64) -> u64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

impl DatasetQuery {
    /// What is wrong with it, if anything: the same rules, and the same
    /// words, as `datasetQueryError` in TypeScript. It checks the query
    /// against the catalog only; who may run it is the owning service's to
    /// decide.
    pub fn validate(&self) -> Result<(), String> {
        let spec = self.dataset.spec();
        let name = self.dataset.as_str();
        let field = self.measure.field.as_deref();
        match self.measure.op {
            MeasureOp::Count => {
                if field.is_some() {
                    return Err("count takes no field.".to_owned());
                }
            }
            MeasureOp::Rate => {
                let Some(field) = field else { return Err("rate needs a field.".to_owned()) };
                if !spec.rates.contains(&field) {
                    return Err(format!("{name} has no yes-or-no field {field} to take the rate of."));
                }
            }
            op => {
                let Some(field) = field else { return Err(format!("{} needs a field.", op.as_str())) };
                if !spec.measures.contains(&field) {
                    return Err(format!("{name} has no number field {field}."));
                }
            }
        }
        if let Some(group_by) = self.group_by.as_deref()
            && !spec.dimensions.contains(&group_by)
        {
            return Err(format!("{name} can't be grouped by {group_by}."));
        }
        if let Some(time) = self.time.as_deref()
            && !spec.times.contains(&time)
        {
            return Err(format!("{name} has no time field {time}."));
        }
        let filters = self.filters.as_deref().unwrap_or_default();
        if filters.len() > MAX_FILTERS {
            return Err(format!("A query takes at most {MAX_FILTERS} filters."));
        }
        for filter in filters {
            let (field, op) = (filter.field.as_str(), filter.op.as_str());
            if spec.dimensions.contains(&field) {
                match (filter.op, &filter.value) {
                    (FilterOp::In, FilterValue::List(values)) if !values.is_empty() && values.len() <= MAX_IN_VALUES => {}
                    (FilterOp::In, _) => return Err(format!("in on {field} takes a list of 1 to {MAX_IN_VALUES} values.")),
                    (FilterOp::Eq | FilterOp::Neq, FilterValue::Text(_)) => {}
                    (FilterOp::Eq | FilterOp::Neq, _) => return Err(format!("{op} on {field} takes text.")),
                    _ => return Err(format!("{field} is text: filter it with eq, neq or in.")),
                }
            } else if spec.measures.contains(&field) {
                match (filter.op, &filter.value) {
                    (FilterOp::In, _) => return Err(format!("{field} is a number: filter it with eq, neq, gte or lte.")),
                    (_, FilterValue::Number(n)) if n.is_finite() => {}
                    _ => return Err(format!("{op} on {field} takes a number.")),
                }
            } else {
                return Err(format!("{name} can't be filtered by {field}."));
            }
        }
        if let Some(DatasetRange::Between { from, to }) = &self.range {
            let (Some(from), Some(to)) = (range_time(from), range_time(to)) else {
                return Err("A range's from and to are dates or RFC 3339 UTC times.".to_owned());
            };
            if from >= to {
                return Err("A range's from comes before its to.".to_owned());
            }
            if to - from > MAX_RANGE_DAYS * DAY_MS {
                return Err(format!("A range is at most {MAX_RANGE_DAYS} days."));
            }
        }
        if let Some(limit) = self.limit
            && !(1..=MAX_ROWS).contains(&limit)
        {
            return Err(format!("limit is between 1 and {MAX_ROWS}."));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two validators agree on every case in the shared fixtures.
    #[test]
    fn agrees_with_the_typescript_validator_on_the_fixtures() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!("../../../packages/contracts/src/datasets.fixtures.json")).unwrap();
        let cases = fixtures["cases"].as_array().unwrap();
        assert!(cases.len() > 20);
        for case in cases {
            let outcome = serde_json::from_value::<DatasetQuery>(case["query"].clone())
                .map_err(|_| "*".to_owned())
                .and_then(|query| query.validate());
            match case["error"].as_str() {
                None => assert_eq!(outcome, Ok(()), "{}", case["query"]),
                Some("*") => assert!(outcome.is_err(), "{} should be refused", case["query"]),
                Some(error) => assert_eq!(outcome, Err(error.to_owned()), "{}", case["query"]),
            }
        }
    }

    /// The site's copy of the catalog names the same datasets, services and
    /// fields, in the same order.
    #[test]
    fn the_typescript_mirror_has_the_same_catalog() {
        let ts = include_str!("../../../packages/contracts/src/datasets.ts");
        let catalog = ts
            .split_once("export const DATASETS: Record<DatasetId, DatasetSpec> = {")
            .and_then(|(_, rest)| rest.split_once("\n};"))
            .map(|(table, _)| table)
            .expect("DATASETS in datasets.ts");
        let quoted = |line: &str, key: &str| -> Vec<String> {
            let start = format!("{key}: [");
            let list = line.split_once(&start).and_then(|(_, rest)| rest.split_once(']')).map(|(list, _)| list).unwrap_or_else(|| panic!("{key} in {line}"));
            list.split('"').skip(1).step_by(2).map(str::to_owned).collect()
        };
        let lines: Vec<&str> = catalog.lines().filter(|line| line.contains("service:")).collect();
        assert_eq!(lines.len(), DATASETS.len());
        for (line, spec) in lines.iter().zip(DATASETS.iter()) {
            assert!(line.trim_start().starts_with(&format!("{}: {{", spec.id.as_str())), "{line}");
            assert!(line.contains(&format!("label: \"{}\"", spec.label)), "{line}");
            assert!(line.contains(&format!("service: \"{}\"", spec.service.as_str())), "{line}");
            assert!(line.contains(&format!("needs: \"{}\"", spec.needs.as_str())), "{line}");
            assert_eq!(quoted(line, "times"), spec.times, "{line}");
            assert_eq!(quoted(line, "dimensions"), spec.dimensions, "{line}");
            assert_eq!(quoted(line, "measures"), spec.measures, "{line}");
            assert_eq!(quoted(line, "rates"), spec.rates, "{line}");
        }
        for (name, value) in [("DATASET_MAX_ROWS", MAX_ROWS as usize), ("DATASET_MAX_FILTERS", MAX_FILTERS), ("DATASET_MAX_IN_VALUES", MAX_IN_VALUES), ("DATASET_MAX_RANGE_DAYS", MAX_RANGE_DAYS as usize)] {
            assert!(ts.contains(&format!("export const {name} = {value};")), "{name}");
        }
    }

    #[test]
    fn every_dataset_reads_back_and_has_a_time_field() {
        for id in DatasetId::ALL {
            assert_eq!(serde_json::to_value(id).unwrap(), id.as_str());
            let spec = id.spec();
            assert!(!spec.times.is_empty(), "{}", id.as_str());
            // A field is one thing: never both a dimension and a number.
            for field in spec.dimensions {
                assert!(!spec.measures.contains(field) && !spec.rates.contains(field), "{field}");
            }
        }
        assert_eq!(DatasetId::Spend.spec().needs, DatasetNeeds::Billing);
    }

    #[test]
    fn a_query_travels_snake_case() {
        let query = DatasetQuery {
            dataset: DatasetId::PullRequests,
            measure: Measure { op: MeasureOp::P95, field: Some("cycle_time_hours".to_owned()) },
            group_by: Some("repo".to_owned()),
            interval: Some(Interval::Week),
            time: None,
            filters: Some(vec![Filter { field: "state".to_owned(), op: FilterOp::Eq, value: FilterValue::Text("merged".to_owned()) }]),
            range: Some(DatasetRange::Preset(RangePreset::Days90)),
            limit: None,
        };
        let json = serde_json::to_value(&query).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "dataset": "pull_requests",
                "measure": { "op": "p95", "field": "cycle_time_hours" },
                "group_by": "repo",
                "interval": "week",
                "filters": [{ "field": "state", "op": "eq", "value": "merged" }],
                "range": "90d"
            })
        );
        assert_eq!(serde_json::from_value::<DatasetQuery>(json).unwrap(), query);
        let between: DatasetRange = serde_json::from_value(serde_json::json!({ "from": "2026-01-01", "to": "2026-02-01" })).unwrap();
        assert!(matches!(between, DatasetRange::Between { .. }));
    }

    #[test]
    fn range_times_are_real_dates_or_utc_times() {
        assert_eq!(range_time("1970-01-02"), Some(DAY_MS));
        assert_eq!(range_time("2026-10-02T05:16:19Z"), Some(1_790_918_179_000));
        assert_eq!(range_time("2026-10-02T05:16:19.5Z"), Some(1_790_918_179_500));
        assert_eq!(range_time("2024-02-29"), crate::time::parse_rfc3339("2024-02-29T00:00:00Z"));
        for bad in ["2026-02-29", "2026-04-31", "2026-13-01", "2026-10-02T24:00:00Z", "2026-10-02T05:16:19", "2026-10-02T05:16:19+02:00", "26-10-02", "2026-1-02", "today", ""] {
            assert_eq!(range_time(bad), None, "{bad}");
        }
    }
}
