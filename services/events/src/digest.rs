//! `activity_digest`: what happened in a workspace's repositories, and to
//! its artifacts, over a span, counted by who did it. Home reads it for
//! what people and agents did since you were last there
//! (docs.g1t.sh/guides/home/). See `g1t_contracts::events::ActivityDigestArgs`.
//!
//! How it scales: event ids sort by time, so the span is a range of ids,
//! and the `(repo_id, type, id)` index (migrations/0008) makes each
//! repository's events of each counted type one range scan; one statement
//! covers every repository and type asked for, and a second the
//! workspace's folio events, which carry no repository. That is a few
//! thousand rows at most for a busy week of tens of repositories, read in
//! one round trip. A workspace with hundreds of repositories wants a daily
//! rollup per workspace instead, which this method would read in place of
//! the log; that is the next step and is not built yet.

use std::collections::{BTreeMap, BTreeSet};

use g1t_contracts::events::{
    ActivityDigest, ActivityDigestArgs, ActorCount, DefaultBranchPushes, DeploymentDigest, Event,
    FolioDigest, FolioEdited, IssueDigest, MAX_DIGEST_EVENTS, MAX_DIGEST_LISTED, MAX_DIGEST_REPOS,
    PackageDigest, PullDigest, PushDigest, PushesBy, ReleaseDigest, RepoDigest,
};
use g1t_contracts::id_floor;
use g1t_contracts::time::parse_rfc3339;
use serde_json::Value;
use worker::{D1Database, Error, Result};

use crate::EventRow;

/// The repository events a digest counts.
const REPO_TYPES: [&str; 12] = [
    "git.push",
    "pull.opened",
    "pull.merged",
    "pull.closed",
    "issue.opened",
    "issue.closed",
    "review.completed",
    "comment.created",
    "deployment.succeeded",
    "deployment.failed",
    "release.published",
    "package.published",
];
/// The artifact events a digest counts: published with no repository.
const FOLIO_TYPES: [&str; 2] = ["folio.created", "folio.updated"];

/// Reads the span's events and counts them.
pub async fn activity_digest(db: &D1Database, a: ActivityDigestArgs) -> Result<ActivityDigest> {
    let from =
        parse_rfc3339(&a.from).ok_or_else(|| Error::RustError("from must be RFC 3339".into()))?;
    let until =
        parse_rfc3339(&a.until).ok_or_else(|| Error::RustError("until must be RFC 3339".into()))?;
    let (low, high) = (id_floor("evt", from), id_floor("evt", until));
    let mut complete = a.repo_ids.len() <= MAX_DIGEST_REPOS;
    let repo_ids: Vec<&str> = a
        .repo_ids
        .iter()
        .take(MAX_DIGEST_REPOS)
        .map(String::as_str)
        .collect();
    // One past the cap says whether there was more.
    let limit = f64::from(MAX_DIGEST_EVENTS + 1);
    let mut statements = Vec::with_capacity(2);
    if !repo_ids.is_empty() {
        statements.push(
            db.prepare(
                "SELECT id, type, source, time, repo_id, actor, data FROM events
                 WHERE repo_id IN (SELECT value FROM json_each(?1))
                   AND type IN (SELECT value FROM json_each(?2))
                   AND id >= ?3 AND id < ?4
                 ORDER BY id LIMIT ?5",
            )
            .bind(&[
                serde_json::to_string(&repo_ids)?.into(),
                serde_json::to_string(&REPO_TYPES)?.into(),
                low.as_str().into(),
                high.as_str().into(),
                limit.into(),
            ])?,
        );
    }
    if let Some(workspace) = a.workspace.as_deref().filter(|slug| !slug.is_empty()) {
        statements.push(
            db.prepare(
                "SELECT id, type, source, time, repo_id, actor, data FROM events
                 WHERE repo_id IS NULL
                   AND type IN (SELECT value FROM json_each(?1))
                   AND id >= ?2 AND id < ?3
                   AND lower(json_extract(data, '$.workspace')) = ?4
                 ORDER BY id LIMIT ?5",
            )
            .bind(&[
                serde_json::to_string(&FOLIO_TYPES)?.into(),
                low.as_str().into(),
                high.as_str().into(),
                workspace.to_lowercase().into(),
                limit.into(),
            ])?,
        );
    }
    let mut results = if statements.is_empty() {
        Vec::new()
    } else {
        db.batch(statements).await?
    }
    .into_iter();
    let mut read = |wanted: bool| -> Result<Option<Vec<Event>>> {
        if !wanted {
            return Ok(None);
        }
        let Some(result) = results.next() else {
            return Ok(Some(Vec::new()));
        };
        let mut events: Vec<Event> = result
            .results::<EventRow>()?
            .into_iter()
            .map(Event::from)
            .collect();
        if events.len() > MAX_DIGEST_EVENTS as usize {
            events.truncate(MAX_DIGEST_EVENTS as usize);
            complete = false;
        }
        Ok(Some(events))
    };
    let repo_events = read(!repo_ids.is_empty())?.unwrap_or_default();
    let folio_events = read(a.workspace.as_deref().is_some_and(|slug| !slug.is_empty()))?;
    Ok(shape(&a, &repo_events, folio_events.as_deref(), complete))
}

