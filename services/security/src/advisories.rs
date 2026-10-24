//! Reporting: a repository's security advisories, and the vulnerability
//! reports people send its maintainers privately. See
//! `g1t_contracts::advisories`.
//!
//! Who sees and does what: anyone who can see the repository reads its
//! published advisories and, when the repository takes private reports,
//! files one (signed out, on a public repository, with an email address).
//! Those who see findings (Write, or a security manager) see drafts,
//! withdrawn advisories and the reports. Writing, publishing and
//! withdrawing an advisory, and reviewing a report, take Admin or a
//! security manager (`ManageSecurity`). A new report tells the workspace's
//! owners and security managers at once; a published advisory tells
//! webhooks and the repository's security watchers.

use g1t_contracts::access::{self, Capability};
use g1t_contracts::advisories::*;
use g1t_contracts::repos::{GetArgs, Repo};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Security;
use crate::store::{RepoRow, Store, now, optional};
use crate::suite::link;

/// The most advisories and reports listed.
const LISTED: u32 = 200;
/// One person files at most this many reports on one repository a day,
/// and a repository holds at most this many new reports waiting: the form
/// takes no account, so it must not take a flood either.
const REPORTS_PER_DAY: u32 = 5;
const MAX_NEW_REPORTS: u32 = 50;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

/// An advisory's page: `/acme/rocket/security/advisories/G1TSA-…`.
pub fn advisory_link(repo: &RepoRow, advisory: &Advisory) -> String {
    link(repo, &format!("advisories/{}", advisory.g1tsa_id))
}

/// Text trimmed and cut to `max` characters; none when empty.
fn clean(text: Option<&str>, max: usize) -> Option<String> {
    let text: String = text.unwrap_or_default().trim().chars().take(max).collect();
    (!text.is_empty()).then_some(text)
}

/// Whether text reads as an email address: something, an @, something with a dot.
pub fn looks_like_email(text: &str) -> bool {
    let text = text.trim();
    text.len() <= 254
        && !text.contains(char::is_whitespace)
        && text
            .split_once('@')
            .is_some_and(|(user, host)| !user.is_empty() && host.contains('.') && !host.starts_with('.') && !host.ends_with('.'))
}

/// An advisory's input, checked and cleaned, or what is wrong with it.
pub fn validate(input: &AdvisoryInput) -> std::result::Result<AdvisoryInput, String> {
    let title = clean(Some(&input.title), MAX_TITLE_CHARS).ok_or("Give the advisory a title.")?;
    if !SEVERITIES.contains(&input.severity.as_str()) {
        return Err("severity is critical, high, medium or low.".to_owned());
    }
    if let Some(cve) = clean(input.cve_id.as_deref(), 32)
        && !is_cve(&cve)
    {
        return Err("cve_id looks like CVE-2026-12345.".to_owned());
    }
    if input.cvss_score.is_some_and(|score| !(0.0..=10.0).contains(&score)) {
        return Err("cvss_score is 0 to 10.".to_owned());
    }
    let credits: Vec<String> = input.credits.iter().filter_map(|credit| clean(Some(credit), 100)).take(MAX_CREDITS).collect();
    Ok(AdvisoryInput {
        title,
        description: input.description.trim().chars().take(MAX_DESCRIPTION_CHARS).collect(),
        severity: input.severity.clone(),
        cvss_vector: clean(input.cvss_vector.as_deref(), 200),
        cvss_score: input.cvss_score,
        cve_id: clean(input.cve_id.as_deref(), 32).map(|cve| cve.to_uppercase()),
        ecosystem: clean(input.ecosystem.as_deref(), 50),
        package: clean(input.package.as_deref(), 200),
        affected_versions: clean(input.affected_versions.as_deref(), MAX_RANGE_CHARS),
        patched_versions: clean(input.patched_versions.as_deref(), MAX_RANGE_CHARS),
        credits,
    })
}

