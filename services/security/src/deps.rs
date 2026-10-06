//! Dependencies: reading a repository's lockfiles, asking OSV about every
//! package in them, and opening one upgrade issue per vulnerable package
//! for a g1t agent to land through the normal pull request flow.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use g1t_contracts::repos::RepoPath;
use g1t_contracts::security::{FindLockfilesArgs, Lockfiles, VulnStatus, Vulnerability};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{AddCommentArgs, Issue, IssueDetail, IssueReason, OpenIssueArgs, QueueIssueArgs, State, ViewArgs};
use g1t_contracts::{Outcome, User};
use g1t_kit::now_ms;
use g1t_scan::lockfiles::{Lockfile, Package, still_locked_check, test_command};
use g1t_scan::osv::{self, Advisory, Severity};
use serde_json::{Value, json};
use worker::{Fetch, Headers, Method, Request, RequestInit, Result};

use crate::Security;
use crate::store::{RepoRow, VulnRow};

/// OSV's records are fetched again after this long.
const ADVISORY_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Records fetched per scan, at most; the rest wait for the next one.
const MAX_ADVISORY_FETCHES: usize = 150;
/// Upgrade issues opened per scan, most severe first.
const MAX_NEW_ISSUES: usize = 8;
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

/// One package in one lockfile.
struct Located {
    package: Package,
    lockfile: Lockfile,
    path: String,
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
        let mut records = HashMap::new();
        let mut fetched = 0u32;
        for id in ids {
            if let Some(record) = self.store.advisory(id, &fresh_after).await? {
                records.insert(id.clone(), record);
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
    /// and opens upgrade issues for those with a fix. Returns what went
    /// wrong, for the Security page, if anything did.
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
        // No upgrade issues on an archived (read-only) or deleted repository.
        if repo.upkeep != 0 && self.active(&repo.repo_id).await? {
            self.open_upgrades(repo, &located).await?;
        }
        Ok(None)
    }

    /// One issue per vulnerable package that has a fix and no open issue
    /// for it, most severe first, with a g1t agent put on the first and the
    /// rest queued for one.
    async fn open_upgrades(&self, repo: &RepoRow, located: &[Located]) -> Result<()> {
        let open = self.store.open_vulnerabilities(&repo.repo_id).await?;
        let mut by_package: BTreeMap<(String, String), Vec<&VulnRow>> = BTreeMap::new();
        for vuln in &open {
            if vuln.fixed_version.is_some() {
                by_package.entry((vuln.ecosystem.clone(), vuln.package.clone())).or_default().push(vuln);
            }
        }
        let mut groups: Vec<((String, String), Vec<&VulnRow>)> = by_package.into_iter().collect();
        groups.sort_by_key(|(_, vulns)| std::cmp::Reverse(vulns.iter().map(|v| Severity::parse(&v.severity)).max()));
        let Some(actor) = self.workspace_actor(&repo.namespace).await? else {
            return Ok(());
        };
        let path = RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() };
        let mut opened = 0;
        let mut agents: Option<std::result::Result<(), String>> = None;
        for ((ecosystem, package), vulns) in groups {
            if opened >= MAX_NEW_ISSUES {
                break;
            }
            if let Some(existing) = self.store.upgrade(&repo.repo_id, &ecosystem, &package).await? {
                match self.issue(&actor, &path, existing.number as u32).await? {
                    // Already being fixed.
                    Some(issue) if issue.state == State::Open => continue,
                    // Someone decided not to; respect it until they reopen it.
                    Some(issue) if issue.reason == Some(IssueReason::NotPlanned) => continue,
                    _ => {}
                }
            }
            let target = osv::upgrade_target(vulns.iter().filter_map(|v| v.fixed_version.as_deref()))
                .unwrap_or_default();
            let mut advisories: Vec<&str> = vulns.iter().map(|v| v.advisory.as_str()).collect();
            advisories.sort();
            advisories.dedup();
            let named = match advisories.as_slice() {
                [one] => (*one).to_owned(),
                [first, second] => format!("{first}, {second}"),
                [first, rest @ ..] => format!("{first} and {} more", rest.len()),
                [] => "a known vulnerability".to_owned(),
            };
            let title: String = format!("Upgrade {package} to {target}: fixes {named}").chars().take(200).collect();
            let (body, checks) = issue_text(&ecosystem, &package, &target, &vulns, located);
            let issue: Outcome<Issue> = g1t_kit::call(
                &self.work,
                "open_issue",
                &OpenIssueArgs {
                    actor: actor.clone(),
                    repo: path.clone(),
                    title,
                    body,
                    labels: vec!["dependencies".to_owned(), "security".to_owned()],
                    checks,
                },
            )
            .await?;
            let Outcome::Ok(issue) = issue else { continue };
            opened += 1;
            // The first upgrade starts an agent at once, which also says
            // whether this workspace can run agents; the rest wait in the
            // queue, which starts them as the repository has room.
            let (assigned, note) = match &agents {
                None => {
                    let started: Outcome<Value> = g1t_kit::call(
                        &self.runner,
                        "run",
                        &json!({ "actor": actor, "repo": path, "issue": issue.number }),
                    )
                    .await?;
                    let result = match started {
                        Outcome::Ok(_) => Ok(()),
                        Outcome::Fail(refused) => Err(refused.message),
                    };
                    agents = Some(result.clone());
                    match result {
                        Ok(()) => (true, None),
                        Err(reason) => (false, Some(reason)),
                    }
                }
                Some(Ok(())) => {
                    let queued: Outcome<bool> = g1t_kit::call(
                        &self.work,
                        "queue_issue",
                        &QueueIssueArgs { actor: actor.clone(), repo: path.clone(), number: issue.number, queued: true },
                    )
                    .await?;
                    (matches!(queued, Outcome::Ok(true)), None)
                }
                Some(Err(reason)) => (false, Some(reason.clone())),
            };
            if let Some(reason) = &note {
                self.comment(&actor, &path, issue.number, format!(
                    "g1t could not put an agent on this upgrade: {reason}\n\nAssign it to g1t-agent once agents can run here, or upgrade it by hand."
                ))
                .await?;
            }
            self.store
                .record_upgrade(&repo.repo_id, &ecosystem, &package, issue.number, &target, assigned, note.as_deref())
                .await?;
        }
        Ok(())
    }