/// Counts `events` (a repository's, any order) and `folios` (a workspace's
/// folio events) into the digest. Pure, so it is tested on its own.
pub fn shape(
    a: &ActivityDigestArgs,
    events: &[Event],
    folios: Option<&[Event]>,
    complete: bool,
) -> ActivityDigest {
    let mut repos: BTreeMap<&str, Counting> = BTreeMap::new();
    for event in events {
        let Some(repo_id) = event.repo_id.as_deref() else {
            continue;
        };
        repos.entry(repo_id).or_default().count(event);
    }
    ActivityDigest {
        from: a.from.clone(),
        until: a.until.clone(),
        repos: repos
            .into_iter()
            .map(|(repo_id, counting)| counting.into_digest(repo_id))
            .collect(),
        folios: folios.map(folio_digest),
        complete,
    }
}

/// An event's actor as a member key: `user:<id>`, or empty for nobody.
fn member_key(actor: Option<&str>) -> String {
    match actor {
        Some(id) if !id.is_empty() => format!("user:{id}"),
        _ => String::new(),
    }
}

fn text<'a>(data: &'a Value, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

/// A running count per actor.
#[derive(Default)]
struct Tally(BTreeMap<String, u32>);

impl Tally {
    fn add(&mut self, actor: String) {
        *self.0.entry(actor).or_insert(0) += 1;
    }

    /// Most first, then by actor, so the order never depends on the log's.
    fn into_counts(self) -> Vec<ActorCount> {
        let mut counts: Vec<ActorCount> = self
            .0
            .into_iter()
            .map(|(actor, count)| ActorCount { actor, count })
            .collect();
        counts.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.actor.cmp(&b.actor)));
        counts
    }
}

/// Pushes per actor, with their commits.
#[derive(Default)]
struct Pushing {
    count: u32,
    commits: u32,
    by: BTreeMap<String, (u32, u32)>,
}

impl Pushing {
    fn add(&mut self, actor: String, commits: u32) {
        self.count += 1;
        self.commits += commits;
        let entry = self.by.entry(actor).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += commits;
    }

    fn into_by(self) -> Vec<PushesBy> {
        let mut by: Vec<PushesBy> = self
            .by
            .into_iter()
            .map(|(actor, (count, commits))| PushesBy {
                actor,
                count,
                commits,
            })
            .collect();
        by.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.actor.cmp(&b.actor)));
        by
    }
}

#[derive(Default)]
struct Counting {
    pushes: Pushing,
    branches: BTreeSet<String>,
    default_branch: Pushing,
    default_branch_last: Option<String>,
    pulls_opened: Tally,
    pulls_merged: Tally,
    pulls_closed: Tally,
    issues_opened: Tally,
    issues_closed: Tally,
    reviews: Tally,
    comments: Tally,
    deploys_succeeded: Tally,
    deploys_failed: Tally,
    production: u32,
    releases: Vec<ReleaseDigest>,
    packages: Vec<PackageDigest>,
}

