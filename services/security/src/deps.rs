//! Dependencies: reading a repository's lockfiles, asking OSV about every
//! package in them, and recording what is vulnerable. The security updates
//! that fix them are `security_updates`'s.

use std::collections::{BTreeSet, HashMap};

use g1t_contracts::repos::RepoPath;
use g1t_contracts::repos::{BlobArgs, BlobView};
use g1t_contracts::security::{AlertState, FindLockfilesArgs, Lockfiles, VersionUpdatesState, VulnStatus, Vulnerability};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{AddCommentArgs, Issue, IssueDetail, ViewArgs};
use g1t_contracts::{Outcome, User};
use g1t_kit::now_ms;
use g1t_scan::lockfiles::{Lockfile, Package, still_locked_check, test_command};
use g1t_scan::osv::{self, Advisory};
use serde_json::{Value, json};
use worker::{Fetch, Headers, Method, Request, RequestInit, Result};

use crate::Security;
use crate::store::{RepoRow, VulnRow};
use crate::updates;

/// OSV's records are fetched again after this long.
const ADVISORY_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// A record that names no fixed version is fetched again after a day, so
/// a fix is noticed the day it is published.
const UNFIXED_ADVISORY_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
/// Records fetched per scan, at most; the rest wait for the next one.
const MAX_ADVISORY_FETCHES: usize = 150;
/// CPU one call to OSV takes, sending it and reading its answer, in
/// milliseconds (an estimate, rounded up). OSV itself is free, and a
/// Worker's outgoing requests are not charged.
const CPU_MS_PER_OSV_CALL: f64 = 2.0;

/// What a dependency check cost g1t, in millionths of a dollar, rounded
/// up, at the prices in `history`: the CPU of its OSV calls, and the rows
/// it writes (an advisory kept for each call at most, each vulnerability
/// found, where the check stands and the month's usage).
pub fn dependency_check_cost(calls: u32, found: usize) -> i64 {
    use crate::history::{MICROS_PER_CPU_MS, MICROS_PER_ROW_WRITTEN};
    let cpu = f64::from(calls) * CPU_MS_PER_OSV_CALL * MICROS_PER_CPU_MS;
    let rows = (calls as usize + found + 2) as f64 * MICROS_PER_ROW_WRITTEN;
    (cpu + rows).ceil() as i64
}

async fn osv_call(method: Method, url: &str, body: Option<&Value>) -> Result<Option<Value>> {
    let headers = Headers::new();
    headers.set("user-agent", "g1t (+https://g1t.sh)")?;
    headers.set("accept", "application/json")?;
    if body.is_some() {
        headers.set("content-type", "application/json")?;
    }
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(body.to_string().into()));
    }
    let mut response = Fetch::Request(Request::new_with_init(url, &init)?).send().await?;
    if response.status_code() == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&response.status_code()) {
        return Err(worker::Error::RustError(format!("OSV answered {}", response.status_code())));
    }
    Ok(Some(response.json().await?))
}

/// Whether an OSV record names a version that fixes it, for any package.
fn names_a_fix(record: &Value) -> bool {
    record["affected"].as_array().into_iter().flatten().any(|affected| {
        affected["ranges"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|range| range["events"].as_array().into_iter().flatten().any(|event| event.get("fixed").is_some()))
    })
}

/// One package in one lockfile.
pub(crate) struct Located {
    pub(crate) package: Package,
    pub(crate) lockfile: Lockfile,
    pub(crate) path: String,
}

/// Every package the lockfiles resolve. A directory with a `go.mod` is read
/// from it rather than from its `go.sum`, which lists versions not built.
fn packages(files: &Lockfiles) -> Vec<Located> {
    let go_mods: BTreeSet<&str> = files
        .files
        .iter()
        .filter(|file| file.path.ends_with("go.mod"))
        .map(|file| file.path.trim_end_matches("go.mod"))
        .collect();
    let mut located = Vec::new();
    for file in &files.files {
        let Some(lockfile) = Lockfile::for_path(&file.path) else { continue };
        if lockfile == Lockfile::GoSum && go_mods.contains(file.path.trim_end_matches("go.sum")) {
            continue;
        }
        for package in lockfile.parse(&file.text) {
            located.push(Located { package, lockfile, path: file.path.clone() });
        }
    }
    located
}

fn directory(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(directory, _)| directory)
}