/// `CVE-2026-12345`: a year and at least four digits.
fn is_cve(text: &str) -> bool {
    let upper = text.to_uppercase();
    let Some(rest) = upper.strip_prefix("CVE-") else { return false };
    let Some((year, number)) = rest.split_once('-') else { return false };
    year.len() == 4 && year.chars().all(|c| c.is_ascii_digit()) && number.len() >= 4 && number.chars().all(|c| c.is_ascii_digit())
}

/// The draft an accepted report becomes: its words, the reporter credited.
pub fn draft_from(report: &VulnerabilityReport) -> AdvisoryInput {
    AdvisoryInput {
        title: report.title.clone(),
        description: report.description.clone(),
        severity: report.severity.clone().filter(|severity| SEVERITIES.contains(&severity.as_str())).unwrap_or_else(|| "medium".to_owned()),
        credits: report.reporter.iter().chain(report.reporter_email.iter()).take(1).cloned().collect(),
        ..AdvisoryInput::default()
    }
}

/// The year of a time, for the id people quote.
fn year_of(ms: u64) -> u32 {
    rfc3339(ms).get(..4).and_then(|year| year.parse().ok()).unwrap_or(2026)
}

// --- Rows -------------------------------------------------------------------

#[derive(Deserialize)]
struct AdvisoryRow {
    id: String,
    g1tsa_id: String,
    repo_id: String,
    title: String,
    description: String,
    severity: String,
    cvss_vector: Option<String>,
    cvss_score: Option<f64>,
    cve_id: Option<String>,
    ecosystem: Option<String>,
    package: Option<String>,
    affected_versions: Option<String>,
    patched_versions: Option<String>,
    state: String,
    credits: String,
    report_id: Option<String>,
    created_by: String,
    created_at: String,
    updated_at: String,
    published_at: Option<String>,
    withdrawn_at: Option<String>,
}

impl AdvisoryRow {
    fn into_advisory(self, repo: &RepoRow) -> Advisory {
        Advisory {
            id: self.id,
            g1tsa_id: self.g1tsa_id,
            repo_id: self.repo_id,
            repo: format!("{}/{}", repo.namespace, repo.name),
            title: self.title,
            description: self.description,
            severity: self.severity,
            cvss_vector: self.cvss_vector,
            cvss_score: self.cvss_score,
            cve_id: self.cve_id,
            ecosystem: self.ecosystem,
            package: self.package,
            affected_versions: self.affected_versions,
            patched_versions: self.patched_versions,
            state: self.state,
            credits: serde_json::from_str(&self.credits).unwrap_or_default(),
            report_id: self.report_id,
            created_by: self.created_by,
            created_at: self.created_at,
            updated_at: self.updated_at,
            published_at: self.published_at,
            withdrawn_at: self.withdrawn_at,
        }
    }
}

#[derive(Deserialize)]
struct ReportRow {
    id: String,
    repo_id: String,
    reporter: Option<String>,
    reporter_email: Option<String>,
    title: String,
    description: String,
    severity: Option<String>,
    state: String,
    advisory_id: Option<String>,
    created_at: String,
    reviewed_by: Option<String>,
    reviewed_at: Option<String>,
    review_note: Option<String>,
}

impl ReportRow {
    fn into_report(self, repo: &RepoRow) -> VulnerabilityReport {
        VulnerabilityReport {
            id: self.id,
            repo_id: self.repo_id,
            repo: format!("{}/{}", repo.namespace, repo.name),
            reporter: self.reporter,
            reporter_email: self.reporter_email,
            title: self.title,
            description: self.description,
            severity: self.severity,
            state: self.state,
            advisory_id: self.advisory_id,
            created_at: self.created_at,
            reviewed_by: self.reviewed_by,
            reviewed_at: self.reviewed_at,
            review_note: self.review_note,
        }
    }
}

#[derive(Deserialize)]
struct CountRow {
    n: f64,
}

const ADVISORY_COLUMNS: &str = "id, g1tsa_id, repo_id, title, description, severity, cvss_vector, cvss_score, cve_id, ecosystem, package,
    affected_versions, patched_versions, state, credits, report_id, created_by, created_at, updated_at, published_at, withdrawn_at";
