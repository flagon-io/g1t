//! `why`: why a line of a file is the way it is.
//!
//! The line's commit comes from the repos service's blame; the merged pull
//! request it arrived in is the one whose head it is, or else the one whose
//! stretch of the default branch's history holds it (as the site's blame
//! view finds it, `apps/web/app/lib/provenance.server.ts`); then that pull
//! request's issue, its decision records, and the session entries recorded
//! around the commit.

use g1t_contracts::decisions::{Decision, ListDecisionsArgs, Why, WhyCommit, WhyIssue, WhyPull};
use g1t_contracts::repos::{Blame, BlameArgs, Commit, LogArgs, RepoPath};
use g1t_contracts::work::{IssueDetail, ListPullsArgs, Pull, PullStatus, SessionEntry, SessionEntryKind, State, ViewArgs};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::Value;
use worker::Result;

use crate::operations::Services;

/// How far back the default branch is read to place a commit.
const HISTORY_READ: u32 = 300;
/// How many steps of a session are shown for one commit.
const MAX_STEPS: usize = 8;
/// Longest a step's text is shown.
const MAX_STEP_CHARS: usize = 600;
/// Longest an issue's description is shown.
const MAX_BODY_CHARS: usize = 900;

/// The commit that last changed `line`, from a blame of the file.
pub(crate) fn commit_of_line(blame: &Blame, line: u32) -> Option<&Commit> {
    let range = blame.ranges.iter().find(|range| range.start <= line && line <= range.end)?;
    blame.commits.iter().find(|commit| commit.hash == range.commit)
}

/// The merged pull request `hash` arrived in: the one whose head it is,
/// or else the one whose stretch of `history` (the default branch, newest
/// first) holds it, from its head back to the commit it started from.
pub(crate) fn pull_for_commit<'a>(merged: &'a [Pull], history: &[String], hash: &str) -> Option<&'a Pull> {
    let merged: Vec<&Pull> = merged
        .iter()
        .filter(|pull| pull.status == PullStatus::Merged && pull.head_commit.is_some())
        .collect();
    if let Some(direct) = merged.iter().find(|pull| pull.head_commit.as_deref() == Some(hash)) {
        return Some(direct);
    }
    let position = |commit: &str| history.iter().position(|known| known == commit);
    let at = position(hash)?;
    let mut best: Option<(&Pull, usize)> = None;
    for pull in merged {
        let Some(head) = pull.head_commit.as_deref().and_then(position) else { continue };
        if head > at {
            continue;
        }
        if let Some(base) = pull.merge_base.as_deref().and_then(position)
            && base <= at
        {
            continue;
        }
        if best.is_none_or(|(_, best_head)| head > best_head) {
            best = Some((pull, head));
        }
    }
    best.map(|(pull, _)| pull)
}

/// The steps of a session behind `hash`: what was said and done between
/// the push before it and the push that carried it. Steps that touch
/// `file` come first; at most [`MAX_STEPS`], each cut to
/// [`MAX_STEP_CHARS`].
pub(crate) fn steps_for(session: &[SessionEntry], hash: &str, file: &str) -> Vec<SessionEntry> {
    // A push is noted "Pushed b1c42490059b."
    let pushed = |entry: &SessionEntry| -> Option<String> {
        if entry.kind != SessionEntryKind::Note {
            return None;
        }
        let rest = entry.text.strip_prefix("Pushed ")?;
        let short: String = rest.chars().take_while(char::is_ascii_hexdigit).collect();
        (short.len() >= 7).then_some(short)
    };
    let end = session.iter().position(|entry| {
        entry.commit.as_deref() == Some(hash) || pushed(entry).is_some_and(|short| hash.starts_with(&short))
    });
    let window: &[SessionEntry] = match end {
        Some(end) => {
            let mut start = end;
            while start > 0 && pushed(&session[start - 1]).is_none() {
                start -= 1;
            }
            &session[start..=end]
        }
        None => session,
    };
    let name = file.rsplit('/').next().unwrap_or(file);
    let useful: Vec<&SessionEntry> = window
        .iter()
        .filter(|entry| {
            entry.kind == SessionEntryKind::Message
                || (entry.kind == SessionEntryKind::ToolCall && (entry.text.contains(file) || entry.text.contains(name)))
        })
        .collect();
    let touching: Vec<&SessionEntry> = useful.iter().copied().filter(|entry| entry.text.contains(name)).collect();
    let mut chosen: Vec<&SessionEntry> = if touching.is_empty() {
        useful.clone()
    } else {
        touching.into_iter().chain(useful.iter().copied().filter(|entry| entry.kind == SessionEntryKind::Message)).collect()
    };
    chosen.sort_by_key(|entry| entry.seq);
    chosen.dedup_by_key(|entry| entry.seq);
    let skip = chosen.len().saturating_sub(MAX_STEPS);
    chosen
        .into_iter()
        .skip(skip)
        .map(|entry| {
            let mut entry = entry.clone();
            if entry.text.chars().count() > MAX_STEP_CHARS {
                entry.text = format!("{}…", entry.text.chars().take(MAX_STEP_CHARS).collect::<String>());
            }
            entry
        })
        .collect()
}