impl Security {
    /// The ids of the vulnerabilities affecting each package, from OSV.
    async fn query_osv(&self, packages: &[Package]) -> Result<(Vec<Vec<String>>, u32)> {
        let mut ids = Vec::with_capacity(packages.len());
        let mut calls = 0;
        for (body, chunk) in osv::batch_bodies(packages).iter().zip(packages.chunks(osv::MAX_BATCH)) {
            calls += 1;
            let answer = osv_call(Method::Post, osv::QUERY_BATCH_URL, Some(body)).await?.unwrap_or(Value::Null);
            let (mut found, more) = osv::read_batch(&answer, chunk.len());
            // A package with many advisories is paged; fetch the rest.
            for (index, token) in more.into_iter().take(20) {
                let package = &chunk[index];
                let query = json!({
                    "package": {"name": package.name, "ecosystem": package.ecosystem.osv()},
                    "version": package.version,
                    "page_token": token,
                });
                calls += 1;
                if let Some(page) = osv_call(Method::Post, "https://api.osv.dev/v1/query", Some(&query)).await? {
                    found[index].extend(
                        page["vulns"].as_array().into_iter().flatten().filter_map(|v| v["id"].as_str().map(str::to_owned)),
                    );
                }
            }
            ids.extend(found);
        }
        Ok((ids, calls))
    }

    /// OSV's record of each id, from the cache when it is fresh.
    async fn advisories(&self, ids: &BTreeSet<String>) -> Result<(HashMap<String, Value>, u32)> {
        let fresh_after = rfc3339(now_ms().saturating_sub(ADVISORY_MAX_AGE_MS));
        let unfixed_fresh_after = rfc3339(now_ms().saturating_sub(UNFIXED_ADVISORY_MAX_AGE_MS));
        let mut records = HashMap::new();
        let mut fetched = 0u32;
        for id in ids {
            if let Some(record) = self.store.advisory(id, &fresh_after).await? {
                // One without a fix is asked about again daily; until then,
                // or if asking fails below, the kept record stands.
                let fixed = names_a_fix(&record);
                let recent = !fixed && self.store.advisory(id, &unfixed_fresh_after).await?.is_some();
                if fixed || recent || fetched as usize >= MAX_ADVISORY_FETCHES {
                    records.insert(id.clone(), record);
                    continue;
                }
                fetched += 1;
                let refreshed = osv_call(Method::Get, &osv::vuln_url(id), None).await.ok().flatten();
                if let Some(refreshed) = &refreshed {
                    self.store.keep_advisory(id, refreshed).await?;
                }
                records.insert(id.clone(), refreshed.unwrap_or(record));
                continue;
            }
            if fetched as usize >= MAX_ADVISORY_FETCHES {
                continue;
            }
            fetched += 1;
            if let Some(record) = osv_call(Method::Get, &osv::vuln_url(id), None).await? {
                self.store.keep_advisory(id, &record).await?;
                records.insert(id.clone(), record);
            }
        }
        Ok((records, fetched))
    }

    /// Reads a repository's dependencies, records which are vulnerable,
    /// and starts security updates for those with a fix. Also reads
    /// `.g1t/dependencies.yml`. Returns what went wrong, for the Security
    /// page, if anything did.
    pub async fn scan_dependencies(&self, repo: &RepoRow) -> Result<Option<String>> {
        let files: Lockfiles = g1t_kit::call(&self.repos, "find_lockfiles", &FindLockfilesArgs { repo_id: repo.repo_id.clone() }).await?;
        let paths: Vec<String> = files.files.iter().map(|file| file.path.clone()).collect();
        let located = packages(&files);
        let unique: Vec<Package> = located.iter().map(|l| l.package.clone()).collect::<BTreeSet<_>>().into_iter().collect();
        let outcome = async {
            let (ids, calls) = self.query_osv(&unique).await?;
            let by_package: HashMap<&Package, &Vec<String>> = unique.iter().zip(ids.iter()).collect();
            let wanted: BTreeSet<String> = ids.iter().flatten().cloned().collect();
            let (records, fetched) = self.advisories(&wanted).await?;
            let mut found = Vec::new();
            for item in &located {
                for id in by_package.get(&item.package).into_iter().flat_map(|ids| ids.iter()) {
                    let Some(advisory) = records.get(id).and_then(|record| osv::read_vuln(record, &item.package)) else {
                        continue;
                    };
                    found.push(vulnerability(&repo.repo_id, item, &advisory));
                }
            }
            Ok::<_, worker::Error>((found, calls + fetched))
        }
        .await;
        let (found, calls) = match outcome {
            Ok(result) => result,
            Err(error) => {
                let problem = format!("The dependencies could not be checked: {error}");
                self.store
                    .set_dependencies_scanned(&repo.repo_id, files.commit.as_deref(), &paths, Some(&problem))
                    .await?;
                return Ok(Some(problem));
            }
        };
        self.store.replace_vulnerabilities(&repo.repo_id, &found).await?;
        self.store.set_dependencies_scanned(&repo.repo_id, files.commit.as_deref(), &paths, None).await?;
        self.meter(&repo.namespace, 0, 0, calls, dependency_check_cost(calls, found.len())).await?;
        if let Some(commit) = files.commit.as_deref() {
            self.read_version_updates(repo, commit).await?;
        }
        // No security updates on an archived (read-only) or deleted
        // repository; ones in flight for packages no longer vulnerable are
        // closed either way.
        let active = self.active(&repo.repo_id).await?;
        self.security_updates(repo, repo.upkeep != 0 && active).await?;
        Ok(None)
    }