const REPORT_COLUMNS: &str = "id, repo_id, reporter, reporter_email, title, description, severity, state, advisory_id, created_at, reviewed_by, reviewed_at, review_note";

impl Store {
    /// A repository's advisories in `states`, newest first.
    pub async fn security_advisories(&self, repo: &RepoRow, states: &[&str]) -> Result<Vec<Advisory>> {
        if states.is_empty() {
            return Ok(Vec::new());
        }
        let marks = vec!["?"; states.len()].join(", ");
        let mut values: Vec<JsValue> = vec![repo.repo_id.as_str().into()];
        values.extend(states.iter().map(|state| JsValue::from(*state)));
        values.push(LISTED.into());
        let rows = self
            .db
            .prepare(format!("SELECT {ADVISORY_COLUMNS} FROM security_advisories WHERE repo_id = ? AND state IN ({marks}) ORDER BY created_at DESC LIMIT ?"))
            .bind(&values)?
            .all()
            .await?
            .results::<AdvisoryRow>()?;
        Ok(rows.into_iter().map(|row| row.into_advisory(repo)).collect())
    }

    /// One advisory by `adv_…` or `G1TSA-…` id.
    pub async fn security_advisory(&self, repo: &RepoRow, id: &str) -> Result<Option<Advisory>> {
        let column = if is_g1tsa_id(id) { "g1tsa_id" } else { "id" };
        Ok(self
            .db
            .prepare(format!("SELECT {ADVISORY_COLUMNS} FROM security_advisories WHERE repo_id = ? AND {column} = ?"))
            .bind(&[repo.repo_id.as_str().into(), id.into()])?
            .first::<AdvisoryRow>(None)
            .await?
            .map(|row| row.into_advisory(repo)))
    }