/// Answers `why`.
pub(crate) async fn why(
    services: &Services,
    viewer: &Viewer,
    repo: RepoPath,
    path: String,
    line: u32,
    git_ref: Option<String>,
) -> Result<Outcome<Value>> {
    let blame: Outcome<Blame> = g1t_kit::call(
        &services.repos,
        "blame",
        &BlameArgs {
            path: repo.clone(),
            viewer: viewer.clone(),
            git_ref,
            file_path: path.clone(),
        },
    )
    .await?;
    let blame = match blame {
        Outcome::Ok(blame) => blame,
        Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
    };
    let Some(found) = commit_of_line(&blame, line).cloned() else {
        let lines = blame.ranges.last().map_or(0, |range| range.end);
        return Ok(Outcome::fail(
            FailureCode::Invalid,
            format!("{path} has {lines} lines at that ref: give a line from 1 to {lines}."),
        ));
    };

    let closed: Outcome<Vec<Pull>> = g1t_kit::call(
        &services.work,
        "list_pulls",
        &ListPullsArgs {
            repo: repo.clone(),
            viewer: viewer.clone(),
            state: Some(State::Closed),
            label: None,
            milestone: None,
            base: None,
        },
    )
    .await?;
    let merged = match closed {
        Outcome::Ok(pulls) => pulls,
        Outcome::Fail(_) => Vec::new(),
    };
    // Who wrote it, by account: the address itself is never returned.
    let authors = crate::commits::read_authors(services, &[&found]).await;
    let username = crate::commits::username(&found, &authors).map(str::to_owned);
    let commit = WhyCommit::of(found, username);
    let mut pull = pull_for_commit(&merged, &[], &commit.hash).cloned();
    if pull.is_none() && !merged.is_empty() {
        let log: Outcome<Vec<Commit>> = g1t_kit::call(
            &services.repos,
            "log",
            &LogArgs {
                path: repo.clone(),
                viewer: viewer.clone(),
                git_ref: None,
                limit: HISTORY_READ,
            },
        )
        .await?;
        if let Outcome::Ok(log) = log {
            let history: Vec<String> = log.into_iter().map(|commit| commit.hash).collect();
            pull = pull_for_commit(&merged, &history, &commit.hash).cloned();
        }
    }

    let Some(pull) = pull else {
        return ok(Why { path, line, commit, pull: None, issue: None, decisions: Vec::new(), sessions: Vec::new() });
    };
    let view = |number: u32| ViewArgs { repo: repo.clone(), number, viewer: viewer.clone(), after_seq: 0 };
    // A few small reads, one after another: the API has no join helper.
    let issue = match pull.issue {
        Some(number) => match g1t_kit::call::<_, Outcome<IssueDetail>>(&services.work, "get_issue", &view(number)).await? {
            Outcome::Ok(detail) => Some(detail.issue),
            Outcome::Fail(_) => None,
        },
        None => None,
    };
    let decisions: Outcome<Vec<Decision>> = g1t_kit::call(
        &services.work,
        "list_decisions",
        &ListDecisionsArgs { repo: repo.clone(), viewer: viewer.clone(), number: pull.number },
    )
    .await?;
    let session: Outcome<Vec<SessionEntry>> = g1t_kit::call(&services.work, "read_session", &view(pull.number)).await?;
    let decisions = match decisions {
        Outcome::Ok(decisions) => decisions,
        Outcome::Fail(_) => Vec::new(),
    };
    let sessions = match session {
        Outcome::Ok(entries) => steps_for(&entries, &commit.hash, &path),
        Outcome::Fail(_) => Vec::new(),
    };
    let issue = issue.map(|issue| WhyIssue {
        number: issue.number,
        title: issue.title,
        state: if issue.state == State::Open { "open" } else { "closed" }.to_owned(),
        body: if issue.body.chars().count() > MAX_BODY_CHARS {
            format!("{}…", issue.body.chars().take(MAX_BODY_CHARS).collect::<String>())
        } else {
            issue.body
        },
    });
    let pull = WhyPull {
        number: pull.number,
        title: pull.title.clone(),
        author: pull.owner().username.clone(),
        agent: pull.agent.clone(),
        merged_by: pull.merged_by.clone(),
        merged_at: pull.merged_at.clone(),
    };
    ok(Why { path, line, commit, pull: Some(pull), issue, decisions, sessions })
}