    async fn issue(&self, actor: &User, repo: &RepoPath, number: u32) -> Result<Option<Issue>> {
        let found: Outcome<IssueDetail> = g1t_kit::call(
            &self.work,
            "get_issue",
            &ViewArgs { repo: repo.clone(), number, viewer: Some(actor.clone()), after_seq: 0 },
        )
        .await?;
        Ok(found.into_result().ok().map(|detail| detail.issue))
    }

    async fn comment(&self, actor: &User, repo: &RepoPath, number: u32, body: String) -> Result<()> {
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
    }
}

/// The issue's body, written for the agent that takes it as much as for a
/// person, and its acceptance checks: the project's tests, and that no
/// lockfile still resolves a vulnerable version.
fn issue_text(ecosystem: &str, package: &str, target: &str, vulns: &[&VulnRow], located: &[Located]) -> (String, Vec<String>) {
    let mut body = format!(
        "`{package}` ({ecosystem}) has known vulnerabilities with a fix in **{target}**. Upgrade it to {target} or later \
         everywhere it is locked, keeping other changes to what the upgrade needs.\n\n\
         | Advisory | Severity | Affected | Fixed in | Summary |\n| --- | --- | --- | --- | --- |\n"
    );
    let mut seen = BTreeSet::new();
    for vuln in vulns {
        if !seen.insert((vuln.advisory.clone(), vuln.version.clone())) {
            continue;
        }
        body.push_str(&format!(
            "| [{}]({}) | {} | {} | {} | {} |\n",
            vuln.advisory,
            osv::page_url(&vuln.osv_id),
            vuln.severity,
            vuln.version,
            vuln.fixed_version.as_deref().unwrap_or("none yet"),
            vuln.summary.replace('|', "\\|").replace('\n', " "),
        ));
    }
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
        "\nThe acceptance checks pass once no lockfile resolves a vulnerable version and the tests still pass. \
         If the fix needs a major upgrade that breaks the build, change the code that depends on it in the same pull request.\n\n\
         ---\n_Opened by g1t's dependency upkeep. Turn it off for this project on its Security page._",
    );
    checks.extend(tests);
    (body, checks)
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
        };
        let located = vec![Located {
            package: Package { ecosystem: g1t_scan::lockfiles::Ecosystem::Npm, name: "lodash".into(), version: "4.17.20".into() },
            lockfile: Lockfile::PackageLock,
            path: "web/package-lock.json".into(),
        }];
        let (body, checks) = issue_text("npm", "lodash", "4.17.21", &[&row], &located);
        assert!(body.contains("[GHSA-35jh-r3h4-6jhm](https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm) | high | 4.17.20 | 4.17.21"));
        assert!(body.contains("`web/package-lock.json` (4.17.20)"));
        assert_eq!(checks.len(), 2);
        assert!(checks[0].contains("node_modules/lodash") && checks[0].contains("'web/package-lock.json'"));
        assert_eq!(checks[1], "cd 'web' && npm ci && npm test --if-present");
    }
}