impl Counting {
    fn count(&mut self, event: &Event) {
        let data = &event.data;
        let actor = member_key(event.actor.as_deref());
        match event.kind.as_str() {
            "git.push" => {
                let Some(branch) = text(data, "ref").and_then(|r| r.strip_prefix("refs/heads/"))
                else {
                    return;
                };
                // A push whose commits were not counted brought at least one.
                let commits = data
                    .get("commits")
                    .and_then(Value::as_u64)
                    .map_or(1, |n| n.min(u64::from(u32::MAX)) as u32);
                self.branches.insert(branch.to_owned());
                self.pushes.add(actor.clone(), commits);
                if data.get("defaultBranch").and_then(Value::as_bool) == Some(true) {
                    self.default_branch.add(actor, commits);
                    if self
                        .default_branch_last
                        .as_deref()
                        .is_none_or(|last| event.time.as_str() > last)
                    {
                        self.default_branch_last = Some(event.time.clone());
                    }
                }
            }
            "pull.opened" => self.pulls_opened.add(actor),
            "pull.merged" => self.pulls_merged.add(actor),
            "pull.closed" => self.pulls_closed.add(actor),
            "issue.opened" => self.issues_opened.add(actor),
            "issue.closed" => self.issues_closed.add(actor),
            "review.completed" => self.reviews.add(actor),
            "comment.created" => {
                // One of the workspace's agents, as itself: the event's actor
                // is the person it acted for.
                let by = match data.get("agent").and_then(|agent| text(agent, "id")) {
                    Some(id) => format!("agent:{id}"),
                    None => actor,
                };
                if data
                    .get("verdict")
                    .is_some_and(|verdict| !verdict.is_null())
                {
                    self.reviews.add(by);
                } else {
                    self.comments.add(by);
                }
            }
            "deployment.succeeded" => {
                if text(data, "kind") == Some("production") {
                    self.production += 1;
                }
                self.deploys_succeeded.add(actor);
            }
            "deployment.failed" => self.deploys_failed.add(actor),
            "release.published" => self.releases.push(ReleaseDigest {
                tag: text(data, "tagName").unwrap_or_default().to_owned(),
                name: data
                    .get("release")
                    .and_then(|release| text(release, "name"))
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned),
                actor,
                at: event.time.clone(),
            }),
            "package.published" => self.packages.push(PackageDigest {
                ecosystem: text(data, "ecosystem").unwrap_or_default().to_owned(),
                name: text(data, "name").unwrap_or_default().to_owned(),
                version: text(data, "version").unwrap_or_default().to_owned(),
                actor,
                at: event.time.clone(),
            }),
            _ => {}
        }
    }

    fn into_digest(mut self, repo_id: &str) -> RepoDigest {
        // Newest first, the most recent `MAX_DIGEST_LISTED`.
        self.releases
            .sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.tag.cmp(&b.tag)));
        self.releases.truncate(MAX_DIGEST_LISTED);
        self.packages.sort_by(|a, b| {
            b.at.cmp(&a.at)
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.version.cmp(&b.version))
        });
        self.packages.truncate(MAX_DIGEST_LISTED);
        RepoDigest {
            repo_id: repo_id.to_owned(),
            pushes: PushDigest {
                count: self.pushes.count,
                commits: self.pushes.commits,
                branches: self.branches.into_iter().collect(),
                by: self.pushes.into_by(),
                default_branch: DefaultBranchPushes {
                    count: self.default_branch.count,
                    commits: self.default_branch.commits,
                    by: self.default_branch.into_by(),
                    last_at: self.default_branch_last,
                },
            },
            pulls: PullDigest {
                opened: self.pulls_opened.into_counts(),
                merged: self.pulls_merged.into_counts(),
                closed: self.pulls_closed.into_counts(),
            },
            issues: IssueDigest {
                opened: self.issues_opened.into_counts(),
                closed: self.issues_closed.into_counts(),
            },
            reviews: self.reviews.into_counts(),
            comments: self.comments.into_counts(),
            deployments: DeploymentDigest {
                succeeded: self.deploys_succeeded.into_counts(),
                failed: self.deploys_failed.into_counts(),
                production: self.production,
            },
            releases: self.releases,
            packages: self.packages,
        }
    }
}

