//! Asking a team to review a pull request (`g1t_contracts::teams`).
//!
//! A team is asked by a person (`update_pull` with `workspace/team` among
//! the reviewers) or by the CODEOWNERS file (codeowners.rs). The team is
//! kept in `team_reviewers`. With its review assignment off, everyone in
//! it, and in its child teams, is told. With it on, [`pick`] chooses
//! `count` people, who become reviewers themselves and are told; the rest
//! of the team is told too only when the team says so.
//!
//! [`pick`] never chooses the pull request's author, `g1t`, anyone the
//! team leaves out, or (with `skip_busy`) anyone with `busy_at` or more
//! pull requests waiting on their review. People from the team already
//! asked count towards `count`. Round robin puts whoever this team asked
//! least recently first (never asked before first of all); load balance,
//! whoever has the fewest pull requests waiting on them, then the same.
//! Ties go by username, so the same facts always pick the same people.

use std::collections::HashMap;

use g1t_contracts::events::{PullEvent, TeamRequested};
use g1t_contracts::identity::AGENT_NAME;
use g1t_contracts::repos::RepoPath;
use g1t_contracts::teams::{ResolveTeamsArgs, ResolvedTeam, ReviewAlgorithm, ReviewAssignment, TeamVisibility};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::Pull;
use g1t_contracts::{FailureCode, Outcome, Role, User};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

/// Someone review assignment could pick.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub username: String,
    /// When this team last had them asked (RFC 3339), if ever.
    pub last_asked: Option<String>,
    /// Open pull requests waiting on their review.
    pub waiting: u32,
}

/// Who to ask from a team: see the module's notes.
pub(crate) fn pick(candidates: &[Candidate], settings: &ReviewAssignment, author: &str, already: &[String]) -> Vec<String> {
    let author = author.to_lowercase();
    let in_team_already = candidates
        .iter()
        .filter(|candidate| already.iter().any(|name| name.eq_ignore_ascii_case(&candidate.username)))
        .count() as u32;
    let wanted = settings.count.saturating_sub(in_team_already) as usize;
    let mut eligible: Vec<&Candidate> = candidates
        .iter()
        .filter(|candidate| {
            let name = candidate.username.to_lowercase();
            name != author
                && name != AGENT_NAME
                && !settings.excluded.iter().any(|excluded| excluded.eq_ignore_ascii_case(&name))
                && !already.iter().any(|had| had.eq_ignore_ascii_case(&name))
                && !(settings.skip_busy && candidate.waiting >= settings.busy_at)
        })
        .collect();
    // `None` (never asked) sorts before any time.
    let by_turn = |a: &&Candidate, b: &&Candidate| a.last_asked.cmp(&b.last_asked).then_with(|| a.username.cmp(&b.username));
    match settings.algorithm {
        ReviewAlgorithm::RoundRobin => eligible.sort_by(by_turn),
        ReviewAlgorithm::LoadBalance => eligible.sort_by(|a, b| a.waiting.cmp(&b.waiting).then_with(|| by_turn(a, b))),
    }
    let mut picked: Vec<String> = Vec::new();
    for candidate in eligible {
        if picked.len() >= wanted {
            break;
        }
        if !picked.contains(&candidate.username) {
            picked.push(candidate.username.clone());
        }
    }
    picked
}

/// Who a request for `team` tells and asks, given who was picked: with
/// assignment off, everyone (never the author or g1t); with it on, the
/// people picked, and everyone else too when the team says so.
pub(crate) fn told(team: &ResolvedTeam, picked: &[String], author: &str) -> TeamRequested {
    let everyone: Vec<String> = team
        .everyone()
        .map(|person| person.username.clone())
        .filter(|name| !name.eq_ignore_ascii_case(author) && name != AGENT_NAME)
        .collect();
    let settings = &team.review_assignment;
    let notified = if !settings.enabled {
        everyone
    } else if settings.notify_team {
        let mut all = picked.to_vec();
        all.extend(everyone.into_iter().filter(|name| !picked.contains(name)));
        all
    } else {
        picked.to_vec()
    };
    TeamRequested {
        team: format!("{}/{}", team.workspace, team.slug),
        notified,
        assigned: if settings.enabled { picked.to_vec() } else { Vec::new() },
    }
}

/// The most teams one pull request asks to review.
const MAX_TEAMS: usize = 10;