    pub async fn add_advisory(&self, repo: &RepoRow, input: &AdvisoryInput, by: &str, report_id: Option<&str>) -> Result<String> {
        let now_ms = now_ms();
        let id = new_id("adv", now_ms);
        let mut random = [0u8; 8];
        if let Err(error) = getrandom::getrandom(&mut random) {
            worker::console_error!("security: no randomness for an advisory id: {error}");
        }
        let at = rfc3339(now_ms);
        self.db
            .prepare(
                "INSERT INTO security_advisories (id, g1tsa_id, repo_id, title, description, severity, cvss_vector, cvss_score, cve_id, ecosystem,
                   package, affected_versions, patched_versions, state, credits, report_id, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                g1tsa_id(year_of(now_ms), &random).into(),
                repo.repo_id.as_str().into(),
                input.title.as_str().into(),
                input.description.as_str().into(),
                input.severity.as_str().into(),
                optional(input.cvss_vector.as_deref()),
                input.cvss_score.map_or(JsValue::NULL, JsValue::from),
                optional(input.cve_id.as_deref()),
                optional(input.ecosystem.as_deref()),
                optional(input.package.as_deref()),
                optional(input.affected_versions.as_deref()),
                optional(input.patched_versions.as_deref()),
                serde_json::to_string(&input.credits)?.into(),
                optional(report_id),
                by.into(),
                at.as_str().into(),
                at.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(id)
    }

    pub async fn update_advisory(&self, repo: &RepoRow, id: &str, input: &AdvisoryInput) -> Result<()> {
        self.db
            .prepare(
                "UPDATE security_advisories SET title = ?, description = ?, severity = ?, cvss_vector = ?, cvss_score = ?, cve_id = ?, ecosystem = ?,
                   package = ?, affected_versions = ?, patched_versions = ?, credits = ?, updated_at = ?
                 WHERE repo_id = ? AND id = ?",
            )
            .bind(&[
                input.title.as_str().into(),
                input.description.as_str().into(),
                input.severity.as_str().into(),
                optional(input.cvss_vector.as_deref()),
                input.cvss_score.map_or(JsValue::NULL, JsValue::from),
                optional(input.cve_id.as_deref()),
                optional(input.ecosystem.as_deref()),
                optional(input.package.as_deref()),
                optional(input.affected_versions.as_deref()),
                optional(input.patched_versions.as_deref()),
                serde_json::to_string(&input.credits)?.into(),
                now().into(),
                repo.repo_id.as_str().into(),
                id.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn set_advisory_state(&self, repo: &RepoRow, id: &str, state: &str) -> Result<()> {
        let at = now();
        let stamp = match state {
            "published" => "published_at = COALESCE(published_at, ?1), withdrawn_at = NULL",
            "withdrawn" => "withdrawn_at = ?1",
            _ => "published_at = published_at",
        };
        self.db
            .prepare(format!("UPDATE security_advisories SET state = ?2, updated_at = ?1, {stamp} WHERE repo_id = ?3 AND id = ?4"))
            .bind(&[at.as_str().into(), state.into(), repo.repo_id.as_str().into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn reports(&self, repo: &RepoRow, state: Option<&str>) -> Result<Vec<VulnerabilityReport>> {
        let rows = match state {
            Some(state) => self
                .db
                .prepare(format!(
                    "SELECT {REPORT_COLUMNS} FROM vulnerability_reports WHERE repo_id = ? AND state = ? ORDER BY created_at DESC LIMIT ?"
                ))
                .bind(&[repo.repo_id.as_str().into(), state.into(), LISTED.into()])?,
            None => self
                .db
                .prepare(format!(
                    "SELECT {REPORT_COLUMNS} FROM vulnerability_reports WHERE repo_id = ?
                     ORDER BY CASE state WHEN 'new' THEN 0 ELSE 1 END, created_at DESC LIMIT ?"
                ))
                .bind(&[repo.repo_id.as_str().into(), LISTED.into()])?,
        }
        .all()
        .await?
        .results::<ReportRow>()?;
        Ok(rows.into_iter().map(|row| row.into_report(repo)).collect())
    }

    pub async fn report(&self, repo: &RepoRow, id: &str) -> Result<Option<VulnerabilityReport>> {
        Ok(self
            .db
            .prepare(format!("SELECT {REPORT_COLUMNS} FROM vulnerability_reports WHERE repo_id = ? AND id = ?"))
            .bind(&[repo.repo_id.as_str().into(), id.into()])?
            .first::<ReportRow>(None)
            .await?
            .map(|row| row.into_report(repo)))
    }

    /// How many reports `reporter_key` filed on the repository since `since`,
    /// and how many new ones the repository holds.
    pub async fn report_counts(&self, repo: &RepoRow, reporter_key: &str, since: &str) -> Result<(u32, u32)> {
        let results = self
            .db
            .batch(vec![
                self.db
                    .prepare("SELECT count(*) AS n FROM vulnerability_reports WHERE repo_id = ? AND reporter_key = ? AND created_at >= ?")
                    .bind(&[repo.repo_id.as_str().into(), reporter_key.into(), since.into()])?,
                self.db
                    .prepare("SELECT count(*) AS n FROM vulnerability_reports WHERE repo_id = ? AND state = 'new'")
                    .bind(&[repo.repo_id.as_str().into()])?,
            ])
            .await?;
        let count = |at: usize| {
            results
                .get(at)
                .and_then(|result| result.results::<CountRow>().ok())
                .and_then(|rows| rows.first().map(|row| row.n as u32))
                .unwrap_or(0)
        };
        Ok((count(0), count(1)))
    }

    pub async fn add_report(
        &self,
        repo: &RepoRow,
        reporter: Option<&str>,
        email: Option<&str>,
        reporter_key: &str,
        title: &str,
        description: &str,
        severity: Option<&str>,
    ) -> Result<String> {
        let now_ms = now_ms();
        let id = new_id("vrp", now_ms);
        self.db
            .prepare(
                "INSERT INTO vulnerability_reports (id, repo_id, reporter, reporter_email, reporter_key, title, description, severity, state, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo.repo_id.as_str().into(),
                optional(reporter),
                optional(email),
                reporter_key.into(),
                title.into(),
                description.into(),
                optional(severity),
                rfc3339(now_ms).into(),
            ])?
            .run()
            .await?;
        Ok(id)
    }

    /// Settles a new report. Returns whether it was still new.
    pub async fn review_report(
        &self,
        repo: &RepoRow,
        id: &str,
        state: &str,
        by: &str,
        note: Option<&str>,
        advisory_id: Option<&str>,
    ) -> Result<bool> {
        #[derive(Deserialize)]
        struct Changed {
            #[allow(dead_code)]
            id: String,
        }
        let changed = self
            .db
            .prepare(
                "UPDATE vulnerability_reports SET state = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, advisory_id = ?
                 WHERE repo_id = ? AND id = ? AND state = 'new' RETURNING id",
            )
            .bind(&[state.into(), by.into(), now().into(), optional(note), optional(advisory_id), repo.repo_id.as_str().into(), id.into()])?
            .all()
            .await?
            .results::<Changed>()?;
        Ok(!changed.is_empty())
    }

    /// A repository purged: its advisories and reports go with it.
    pub async fn purge_advisories(&self, repo_id: &str) -> Result<()> {
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM security_advisories WHERE repo_id = ?").bind(&[repo_id.into()])?,
                self.db.prepare("DELETE FROM vulnerability_reports WHERE repo_id = ?").bind(&[repo_id.into()])?,
            ])
            .await?;
        Ok(())
    }
}

// --- The service --------------------------------------------------------------

impl Security {
    /// The repository, for someone who can see it (signed out, a public
    /// one), recorded here, with what the viewer may do in it.
    async fn visible_repo(&self, path: &g1t_contracts::repos::RepoPath, viewer: &Option<User>) -> Result<Outcome<(RepoRow, Repo)>> {
        let found: Outcome<Repo> = g1t_kit::call(&self.repos, "get", &GetArgs { path: path.clone(), viewer: viewer.clone() }).await?;
        match found {
            Outcome::Ok(repo) => {
                let row = self.store.register(&repo.id, &repo.namespace, &repo.name).await?;
                self.store.set_private(&repo.id, repo.is_private).await?;
                Ok(Outcome::Ok((row, repo)))
            }
            Outcome::Fail(_) => Ok(fail(FailureCode::NotFound, "Repository not found.")),
        }
    }

    /// The states of advisories the viewer may see: every one for those who
    /// see findings, else published ones alone.
    fn visible_states<'a>(viewer: Option<&User>, repo: &Repo, asked: Option<&'a str>) -> Vec<&'a str> {
        let all = access::can(viewer, repo, Capability::SecurityAlerts);
        match asked {
            Some(state) if ADVISORY_STATES.contains(&state) => {
                if all || state == "published" {
                    vec![state]
                } else {
                    Vec::new()
                }
            }
            Some(_) => Vec::new(),
            None if all => ADVISORY_STATES.to_vec(),
            None => vec!["published"],
        }
    }

    pub(crate) async fn list_advisories(&self, a: ListAdvisoriesArgs) -> Result<Outcome<Vec<Advisory>>> {
        let (row, repo) = match self.visible_repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let states = Self::visible_states(a.viewer.as_ref(), &repo, a.state.as_deref());
        Ok(Outcome::Ok(self.store.security_advisories(&row, &states).await?))
    }

    pub(crate) async fn get_advisory(&self, a: GetAdvisoryArgs) -> Result<Outcome<Advisory>> {
        let (row, repo) = match self.visible_repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let states = Self::visible_states(a.viewer.as_ref(), &repo, None);
        match self.store.security_advisory(&row, &a.id).await? {
            Some(advisory) if states.contains(&advisory.state.as_str()) => Ok(Outcome::Ok(advisory)),
            _ => Ok(fail(FailureCode::NotFound, "No such advisory.")),
        }
    }

    /// The repository, for an actor who manages its security.
    async fn managed_repo(&self, path: &g1t_contracts::repos::RepoPath, actor: &User) -> Result<Outcome<RepoRow>> {
        if !actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        self.member_repo(path, &Some(actor.clone()), Capability::ManageSecurity).await
    }

    pub(crate) async fn create_advisory(&self, a: CreateAdvisoryArgs) -> Result<Outcome<Advisory>> {
        let repo = match self.managed_repo(&a.repo, &a.actor).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let input = match validate(&a.advisory) {
            Ok(input) => input,
            Err(message) => return Ok(fail(FailureCode::Invalid, message)),
        };
        let id = self.store.add_advisory(&repo, &input, &a.actor.username, None).await?;
        let Some(advisory) = self.store.security_advisory(&repo, &id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such advisory."));
        };
        self.audit(
            &a.actor,
            "security_advisory.created",
            Some(&repo),
            &repo.namespace,
            None,
            &format!("Drafted advisory {}: {}", advisory.g1tsa_id, advisory.title),
        )
        .await;
        Ok(Outcome::Ok(advisory))
    }

    pub(crate) async fn update_advisory(&self, a: UpdateAdvisoryArgs) -> Result<Outcome<Advisory>> {
        let repo = match self.managed_repo(&a.repo, &a.actor).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(advisory) = self.store.security_advisory(&repo, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such advisory."));
        };
        let input = match validate(&a.advisory) {
            Ok(input) => input,
            Err(message) => return Ok(fail(FailureCode::Invalid, message)),
        };
        self.store.update_advisory(&repo, &advisory.id, &input).await?;
        let Some(advisory) = self.store.security_advisory(&repo, &advisory.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such advisory."));
        };
        self.audit(
            &a.actor,
            "security_advisory.updated",
            Some(&repo),
            &repo.namespace,
            None,
            &format!("Changed advisory {}", advisory.g1tsa_id),
        )
        .await;
        Ok(Outcome::Ok(advisory))
    }

    pub(crate) async fn set_advisory_state(&self, a: SetAdvisoryStateArgs) -> Result<Outcome<Advisory>> {
        let repo = match self.managed_repo(&a.repo, &a.actor).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(advisory) = self.store.security_advisory(&repo, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such advisory."));
        };
        let kind = match (advisory.state.as_str(), a.state.as_str()) {
            ("draft" | "withdrawn", "published") => "security_advisory.published",
            ("published", "withdrawn") => "security_advisory.withdrawn",
            (same, asked) if same == asked => return Ok(fail(FailureCode::Conflict, format!("This advisory is {same} already."))),
            (_, "published" | "withdrawn") => return Ok(fail(FailureCode::Conflict, "Only a published advisory can be withdrawn.")),
            _ => return Ok(fail(FailureCode::Invalid, "state is published or withdrawn.")),
        };
        if kind == "security_advisory.published" && advisory.description.trim().is_empty() {
            return Ok(fail(FailureCode::Invalid, "Describe the vulnerability before publishing the advisory."));
        }
        self.store.set_advisory_state(&repo, &advisory.id, &a.state).await?;
        let Some(advisory) = self.store.security_advisory(&repo, &advisory.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such advisory."));
        };
        let event = AdvisoryEvent {
            repo_id: repo.repo_id.clone(),
            id: advisory.id.clone(),
            g1tsa_id: Some(advisory.g1tsa_id.clone()),
            title: advisory.title.clone(),
            severity: Some(advisory.severity.clone()),
            state: advisory.state.clone(),
            link: advisory_link(&repo, &advisory),
            notify: Vec::new(),
        };
        self.publish_advisory(kind, &repo, &event, Some(a.actor.id.clone())).await;
        self.audit(&a.actor, kind, Some(&repo), &repo.namespace, None, &format!("Advisory {} {}", advisory.g1tsa_id, advisory.state)).await;
        Ok(Outcome::Ok(advisory))
    }

    pub(crate) async fn report_vulnerability(&self, a: ReportVulnerabilityArgs) -> Result<Outcome<VulnerabilityReport>> {
        let (repo, record) = match self.visible_repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !self.store.repo_settings(&repo.repo_id).await?.0.private_vulnerability_reporting {
            return Ok(fail(FailureCode::Conflict, "This repository does not take private vulnerability reports."));
        }
        let email = clean(a.email.as_deref(), 254).map(|email| email.to_lowercase());
        let (reporter, key) = match a.viewer.as_ref().filter(|user| !user.username.is_empty()) {
            Some(user) => (Some(user.username.to_lowercase()), format!("user:{}", user.username.to_lowercase())),
            None => {
                if record.is_private {
                    return Ok(fail(FailureCode::NotFound, "Repository not found."));
                }
                let Some(email) = email.as_deref().filter(|email| looks_like_email(email)) else {
                    return Ok(fail(FailureCode::Invalid, "Give an email address the maintainers can answer at, or sign in."));
                };
                (None, format!("email:{email}"))
            }
        };
        let Some(title) = clean(Some(&a.title), MAX_TITLE_CHARS) else {
            return Ok(fail(FailureCode::Invalid, "Give the report a title."));
        };
        let description: String = a.description.trim().chars().take(MAX_DESCRIPTION_CHARS).collect();
        if description.is_empty() {
            return Ok(fail(FailureCode::Invalid, "Describe the vulnerability: what is affected and how to reproduce it."));
        }
        let severity = a.severity.as_deref().map(str::trim).filter(|severity| !severity.is_empty());
        if severity.is_some_and(|severity| !SEVERITIES.contains(&severity)) {
            return Ok(fail(FailureCode::Invalid, "severity is critical, high, medium or low, or left out."));
        }
        let since = rfc3339(now_ms().saturating_sub(DAY_MS));
        let (by_reporter, waiting) = self.store.report_counts(&repo, &key, &since).await?;
        if by_reporter >= REPORTS_PER_DAY {
            return Ok(fail(
                FailureCode::Limit,
                format!("You have sent {REPORTS_PER_DAY} reports to this repository today. Try again tomorrow."),
            ));
        }
        if waiting >= MAX_NEW_REPORTS {
            return Ok(fail(
                FailureCode::Conflict,
                "This repository has as many reports waiting as it takes. Try again once its maintainers have reviewed them.",
            ));
        }
        let id = self.store.add_report(&repo, reporter.as_deref(), email.as_deref(), &key, &title, &description, severity).await?;
        let Some(report) = self.store.report(&repo, &id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such report."));
        };
        let event = AdvisoryEvent {
            repo_id: repo.repo_id.clone(),
            id: report.id.clone(),
            g1tsa_id: None,
            title: report.title.clone(),
            severity: report.severity.clone(),
            state: report.state.clone(),
            link: link(&repo, "reports"),
            notify: Vec::new(),
        };
        self.publish_advisory("security_advisory.reported", &repo, &event, a.viewer.as_ref().map(|user| user.id.clone())).await;
        Ok(Outcome::Ok(report))
    }

    pub(crate) async fn report_settings(&self, a: ReportSettingsArgs) -> Result<Outcome<ReportSettings>> {
        let (repo, _) = match self.visible_repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let (settings, _) = self.store.repo_settings(&repo.repo_id).await?;
        let published = self.store.security_advisories(&repo, &["published"]).await?.len() as u32;
        Ok(Outcome::Ok(ReportSettings { private_vulnerability_reporting: settings.private_vulnerability_reporting, published }))
    }

    pub(crate) async fn list_vulnerability_reports(&self, a: ListReportsArgs) -> Result<Outcome<Vec<VulnerabilityReport>>> {
        let repo = match self.member_repo(&a.repo, &a.viewer, crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let state = a.state.as_deref().filter(|state| REPORT_STATES.contains(state));
        if a.state.is_some() && state.is_none() {
            return Ok(fail(FailureCode::Invalid, "state is new, accepted or declined."));
        }
        Ok(Outcome::Ok(self.store.reports(&repo, state).await?))
    }

    pub(crate) async fn review_vulnerability_report(&self, a: ReviewReportArgs) -> Result<Outcome<ReviewedReport>> {
        let repo = match self.managed_repo(&a.repo, &a.actor).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(report) = self.store.report(&repo, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such report."));
        };
        if report.state != "new" {
            return Ok(fail(FailureCode::Conflict, format!("This report was {} already.", report.state)));
        }
        let note = clean(Some(&a.note), 1000);
        let (state, advisory_id) = match a.decision.as_str() {
            "accept" => {
                let draft = draft_from(&report);
                let id = self.store.add_advisory(&repo, &draft, &a.actor.username, Some(&report.id)).await?;
                ("accepted", Some(id))
            }
            "decline" => ("declined", None),
            _ => return Ok(fail(FailureCode::Invalid, "decision is accept or decline.")),
        };
        if !self.store.review_report(&repo, &report.id, state, &a.actor.username, note.as_deref(), advisory_id.as_deref()).await? {
            return Ok(fail(FailureCode::Conflict, "This report was reviewed already."));
        }
        let advisory = match &advisory_id {
            Some(id) => self.store.security_advisory(&repo, id).await?,
            None => None,
        };
        let Some(report) = self.store.report(&repo, &report.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such report."));
        };
        self.audit(
            &a.actor,
            "security_advisory.report_reviewed",
            Some(&repo),
            &repo.namespace,
            None,
            &format!(
                "Report {} {state}{}",
                report.id,
                advisory.as_ref().map(|advisory| format!(", drafted as {}", advisory.g1tsa_id)).unwrap_or_default()
            ),
        )
        .await;
        Ok(Outcome::Ok(ReviewedReport { report, advisory }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_advisory_is_checked_and_cleaned() {
        let input = AdvisoryInput {
            title: "  Path traversal in the archive reader ".into(),
            description: "Details…".into(),
            severity: "high".into(),
            cve_id: Some("cve-2026-12345".into()),
            cvss_score: Some(7.5),
            credits: vec!["ana".into(), "  ".into(), "bo".into()],
            ..AdvisoryInput::default()
        };
        let clean = validate(&input).unwrap();
        assert_eq!(clean.title, "Path traversal in the archive reader");
        assert_eq!(clean.cve_id.as_deref(), Some("CVE-2026-12345"));
        assert_eq!(clean.credits, vec!["ana", "bo"]);
        assert!(validate(&AdvisoryInput { title: " ".into(), severity: "high".into(), ..AdvisoryInput::default() }).is_err());
        assert!(validate(&AdvisoryInput { title: "x".into(), severity: "severe".into(), ..AdvisoryInput::default() }).is_err());
        assert!(
            validate(&AdvisoryInput {
                title: "x".into(),
                severity: "low".into(),
                cve_id: Some("CVE-1".into()),
                ..AdvisoryInput::default()
            })
            .is_err()
        );
        assert!(
            validate(&AdvisoryInput { title: "x".into(), severity: "low".into(), cvss_score: Some(11.0), ..AdvisoryInput::default() })
                .is_err()
        );
    }

    #[test]
    fn an_accepted_report_becomes_a_draft_crediting_its_reporter() {
        let report = VulnerabilityReport {
            title: "XSS in the search box".into(),
            description: "Type <script> into…".into(),
            severity: Some("medium".into()),
            reporter: None,
            reporter_email: Some("finder@example.com".into()),
            ..VulnerabilityReport::default()
        };
        let draft = draft_from(&report);
        assert_eq!(draft.title, "XSS in the search box");
        assert_eq!(draft.credits, vec!["finder@example.com"]);
        let signed_in = VulnerabilityReport { reporter: Some("ana".into()), severity: None, ..report };
        let draft = draft_from(&signed_in);
        assert_eq!(draft.credits, vec!["ana"]);
        assert_eq!(draft.severity, "medium");
    }

    #[test]
    fn addresses_and_cves_are_checked_loosely() {
        assert!(looks_like_email("finder@example.com"));
        assert!(!looks_like_email("finder") && !looks_like_email("@example.com") && !looks_like_email("a b@example.com"));
        assert!(is_cve("CVE-2026-12345") && is_cve("cve-2026-0001"));
        assert!(!is_cve("CVE-26-1") && !is_cve("GHSA-xxxx"));
        assert!(year_of(0) == 1970);
    }
}