/// A workspace's folio events counted: who made folios, and which folios'
/// content changed with everyone whose changes are in them.
fn folio_digest(events: &[Event]) -> FolioDigest {
    let mut created = Tally::default();
    let mut edited: BTreeMap<&str, (String, BTreeSet<String>)> = BTreeMap::new();
    for event in events {
        let data = &event.data;
        match event.kind.as_str() {
            "folio.created" => created.add(member_key(event.actor.as_deref())),
            "folio.updated" => {
                let Some(folio_id) = text(data, "folioId") else {
                    continue;
                };
                let kind = text(data, "kind").unwrap_or("doc").to_owned();
                let entry = edited
                    .entry(folio_id)
                    .or_insert_with(|| (kind, BTreeSet::new()));
                let authors = data
                    .get("authors")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str);
                let mut any = false;
                for author in authors {
                    any = true;
                    entry.1.insert(author.to_owned());
                }
                // A version with no authors named is the actor's.
                if !any {
                    let actor = member_key(event.actor.as_deref());
                    if !actor.is_empty() {
                        entry.1.insert(actor);
                    }
                }
            }
            _ => {}
        }
    }
    FolioDigest {
        created: created.into_counts(),
        edited_count: edited.len() as u32,
        edited: edited
            .into_iter()
            .take(MAX_DIGEST_LISTED)
            .map(|(folio_id, (kind, authors))| FolioEdited {
                folio_id: folio_id.to_owned(),
                kind,
                authors: authors.into_iter().collect(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(
        id: &str,
        kind: &str,
        repo_id: Option<&str>,
        actor: Option<&str>,
        data: Value,
    ) -> Event {
        Event {
            id: id.to_owned(),
            kind: kind.to_owned(),
            source: "test".to_owned(),
            time: format!("2026-10-09T1{}:00:00.000Z", &id[id.len() - 1..]),
            repo_id: repo_id.map(str::to_owned),
            actor: actor.map(str::to_owned),
            data,
        }
    }

    fn args() -> ActivityDigestArgs {
        ActivityDigestArgs {
            repo_ids: vec!["rep_1".into(), "rep_2".into()],
            workspace: Some("acme".into()),
            from: "2026-10-09T00:00:00.000Z".into(),
            until: "2026-10-10T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn pushes_are_counted_by_branch_and_actor_with_their_commits() {
        let events = vec![
            event(
                "evt_1",
                "git.push",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "ref": "refs/heads/main", "after": "b", "before": "a", "defaultBranch": true, "commits": 7 }),
            ),
            event(
                "evt_2",
                "git.push",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "ref": "refs/heads/fix", "after": "c", "defaultBranch": false, "commits": 2 }),
            ),
            // No count recorded: at least one commit.
            event(
                "evt_3",
                "git.push",
                Some("rep_1"),
                Some("usr_bo"),
                json!({ "ref": "refs/heads/main", "after": "d", "before": "b", "defaultBranch": true }),
            ),
            // A mirror's push names nobody.
            event(
                "evt_4",
                "git.push",
                Some("rep_1"),
                None,
                json!({ "ref": "refs/heads/main", "after": "e", "before": "d", "defaultBranch": true, "mirrored": true, "commits": 3 }),
            ),
            // A tag is not a push to a branch.
            event(
                "evt_5",
                "git.push",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "ref": "refs/tags/v1", "after": "e", "defaultBranch": false }),
            ),
        ];
        let digest = shape(&args(), &events, None, true);
        assert_eq!(digest.repos.len(), 1);
        let pushes = &digest.repos[0].pushes;
        assert_eq!((pushes.count, pushes.commits), (4, 13));
        assert_eq!(pushes.branches, vec!["fix", "main"]);
        assert_eq!(
            pushes.by,
            vec![
                PushesBy {
                    actor: "user:usr_ana".into(),
                    count: 2,
                    commits: 9
                },
                PushesBy {
                    actor: "".into(),
                    count: 1,
                    commits: 3
                },
                PushesBy {
                    actor: "user:usr_bo".into(),
                    count: 1,
                    commits: 1
                },
            ]
        );
        assert_eq!(
            (pushes.default_branch.count, pushes.default_branch.commits),
            (3, 11)
        );
        assert_eq!(
            pushes.default_branch.last_at.as_deref(),
            Some("2026-10-09T14:00:00.000Z")
        );
        assert!(digest.folios.is_none());
        assert!(digest.complete);
    }

    #[test]
    fn work_is_counted_per_repository_by_who_did_it() {
        let g1t = Some("usr_g1t_agent");
        let events = vec![
            event(
                "evt_1",
                "pull.opened",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "number": 1 }),
            ),
            event(
                "evt_2",
                "pull.opened",
                Some("rep_1"),
                g1t,
                json!({ "number": 2 }),
            ),
            event(
                "evt_3",
                "pull.merged",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "number": 2 }),
            ),
            event(
                "evt_4",
                "pull.closed",
                Some("rep_2"),
                Some("usr_bo"),
                json!({ "number": 3 }),
            ),
            event(
                "evt_5",
                "issue.opened",
                Some("rep_2"),
                Some("usr_bo"),
                json!({ "number": 4 }),
            ),
            event(
                "evt_6",
                "issue.closed",
                Some("rep_2"),
                g1t,
                json!({ "number": 4 }),
            ),
            // A person's review is a comment with a verdict; g1t's is review.completed.
            event(
                "evt_7",
                "comment.created",
                Some("rep_1"),
                Some("usr_bo"),
                json!({ "number": 1, "verdict": "approve" }),
            ),
            event(
                "evt_8",
                "review.completed",
                Some("rep_1"),
                g1t,
                json!({ "number": 1, "verdict": "approve" }),
            ),
            // A workspace agent's comment as itself is the agent's, not the person's it acted for.
            event(
                "evt_9",
                "comment.created",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "number": 1, "agent": { "id": "agt_margo", "handle": "margo" } }),
            ),
            event(
                "evt_a",
                "comment.created",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "number": 1 }),
            ),
            event(
                "evt_b",
                "deployment.succeeded",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "kind": "production" }),
            ),
            event(
                "evt_c",
                "deployment.succeeded",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "kind": "preview" }),
            ),
            event(
                "evt_d",
                "deployment.failed",
                Some("rep_1"),
                g1t,
                json!({ "kind": "production" }),
            ),
            event(
                "evt_e",
                "release.published",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "tagName": "v1.2.0", "release": { "name": "Autumn" } }),
            ),
            event(
                "evt_f",
                "package.published",
                Some("rep_1"),
                Some("usr_bo"),
                json!({ "ecosystem": "container", "name": "web", "version": "1.2.0" }),
            ),
            // Not counted.
            event(
                "evt_g",
                "pull.updated",
                Some("rep_1"),
                Some("usr_ana"),
                json!({ "number": 1 }),
            ),
        ];
        let digest = shape(&args(), &events, None, false);
        assert!(!digest.complete);
        assert_eq!(digest.repos.len(), 2);
        let web = &digest.repos[0];
        assert_eq!(web.repo_id, "rep_1");
        assert_eq!(
            web.pulls.opened,
            vec![
                ActorCount {
                    actor: "user:usr_ana".into(),
                    count: 1
                },
                ActorCount {
                    actor: "user:usr_g1t_agent".into(),
                    count: 1
                }
            ]
        );
        assert_eq!(
            web.pulls.merged,
            vec![ActorCount {
                actor: "user:usr_ana".into(),
                count: 1
            }]
        );
        assert!(web.pulls.closed.is_empty());
        assert_eq!(
            web.reviews,
            vec![
                ActorCount {
                    actor: "user:usr_bo".into(),
                    count: 1
                },
                ActorCount {
                    actor: "user:usr_g1t_agent".into(),
                    count: 1
                }
            ]
        );
        assert_eq!(
            web.comments,
            vec![
                ActorCount {
                    actor: "agent:agt_margo".into(),
                    count: 1
                },
                ActorCount {
                    actor: "user:usr_ana".into(),
                    count: 1
                }
            ]
        );
        assert_eq!(
            web.deployments.succeeded,
            vec![ActorCount {
                actor: "user:usr_ana".into(),
                count: 2
            }]
        );
        assert_eq!(
            web.deployments.failed,
            vec![ActorCount {
                actor: "user:usr_g1t_agent".into(),
                count: 1
            }]
        );
        assert_eq!(web.deployments.production, 1);
        assert_eq!(
            web.releases,
            vec![ReleaseDigest {
                tag: "v1.2.0".into(),
                name: Some("Autumn".into()),
                actor: "user:usr_ana".into(),
                at: "2026-10-09T1e:00:00.000Z".into()
            }]
        );
        assert_eq!(web.packages[0].name, "web");
        assert_eq!(web.packages[0].actor, "user:usr_bo");
        let api = &digest.repos[1];
        assert_eq!(
            api.pulls.closed,
            vec![ActorCount {
                actor: "user:usr_bo".into(),
                count: 1
            }]
        );
        assert_eq!(
            api.issues.opened,
            vec![ActorCount {
                actor: "user:usr_bo".into(),
                count: 1
            }]
        );
        assert_eq!(
            api.issues.closed,
            vec![ActorCount {
                actor: "user:usr_g1t_agent".into(),
                count: 1
            }]
        );
        assert_eq!(api.pushes.count, 0);
    }

    #[test]
    fn folios_made_and_the_folios_whose_content_changed() {
        let folios = vec![
            event(
                "evt_1",
                "folio.created",
                None,
                Some("usr_ana"),
                json!({ "workspace": "acme", "folioId": "fol_1", "kind": "doc" }),
            ),
            event(
                "evt_2",
                "folio.updated",
                None,
                Some("usr_ana"),
                json!({ "workspace": "acme", "folioId": "fol_1", "kind": "doc", "authors": ["user:usr_ana", "agent:agt_margo"] }),
            ),
            event(
                "evt_3",
                "folio.updated",
                None,
                Some("usr_bo"),
                json!({ "workspace": "acme", "folioId": "fol_1", "kind": "doc", "authors": ["user:usr_bo"] }),
            ),
            // No authors named: the actor's.
            event(
                "evt_4",
                "folio.updated",
                None,
                Some("usr_bo"),
                json!({ "workspace": "acme", "folioId": "fol_2", "kind": "slides", "authors": [] }),
            ),
        ];
        let digest = shape(&args(), &[], Some(&folios), true);
        let folios = digest.folios.unwrap();
        assert_eq!(
            folios.created,
            vec![ActorCount {
                actor: "user:usr_ana".into(),
                count: 1
            }]
        );
        assert_eq!(folios.edited_count, 2);
        assert_eq!(
            folios.edited,
            vec![
                FolioEdited {
                    folio_id: "fol_1".into(),
                    kind: "doc".into(),
                    authors: vec![
                        "agent:agt_margo".into(),
                        "user:usr_ana".into(),
                        "user:usr_bo".into()
                    ]
                },
                FolioEdited {
                    folio_id: "fol_2".into(),
                    kind: "slides".into(),
                    authors: vec!["user:usr_bo".into()]
                },
            ]
        );
        // A workspace named but quiet still answers for its artifacts.
        let quiet = shape(&args(), &[], Some(&[]), true);
        assert_eq!(quiet.folios, Some(FolioDigest::default()));
        assert!(quiet.repos.is_empty());
    }
}