/// Whether `actor` may ask `team` to review: it is a team of the
/// repository's workspace, and a secret one only for its own people and
/// the workspace's owners.
pub(crate) fn may_ask(team: &ResolvedTeam, actor: &User, namespace: &str) -> Result<(), String> {
    let handle = team.handle();
    if !team.workspace.eq_ignore_ascii_case(namespace) {
        return Err(format!("Only teams of {namespace} can be asked to review its pull requests, and {handle} is not one."));
    }
    let owner = actor.role_in(&namespace.to_lowercase()) == Some(Role::Owner);
    if team.visibility == TeamVisibility::Secret && !owner && !team.everyone().any(|person| person.id == actor.id) {
        return Err(format!("There is no team named {handle}."));
    }
    Ok(())
}

/// `workspace/team`, or `@workspace/team`, as written among reviewers.
pub(crate) fn team_name(text: &str) -> Option<String> {
    let text = text.trim().trim_start_matches('@').to_lowercase();
    let (workspace, slug) = text.split_once('/')?;
    (g1t_contracts::is_valid_namespace(workspace) && g1t_contracts::teams::is_valid_slug(slug))
        .then(|| format!("{workspace}/{slug}"))
}

#[derive(Deserialize)]
struct LastRow {
    username: String,
    last: String,
}

#[derive(Deserialize)]
struct WaitingRow {
    username: String,
    n: u32,
}