    /// Reads `.g1t/dependencies.yml` at `commit` and keeps what it says.
    async fn read_version_updates(&self, repo: &RepoRow, commit: &str) -> Result<()> {
        let found: Outcome<BlobView> = g1t_kit::call(
            &self.repos,
            "blob",
            &BlobArgs {
                path: RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() },
                viewer: Some(User::system(&repo.namespace)),
                git_ref: commit.to_owned(),
                file_path: updates::PATH.to_owned(),
            },
        )
        .await?;
        let mut state = VersionUpdatesState { read_at: Some(crate::store::now()), ..VersionUpdatesState::default() };
        if let Outcome::Ok(blob) = found {
            state.found = true;
            match blob.text.as_deref().map(updates::parse) {
                Some(Ok(entries)) => state.updates = entries,
                Some(Err(error)) => state.error = Some(error),
                None => state.error = Some(format!("{} is too large or not text.", updates::PATH)),
            }
        }
        self.store.set_version_updates(&repo.repo_id, &state).await
    }

    pub(crate) async fn issue(&self, actor: &User, repo: &RepoPath, number: u32) -> Result<Option<Issue>> {
        let found: Outcome<IssueDetail> = g1t_kit::call(
            &self.work,
            "get_issue",
            &ViewArgs { repo: repo.clone(), number, viewer: Some(actor.clone()), after_seq: 0 },
        )
        .await?;
        Ok(found.into_result().ok().map(|detail| detail.issue))
    }

    pub(crate) async fn comment(&self, actor: &User, repo: &RepoPath, number: u32, body: String) -> Result<()> {
        let _: Outcome<Value> = g1t_kit::call(
            &self.work,
            "add_comment",
            &AddCommentArgs {
                actor: actor.clone(),
                repo: repo.clone(),
                number,
                body,
                path: None,
                line: None,
                verdict: None,
            },
        )
        .await?;
        Ok(())
    }
}

fn vulnerability(repo_id: &str, item: &Located, advisory: &Advisory) -> Vulnerability {
    Vulnerability {
        id: String::new(),
        repo_id: repo_id.to_owned(),
        ecosystem: item.package.ecosystem.osv().to_owned(),
        package: item.package.name.clone(),
        version: item.package.version.clone(),
        manifest: item.path.clone(),
        advisory: advisory.display_id.clone(),
        osv_id: advisory.id.clone(),
        summary: advisory.summary.clone(),
        severity: advisory.severity.as_str().to_owned(),
        fixed_version: advisory.fixed.clone(),
        status: VulnStatus::Open,
        issue: None,
        found_at: String::new(),
        fixed_at: None,
        state: AlertState::Open,
        dismissed_by: None,
        dismissed_reason: None,
        dismissed_comment: None,
        dismissed_at: None,
        update: None,
    }
}

/// The issue's body, for when raising the version is not enough, written
/// for the agent that takes it as much as for a person, ending with what
/// done means: commands that show no lockfile still resolves a vulnerable
/// version, and the project's tests. The pull request merges on the
/// repository's required checks, like any other.
pub(crate) fn issue_text(ecosystem: &str, package: &str, target: &str, vulns: &[&VulnRow], located: &[Located]) -> String {
    let mut body = format!(
        "`{package}` ({ecosystem}) has known vulnerabilities with a fix in **{target}**, and raising its version alone \
         does not pass this project's checks. Upgrade it to {target} or later everywhere it is locked, and change the \
         code that depends on it, keeping other changes to what the upgrade needs.\n\n"
    );
    body.push_str(&advisory_table(vulns));
    let mut checks = Vec::new();
    let mut manifests = BTreeSet::new();
    let mut tests = BTreeSet::new();
    for vuln in vulns {
        let Some(item) = located
            .iter()
            .find(|item| item.path == vuln.manifest && item.package.name == vuln.package && item.package.version == vuln.version)
        else {
            continue;
        };
        if manifests.insert((item.path.clone(), item.package.version.clone())) {
            checks.push(still_locked_check(item.lockfile, &item.path, &item.package.name, &item.package.version));
        }
        if let Some(test) = test_command(item.lockfile, directory(&item.path)) {
            tests.insert(test);
        }
    }
    let locked: Vec<String> = manifests.iter().map(|(path, version)| format!("`{path}` ({version})")).collect();
    body.push_str(&format!("\nLocked in: {}.\n", locked.join(", ")));
    body.push_str(
        "\nIf the fix needs a major upgrade that breaks the build, change the code that depends on it in the same pull request.",
    );
    checks.extend(tests);
    let mut done = vec!["No lockfile resolves a vulnerable version, and the tests still pass.".to_owned()];
    done.extend(g1t_contracts::work::commands_pass(&checks));
    let mut body = g1t_contracts::work::with_definition_of_done(&body, &done);
    body.push_str("\n\n---\n_Opened by g1t's security updates. Turn them off for this project on its Security page._");
    body
}