fn ok(why: Why) -> Result<Outcome<Value>> {
    Ok(Outcome::Ok(serde_json::to_value(why)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::repos::{BlameRange, Signature};

    fn commit(hash: &str) -> Commit {
        Commit {
            hash: hash.into(),
            tree_hash: "t".into(),
            message: "m".into(),
            author: Signature { name: "Ana".into(), email: "ana@example.com".into() },
            parents: Vec::new(),
            authored_at: "2026-10-12T00:00:00Z".into(),
        }
    }

    fn merged(number: u32, head: &str, base: Option<&str>) -> Pull {
        serde_json::from_value(serde_json::json!({
            "id": format!("pr_{number}"), "repoId": "rep_1", "number": number, "issue": 9, "title": "t", "body": null,
            "agent": "claude-code", "runtime": "external", "status": "merged", "fork": null, "forkRepoId": null,
            "branch": "b", "headCommit": head, "mergeBase": base, "mergedBy": "ana", "mergedAt": "2026-10-12T00:00:00Z",
            "supersededBy": null, "checkStatus": null,
            "author": { "id": "usr_1", "username": "ana" },
            "createdAt": "", "updatedAt": ""
        }))
        .unwrap()
    }

    #[test]
    fn a_line_is_found_in_its_range() {
        let blame = Blame {
            head: "h".into(),
            ranges: vec![
                BlameRange { start: 1, end: 3, commit: "aaa".into() },
                BlameRange { start: 4, end: 4, commit: "bbb".into() },
            ],
            commits: vec![commit("aaa"), commit("bbb")],
            partial: false,
        };
        assert_eq!(commit_of_line(&blame, 3).map(|c| c.hash.as_str()), Some("aaa"));
        assert_eq!(commit_of_line(&blame, 4).map(|c| c.hash.as_str()), Some("bbb"));
        assert!(commit_of_line(&blame, 5).is_none());
    }

    #[test]
    fn a_commit_is_placed_in_the_pull_request_it_arrived_in() {
        // Newest first: m2 landed #12 on top of b1; m1 landed #11 on top of b0.
        let history: Vec<String> = ["m2", "c3", "c2", "b1", "m1", "c1", "b0"].map(String::from).to_vec();
        let pulls = vec![merged(11, "m1", Some("b0")), merged(12, "m2", Some("b1"))];
        assert_eq!(pull_for_commit(&pulls, &[], "m1").map(|p| p.number), Some(11));
        assert_eq!(pull_for_commit(&pulls, &history, "c2").map(|p| p.number), Some(12));
        assert_eq!(pull_for_commit(&pulls, &history, "c1").map(|p| p.number), Some(11));
        // Before any pull request.
        assert!(pull_for_commit(&pulls, &history, "b0").is_none());
        assert!(pull_for_commit(&pulls, &history, "zzz").is_none());
    }

    fn entry(seq: u32, kind: SessionEntryKind, text: &str, commit: Option<&str>) -> SessionEntry {
        SessionEntry { seq, kind, text: text.into(), tool: None, commit: commit.map(String::from), at: String::new() }
    }

    #[test]
    fn the_session_steps_are_those_behind_the_commit() {
        use SessionEntryKind::*;
        let session = vec![
            entry(1, Message, "Starting on the parser.", None),
            entry(2, Note, "Pushed 1111111aaaa.", None),
            entry(3, Message, "The lexer drops the last token.", None),
            entry(4, ToolCall, "Edit src/lexer.rs", None),
            entry(5, ToolCall, "Run cargo test", None),
            entry(6, Note, "Pushed 2222222bbbb.", None),
            entry(7, Message, "Now the docs.", None),
        ];
        let steps = steps_for(&session, "2222222bbbbcccc", "src/lexer.rs");
        let seqs: Vec<u32> = steps.iter().map(|step| step.seq).collect();
        assert_eq!(seqs, [3, 4]);
        // A commit no push names: the whole session is looked through.
        let all = steps_for(&session, "9999999", "src/lexer.rs");
        assert_eq!(all.iter().map(|s| s.seq).collect::<Vec<_>>(), [1, 3, 4, 7]);
        let long = vec![entry(1, Message, &"x".repeat(MAX_STEP_CHARS + 10), None)];
        assert!(steps_for(&long, "h", "a.rs")[0].text.ends_with('…'));
    }
}