impl Work {
    /// The teams `names` asks to review, checked: each exists, is the
    /// repository's workspace's, and the actor may ask it.
    pub(crate) async fn valid_team_reviewers(
        &self,
        actor: &User,
        repo: &RepoPath,
        pull: &Pull,
        names: Vec<String>,
    ) -> Result<Outcome<Vec<String>>> {
        let mut wanted: Vec<String> = Vec::new();
        for name in names.iter().filter_map(|name| team_name(name)) {
            if !wanted.contains(&name) {
                wanted.push(name);
            }
        }
        if wanted.len() > MAX_TEAMS {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("A pull request can ask at most {MAX_TEAMS} teams to review it."),
            ));
        }
        let found = self.resolve_teams(&wanted, &pull.repo_id).await?;
        for name in &wanted {
            let Some(team) = found.iter().find(|team| format!("{}/{}", team.workspace, team.slug) == *name) else {
                return Ok(Outcome::fail(FailureCode::Invalid, format!("There is no team named @{name}.")));
            };
            // A team already asked stays, whoever asks now.
            if pull.team_reviewers.contains(name) {
                continue;
            }
            if let Err(why) = may_ask(team, actor, &repo.namespace) {
                return Ok(Outcome::fail(FailureCode::Invalid, why));
            }
        }
        Ok(Outcome::Ok(wanted))
    }

    /// Asks more people and teams to review, keeping who is asked already:
    /// what CODEOWNERS asks for (codeowners.rs).
    pub(crate) async fn ask_reviewers(
        &self,
        pull: &Pull,
        people: Vec<String>,
        teams: Vec<String>,
        actor: Option<&User>,
        code_owners: bool,
    ) -> Result<()> {
        let mut all_people = pull.reviewers.clone();
        all_people.extend(people.into_iter().filter(|name| !pull.reviewers.contains(name)));
        let mut all_teams = pull.team_reviewers.clone();
        all_teams.extend(teams.into_iter().filter(|team| !pull.team_reviewers.contains(team)));
        self.set_reviewers(pull, all_people, all_teams, actor, code_owners).await
    }

    /// Makes `people` and `teams` the ones asked to review `pull`: newly
    /// asked teams pick their people (and record it), the timeline says
    /// who was asked or no longer is, and `pull.review_requested` and
    /// `pull.review_request_removed` say so to the inbox and webhooks.
    /// `actor` is whoever asked; none for g1t.
    pub(crate) async fn set_reviewers(
        &self,
        pull: &Pull,
        mut people: Vec<String>,
        teams: Vec<String>,
        actor: Option<&User>,
        code_owners: bool,
    ) -> Result<()> {
        let new_teams: Vec<String> = teams.iter().filter(|team| !pull.team_reviewers.contains(team)).cloned().collect();
        let resolved = self.resolve_teams(&new_teams, &pull.repo_id).await?;
        let asked = self.ask_teams(pull, &resolved, &people).await?;
        for request in &asked {
            for name in &request.assigned {
                if !people.contains(name) {
                    people.push(name.clone());
                }
            }
        }
        self.db
            .prepare("UPDATE pulls SET reviewers = ?, team_reviewers = ?, updated_at = ? WHERE id = ?")
            .bind(&[
                serde_json::to_string(&people)?.into(),
                serde_json::to_string(&teams)?.into(),
                rfc3339(now_ms()).into(),
                pull.id.as_str().into(),
            ])?
            .run()
            .await?;
        let g1t = User {
            id: crate::lifecycle::POLICY_ACTOR_ID.to_owned(),
            username: crate::lifecycle::POLICY_ACTOR_NAME.to_owned(),
            ..User::default()
        };
        let who = actor.unwrap_or(&g1t);
        let handles = |names: &[String]| names.iter().map(|name| format!("@{name}")).collect::<Vec<_>>();
        let verbs = ("requested a review from", "withdrew the request for a review from");
        self.note_changes(&pull.repo_id, pull.number, who, &pull.reviewers, &people, verbs)
            .await?;
        self.note_changes(&pull.repo_id, pull.number, who, &handles(&pull.team_reviewers), &handles(&teams), verbs)
            .await?;
        let newly = |after: &[String], before: &[String]| -> Vec<String> {
            after.iter().filter(|name| !before.contains(name)).cloned().collect()
        };
        let added = newly(&people, &pull.reviewers);
        let removed = newly(&pull.reviewers, &people);
        let teams_removed: Vec<TeamRequested> = newly(&pull.team_reviewers, &teams)
            .into_iter()
            .map(|team| TeamRequested {
                team,
                ..TeamRequested::default()
            })
            .collect();
        let mut events: Vec<(&'static str, PullEvent)> = Vec::new();
        if !added.is_empty() || !asked.is_empty() {
            events.push((
                "pull.review_requested",
                PullEvent {
                    reviewers: Some(added),
                    teams: (!asked.is_empty()).then_some(asked),
                    code_owners,
                    ..Self::pull_event(pull)
                },
            ));
        }
        if !removed.is_empty() || !teams_removed.is_empty() {
            events.push((
                "pull.review_request_removed",
                PullEvent {
                    reviewers: Some(removed),
                    teams: (!teams_removed.is_empty()).then_some(teams_removed),
                    ..Self::pull_event(pull)
                },
            ));
        }
        for (kind, data) in events {
            self.publish_as(kind, &pull.repo_id, actor.map(|actor| actor.id.clone()), data)
                .await?;
        }
        Ok(())
    }

    /// The teams named, as identity knows them, with their roles on the
    /// repository.
    pub(crate) async fn resolve_teams(&self, names: &[String], repo_id: &str) -> Result<Vec<ResolvedTeam>> {
        if names.is_empty() {
            return Ok(Vec::new());
        }
        g1t_kit::call(
            &self.identity,
            "resolve_teams",
            &ResolveTeamsArgs {
                teams: names.to_vec(),
                repo_id: Some(repo_id.to_owned()),
                asker: None,
            },
        )
        .await
    }

    /// How many open pull requests wait on each person's review: they are
    /// asked and have not given a verdict.
    async fn waiting_on(&self, usernames: &[String]) -> Result<HashMap<String, u32>> {
        if usernames.is_empty() {
            return Ok(HashMap::new());
        }
        let rows = self
            .db
            .prepare(
                "SELECT r.value AS username, count(*) AS n FROM pulls p, json_each(p.reviewers) r
                 WHERE p.status IN ('draft', 'open') AND r.value IN (SELECT value FROM json_each(?1))
                   AND NOT EXISTS (
                     SELECT 1 FROM comments c WHERE c.repo_id = p.repo_id AND c.number = p.number
                       AND lower(c.author_name) = r.value AND c.verdict IS NOT NULL
                   )
                 GROUP BY r.value",
            )
            .bind(&[serde_json::to_string(usernames)?.into()])?
            .all()
            .await?
            .results::<WaitingRow>()?;
        Ok(rows.into_iter().map(|row| (row.username, row.n)).collect())
    }

    /// When the team last had each person asked.
    async fn last_asked(&self, team_id: &str) -> Result<HashMap<String, String>> {
        let rows = self
            .db
            .prepare("SELECT username, max(requested_at) AS last FROM team_review_requests WHERE team_id = ? GROUP BY username")
            .bind(&[team_id.into()])?
            .all()
            .await?
            .results::<LastRow>()?;
        Ok(rows.into_iter().map(|row| (row.username, row.last)).collect())
    }

    /// Asks each team to review `pull`: picks people where the team assigns
    /// reviews, and records who was picked. `reviewers` are the people
    /// already asked. Returns, per team, who is told and who was picked.
    pub(crate) async fn ask_teams(&self, pull: &Pull, teams: &[ResolvedTeam], reviewers: &[String]) -> Result<Vec<TeamRequested>> {
        let author = pull.owner().username.clone();
        let mut asked = Vec::new();
        let mut already = reviewers.to_vec();
        for team in teams {
            let settings = &team.review_assignment;
            let picked = if settings.enabled {
                let pool: Vec<String> = if settings.include_child_teams {
                    team.everyone().map(|person| person.username.clone()).collect()
                } else {
                    team.members.iter().map(|person| person.username.clone()).collect()
                };
                let (last, waiting) = futures_util::future::try_join(self.last_asked(&team.id), self.waiting_on(&pool)).await?;
                let candidates: Vec<Candidate> = pool
                    .iter()
                    .map(|name| Candidate {
                        username: name.clone(),
                        last_asked: last.get(name).cloned(),
                        waiting: waiting.get(name).copied().unwrap_or(0),
                    })
                    .collect();
                let picked = pick(&candidates, settings, &author, &already);
                let now = rfc3339(now_ms());
                for name in &picked {
                    self.db
                        .prepare(
                            "INSERT INTO team_review_requests (team_id, username, repo_id, number, requested_at)
                             VALUES (?, ?, ?, ?, ?)",
                        )
                        .bind(&[
                            team.id.as_str().into(),
                            name.as_str().into(),
                            pull.repo_id.as_str().into(),
                            pull.number.into(),
                            now.as_str().into(),
                        ])?
                        .run()
                        .await?;
                }
                picked
            } else {
                Vec::new()
            };
            already.extend(picked.iter().cloned());
            asked.push(told(team, &picked, &author));
        }
        Ok(asked)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::teams::TeamPerson;

    fn candidate(name: &str, last: Option<&str>, waiting: u32) -> Candidate {
        Candidate {
            username: name.to_owned(),
            last_asked: last.map(str::to_owned),
            waiting,
        }
    }

    fn assigning(algorithm: ReviewAlgorithm, count: u32) -> ReviewAssignment {
        ReviewAssignment {
            enabled: true,
            algorithm,
            count,
            ..ReviewAssignment::default()
        }
    }

    fn team() -> Vec<Candidate> {
        vec![
            candidate("ana", Some("2026-10-05T10:00:00.000Z"), 1),
            candidate("bo", None, 4),
            candidate("cy", Some("2026-10-01T10:00:00.000Z"), 0),
            candidate("dee", Some("2026-10-06T10:00:00.000Z"), 0),
            candidate("eve", None, 2),
        ]
    }

    #[test]
    fn round_robin_asks_whoever_was_asked_least_recently() {
        let settings = assigning(ReviewAlgorithm::RoundRobin, 3);
        // Never asked first (by name), then the oldest.
        assert_eq!(pick(&team(), &settings, "zed", &[]), vec!["bo", "eve", "cy"]);
        // The same facts, the same people, every time.
        assert_eq!(pick(&team(), &settings, "zed", &[]), pick(&team(), &settings, "zed", &[]));
    }

    #[test]
    fn round_robin_moves_on_as_people_are_asked() {
        let settings = assigning(ReviewAlgorithm::RoundRobin, 1);
        let mut people = team();
        let mut asked = Vec::new();
        for turn in 0..5 {
            let picked = pick(&people, &settings, "zed", &[]);
            assert_eq!(picked.len(), 1);
            let name = picked[0].clone();
            let person = people.iter_mut().find(|person| person.username == name).unwrap();
            person.last_asked = Some(format!("2026-10-07T10:00:0{turn}.000Z"));
            asked.push(name);
        }
        // Everyone once before anyone twice.
        let mut sorted = asked.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["ana", "bo", "cy", "dee", "eve"]);
        assert_eq!(asked, vec!["bo", "eve", "cy", "ana", "dee"]);
    }

    #[test]
    fn load_balance_asks_whoever_has_the_least_waiting() {
        let settings = assigning(ReviewAlgorithm::LoadBalance, 2);
        // cy and dee have nothing waiting; cy was asked longer ago.
        assert_eq!(pick(&team(), &settings, "zed", &[]), vec!["cy", "dee"]);
        let settings = assigning(ReviewAlgorithm::LoadBalance, 4);
        assert_eq!(pick(&team(), &settings, "zed", &[]), vec!["cy", "dee", "ana", "eve"]);
    }

    #[test]
    fn the_author_g1t_and_those_left_out_are_never_asked() {
        let mut people = team();
        people.push(candidate("g1t", None, 0));
        let settings = ReviewAssignment {
            excluded: vec!["eve".into()],
            ..assigning(ReviewAlgorithm::RoundRobin, 10)
        };
        let picked = pick(&people, &settings, "BO", &[]);
        assert_eq!(picked, vec!["cy", "ana", "dee"]);
    }

    #[test]
    fn busy_people_are_skipped_when_the_team_says_so() {
        let settings = ReviewAssignment {
            skip_busy: true,
            busy_at: 2,
            ..assigning(ReviewAlgorithm::RoundRobin, 10)
        };
        // bo (4) and eve (2) are busy.
        assert_eq!(pick(&team(), &settings, "zed", &[]), vec!["cy", "ana", "dee"]);
    }

    #[test]
    fn people_already_asked_count_towards_the_number() {
        let settings = assigning(ReviewAlgorithm::RoundRobin, 2);
        assert_eq!(pick(&team(), &settings, "zed", &["bo".into()]), vec!["eve"]);
        assert!(pick(&team(), &settings, "zed", &["bo".into(), "Cy".into()]).is_empty());
        // Someone asked who is not in the team does not count.
        assert_eq!(pick(&team(), &settings, "zed", &["outsider".into()]), vec!["bo", "eve"]);
    }

    fn resolved(enabled: bool, notify_team: bool) -> ResolvedTeam {
        let person = |name: &str| TeamPerson {
            id: format!("usr_{name}"),
            username: name.to_owned(),
        };
        ResolvedTeam {
            id: "team_1".into(),
            workspace: "acme".into(),
            slug: "backend".into(),
            members: vec![person("ana"), person("bo"), person("cy")],
            child_members: vec![person("dee")],
            review_assignment: ReviewAssignment {
                enabled,
                notify_team,
                ..ReviewAssignment::default()
            },
            ..ResolvedTeam::default()
        }
    }

    #[test]
    fn a_request_tells_the_whole_team_or_the_people_picked() {
        // Off: everyone, child teams too, never the author.
        let all = told(&resolved(false, false), &[], "bo");
        assert_eq!(all.team, "acme/backend");
        assert_eq!(all.notified, vec!["ana", "cy", "dee"]);
        assert!(all.assigned.is_empty());
        // On: the people picked.
        let picked = told(&resolved(true, false), &["cy".into()], "bo");
        assert_eq!(picked.notified, vec!["cy"]);
        assert_eq!(picked.assigned, vec!["cy"]);
        // On, telling the team too: the picked first.
        let both = told(&resolved(true, true), &["cy".into()], "bo");
        assert_eq!(both.notified, vec!["cy", "ana", "dee"]);
    }

    #[test]
    fn only_the_workspaces_teams_are_asked_and_secret_ones_by_their_people() {
        let actor = |id: &str, role: Option<Role>| User {
            id: id.to_owned(),
            username: id.to_owned(),
            workspaces: role
                .map(|role| g1t_contracts::Membership {
                    role,
                    ..g1t_contracts::Membership::member("acme")
                })
                .into_iter()
                .collect(),
            ..User::default()
        };
        let mut team = resolved(false, false);
        assert!(may_ask(&team, &actor("usr_zed", Some(Role::Member)), "acme").is_ok());
        assert!(may_ask(&team, &actor("usr_zed", Some(Role::Member)), "globex").is_err());
        team.visibility = TeamVisibility::Secret;
        assert!(may_ask(&team, &actor("usr_zed", Some(Role::Member)), "acme").is_err());
        assert!(may_ask(&team, &actor("usr_ana", Some(Role::Member)), "acme").is_ok());
        // Through a child team too.
        assert!(may_ask(&team, &actor("usr_dee", Some(Role::Member)), "acme").is_ok());
        assert!(may_ask(&team, &actor("usr_zed", Some(Role::Owner)), "acme").is_ok());
    }

    #[test]
    fn teams_are_named_workspace_slash_slug() {
        assert_eq!(team_name("@Acme/Backend").as_deref(), Some("acme/backend"));
        assert_eq!(team_name("acme/backend").as_deref(), Some("acme/backend"));
        assert_eq!(team_name("ana"), None);
        assert_eq!(team_name("acme/"), None);
    }
}