/// The advisories a package's vulnerabilities name, as a table.
pub(crate) fn advisory_table(vulns: &[&VulnRow]) -> String {
    let mut table = "| Advisory | Severity | Affected | Fixed in | Summary |\n| --- | --- | --- | --- | --- |\n".to_owned();
    let mut seen = BTreeSet::new();
    for vuln in vulns {
        if !seen.insert((vuln.advisory.clone(), vuln.version.clone())) {
            continue;
        }
        table.push_str(&format!(
            "| [{}]({}) | {} | {} | {} | {} |\n",
            vuln.advisory,
            osv::page_url(&vuln.osv_id),
            vuln.severity,
            vuln.version,
            vuln.fixed_version.as_deref().unwrap_or("none yet"),
            vuln.summary.replace('|', "\\|").replace('\n', " "),
        ));
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::security::LockfileText;

    #[test]
    fn scans_cost_their_cpu_and_the_rows_they_write() {
        // 10 OSV calls and 3 vulnerabilities: 0.4 of CPU, 15 rows.
        assert_eq!(dependency_check_cost(10, 3), 16);
        assert_eq!(dependency_check_cost(0, 0), 2);
        // A page of 25 commits that read 100 objects and found nothing:
        // 10 of CPU and 2 rows. The old placeholder charged 100.
        assert_eq!(crate::history::history_page_cost(100, 0), 12);
        assert_eq!(crate::history::history_page_cost(0, 1), 3);
    }

    #[test]
    fn go_sum_is_skipped_beside_go_mod() {
        let files = Lockfiles {
            commit: None,
            files: vec![
                LockfileText { path: "go.mod".into(), text: "require golang.org/x/net v0.7.0\n".into() },
                LockfileText { path: "go.sum".into(), text: "golang.org/x/net v0.1.0 h1:x=\n".into() },
                LockfileText { path: "tools/go.sum".into(), text: "golang.org/x/text v0.3.0 h1:x=\n".into() },
            ],
        };
        let found: Vec<String> = packages(&files).iter().map(|l| format!("{}:{}", l.path, l.package.version)).collect();
        assert_eq!(found, ["go.mod:v0.7.0", "tools/go.sum:v0.3.0"]);
    }

    #[test]
    fn the_issue_names_the_advisories_and_checks_the_lockfile() {
        let row = VulnRow {
            id: "vul_1".into(),
            repo_id: "rep_1".into(),
            ecosystem: "npm".into(),
            package: "lodash".into(),
            version: "4.17.20".into(),
            manifest: "web/package-lock.json".into(),
            osv_id: "GHSA-35jh-r3h4-6jhm".into(),
            advisory: "GHSA-35jh-r3h4-6jhm".into(),
            summary: "Command Injection in lodash".into(),
            severity: "high".into(),
            fixed_version: Some("4.17.21".into()),
            status: "open".into(),
            found_at: "2026-10-04T00:00:00Z".into(),
            fixed_at: None,
            number: None,
            dismiss_reason: None,
            dismiss_comment: None,
            dismissed_by: None,
            dismissed_at: None,
        };
        let located = vec![Located {
            package: Package { ecosystem: g1t_scan::lockfiles::Ecosystem::Npm, name: "lodash".into(), version: "4.17.20".into() },
            lockfile: Lockfile::PackageLock,
            path: "web/package-lock.json".into(),
        }];
        let body = issue_text("npm", "lodash", "4.17.21", &[&row], &located);
        assert!(body.contains("[GHSA-35jh-r3h4-6jhm](https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm) | high | 4.17.20 | 4.17.21"));
        assert!(body.contains("`web/package-lock.json` (4.17.20)"));
        let (_, done) = body.split_once("## Definition of done\n\n").unwrap();
        let items: Vec<&str> = done.lines().take_while(|line| line.starts_with("- ")).collect();
        assert_eq!(items.len(), 3);
        assert!(items[1].contains("node_modules/lodash") && items[1].contains("'web/package-lock.json'"));
        assert_eq!(items[2], "- `cd 'web' && npm ci && npm test --if-present` passes.");
        assert!(body.ends_with("on its Security page._"));
        assert!(advisory_table(&[&row]).contains("| [GHSA-35jh-r3h4-6jhm](https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm) | high |"));
    }
}
