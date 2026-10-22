//! Opening and changing work items: `open_work_item`, `update_work_item`,
//! `close_work_item` and `reopen_work_item`, and what each says.

use g1t_contracts::access::{self, Capability, RepoRef};
use g1t_contracts::events::{EventLabel, WorkItemEvent};
use g1t_contracts::repos::Repo;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use worker::Result;

use super::landing::Landing;
use super::rows::{Held, no_item, path_of, workspace_of};
use crate::{UNVERIFIED, Work, optional, optional_number, valid_title};

/// What closing work item `number` by a commit in `landed_in` says when it
/// stays open: the targets it still has to land in (`missing`, by path; an
/// empty one for a repository the actor may not read).
pub(crate) fn still_open(number: u32, landed_in: &str, missing: &[String]) -> String {
    let named: Vec<&str> = missing.iter().map(String::as_str).filter(|path| !path.is_empty()).collect();
    let hidden = missing.len() - named.len();
    let mut targets = named.join(", ");
    if hidden > 0 {
        let more = if hidden == 1 { "1 other repository".to_owned() } else { format!("{hidden} other repositories") };
        targets = if targets.is_empty() { more } else { format!("{targets} and {more}") };
    }
    format!("Recorded the commit as landed in {landed_in}, but #{number} stays open until it lands in {targets} too.")
}

impl Work {
    pub(super) fn item_event(held: &Held) -> WorkItemEvent {
        WorkItemEvent {
            item_id: held.item.id.clone(),
            workspace: held.item.workspace.clone(),
            number: held.item.number,
            repo_ids: held.repo_ids(),
            author: Some((&held.item.author).into()),
            requested_by: held.item.requested_by.as_ref().map(Into::into),
            ..WorkItemEvent::default()
        }
    }

    /// Publishes a `work_item.*` event about `held`, filed under its origin.
    pub(super) async fn publish_item(&self, kind: &'static str, held: &Held, actor: Option<&User>, data: WorkItemEvent) -> Result<()> {
        let data = g1t_contracts::events::marked(data, actor);
        self.publish_on(kind, held.event_repo(), actor.map(|actor| actor.id.clone()), data).await
    }

    /// Notes something that happened to a work item, in its conversation.
    pub(super) async fn note_item<'a>(&self, item_id: &str, author: impl Into<crate::rows::By<'a>>, text: &str) -> Result<()> {
        self.note_on(crate::On::Item(item_id), author.into(), text).await
    }

    // --- RPC methods ----------------------------------------------------------

    pub(crate) async fn open_work_item(&self, a: OpenWorkItemArgs) -> Result<Outcome<WorkItem>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let title = match valid_title(&a.title) {
            Ok(title) => title.to_owned(),
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let Some(labels) = normalize_labels(&a.labels) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("A work item can have up to {MAX_LABELS} labels of up to {MAX_LABEL_CHARS} characters each."),
            ));
        };
        let workspace = workspace_of(&a.workspace, a.repo.as_ref());
        if workspace.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say which workspace, or which repository it is filed from."));
        }
        // Numbered only once the issues before it are, so every new number
        // comes after the old ones.
        if !self.items_moved().await? {
            return Ok(super::labels::still_moving());
        }
        let actor = Some(a.actor.clone());
        // Where it is filed from: someone who may take part there may file
        // it; without one, only a member of the workspace.
        let origin = match &a.repo {
            Some(path) => {
                let repo = check!(self.repo(path, &actor).await?);
                if !repo.namespace.eq_ignore_ascii_case(&workspace) {
                    return Ok(Outcome::fail(FailureCode::Invalid, format!("{} is not a repository of {workspace}.", path_of(&repo))));
                }
                check!(crate::retired::writable(&repo));
                check!(crate::allowed(Some(&a.actor), &repo, Capability::Participate));
                if !self.work_items_enabled(&repo).await? {
                    return Ok(Outcome::fail(FailureCode::Forbidden, crate::settings::work_items_off(&repo)));
                }
                self.remember_repo(&repo).await?;
                Some(repo)
            }
            None => {
                if access::workspace_role(&a.actor, &workspace).is_none() {
                    return Ok(Outcome::fail(
                        FailureCode::Forbidden,
                        format!("Only members of {workspace} can file a work item there without a repository to file it from."),
                    ));
                }
                None
            }
        };
        let origin_ref = origin.as_ref().map(RepoRef::from);
        let may = |capability| access::can_item(Some(&a.actor), &workspace, origin_ref, capability);
        // The project it is filed in, as putting it there afterwards would.
        let project = match a.project.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
            Some(key) => {
                if !may(Capability::Triage) {
                    return Ok(Outcome::fail(FailureCode::Forbidden, access::needs_on_item(Capability::Triage, &workspace)));
                }
                check!(self.project_ref(&workspace, key).await?)
            }
            None => None,
        };
        // Where it should land: repositories of the workspace the actor can
        // see; without any given, its project's default targets they can.
        let defaulted = a.targets.is_empty() && project.is_some();
        let asked = match &project {
            Some(project) if defaulted => self.default_targets(&project.id).await?,
            _ => a.targets.clone(),
        };
        let mut targets: Vec<Repo> = Vec::new();
        for path in &asked {
            let repo = match self.repo(path, &actor).await? {
                Outcome::Ok(repo) => repo,
                Outcome::Fail(_) if defaulted => continue,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            if !repo.namespace.eq_ignore_ascii_case(&workspace) {
                return Ok(Outcome::fail(FailureCode::Invalid, format!("{} is not a repository of {workspace}.", path_of(&repo))));
            }
            if origin.as_ref().is_some_and(|origin| origin.id == repo.id) || targets.iter().any(|known| known.id == repo.id) {
                continue;
            }
            self.remember_repo(&repo).await?;
            targets.push(repo);
        }
        if !targets.is_empty() && origin.is_some() && !may(Capability::Triage) {
            return Ok(Outcome::fail(FailureCode::Forbidden, access::needs_on_item(Capability::Triage, &workspace)));
        }
        let colors = check!(self.ensure_labels(&a.actor, &workspace, &labels).await?);
        let milestone = match a.milestone.filter(|number| *number > 0) {
            Some(number) => {
                if !may(Capability::Triage) {
                    return Ok(Outcome::fail(FailureCode::Forbidden, access::needs_on_item(Capability::Triage, &workspace)));
                }
                check!(self.milestone_ref(&workspace, number).await?)
            }
            None => None,
        };
        let parent_id = check!(self.parent_for_new(&workspace, &a.actor, a.parent).await?);
        let now = now_ms();
        let id = new_id("wki", now);
        let number = self.next_number(&workspace, origin.as_ref().map(|repo| repo.id.as_str())).await?;
        let timestamp = rfc3339(now);
        let (author, requested_by) = authorship(&a.actor);
        let mut statements = vec![self
            .db
            .prepare(
                "INSERT INTO work_items
                   (id, workspace, number, title, body, labels, author_id, author_name, requested_by_id,
                    requested_by_name, created_at, updated_at, milestone, parent_id, project_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                workspace.as_str().into(),
                number.into(),
                title.as_str().into(),
                a.body.trim().into(),
                serde_json::to_string(&labels)?.into(),
                author.id.as_str().into(),
                author.username.as_str().into(),
                optional(&requested_by.as_ref().map(|user| user.id.clone())),
                optional(&requested_by.as_ref().map(|user| user.username.clone())),
                timestamp.as_str().into(),
                timestamp.as_str().into(),
                optional_number(milestone.as_ref().map(|milestone| milestone.number)),
                optional(&parent_id),
                optional(&project.as_ref().map(|project| project.id.clone())),
            ])?];
        let links = origin.iter().map(|repo| (repo, LinkRole::Origin)).chain(targets.iter().map(|repo| (repo, LinkRole::Target)));
        for (repo, role) in links {
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO work_item_repos (item_id, repo_id, role, path, added_at, added_by)
                         VALUES (?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        id.as_str().into(),
                        repo.id.as_str().into(),
                        role.as_str().into(),
                        path_of(repo).into(),
                        timestamp.as_str().into(),
                        a.actor.id.as_str().into(),
                    ])?,
            );
        }
        self.db.batch(statements).await?;
        let Some(held) = self.item_by_id(&id).await? else {
            return Ok(no_item());
        };
        self.publish_item("work_item.opened", &held, Some(&a.actor), WorkItemEvent { title: Some(held.item.title.clone()), ..Self::item_event(&held) })
            .await?;
        // Opened with labels and a milestone: each is said, as it would be
        // if they were added afterwards, without notes in the conversation.
        for label in &held.item.labels {
            let color = colors.iter().find(|(name, _)| name == label).map_or_else(|| label_color_for(label), |(_, c)| c.clone());
            let label = Some(EventLabel { name: label.clone(), color });
            self.publish_item("work_item.labeled", &held, Some(&a.actor), WorkItemEvent { label, ..Self::item_event(&held) }).await?;
        }
        if let Some(milestone) = milestone {
            self.publish_item(
                "work_item.milestoned",
                &held,
                Some(&a.actor),
                WorkItemEvent { milestone: Some(milestone), ..Self::item_event(&held) },
            )
            .await?;
        }
        if let Some(parent_id) = &parent_id {
            self.sub_item_opened(parent_id, &held, &a.actor).await?;
        }
        Ok(Outcome::Ok(held.shown(Some(&a.actor))))
    }


    pub(crate) async fn update_work_item(&self, a: UpdateWorkItemArgs) -> Result<Outcome<WorkItem>> {
        let held = check!(self.manageable_item(&a.actor, &a.workspace, a.number).await?);
        let title = match a.title.as_deref().map(valid_title) {
            Some(Err(message)) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            Some(Ok(title)) => Some(title.to_owned()),
            None => None,
        };
        if a.labels.as_deref().is_some_and(|labels| normalize_labels(labels).is_none()) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("A work item can have up to {MAX_LABELS} labels of up to {MAX_LABEL_CHARS} characters each."),
            ));
        }
        let assignees = match a.assignees {
            Some(names) => Some(check!(self.valid_assignees(names).await?)),
            None => None,
        };
        // What it is blocked by: checked before anything changes.
        let blocked_by = match &a.blocked_by {
            Some(asked) => Some(check!(self.checked_blocked_by(&held, &a.actor, asked).await?)),
            None => None,
        };
        // Its labels and milestone first: either can be refused, and then
        // nothing else changes.
        if let Some(number) = a.milestone {
            check!(self.set_milestone(&a.actor, &super::labels::Labeled::Item(held.clone()), number).await?);
        }
        if let Some(project) = &a.project {
            check!(self.set_project(&a.actor, &held, project).await?);
        }
        if let Some(labels) = &a.labels {
            check!(self.relabel(&a.actor, &super::labels::Labeled::Item(held.clone()), labels).await?);
        }
        if let Some(parent) = a.parent {
            check!(self.reparent(&held, &a.actor, Some(parent).filter(|number| *number > 0), None).await?);
        }
        let assigned = assignees.as_ref().map(serde_json::to_string).transpose()?;
        let blocked_ids = match &blocked_by {
            Some(numbers) => Some(serde_json::to_string(&self.item_ids(&held.item.workspace, numbers).await?)?),
            None => None,
        };
        let body = a.body.map(|body| body.trim().to_owned());
        let updated_at = rfc3339(now_ms());
        let dependency = match &blocked_by {
            Some(after) => self.dependency_change(&held, after, &a.actor).await?,
            None => None,
        };
        let mut statements = vec![self
            .db
            .prepare(
                "UPDATE work_items
                 SET title = COALESCE(?, title), body = COALESCE(?, body),
                     assignees = COALESCE(?, assignees), blocked_by = COALESCE(?, blocked_by),
                     updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                optional(&title),
                optional(&body),
                optional(&assigned),
                optional(&blocked_ids),
                updated_at.as_str().into(),
                held.item.id.as_str().into(),
            ])?];
        // A change to what it is blocked by reaches the sessions it concerns
        // with the change itself.
        let dependency_sent = match (&dependency, &blocked_ids) {
            (Some(data), Some(blocked)) => crate::coordination::updates::push_delivery(
                &mut statements,
                self.delivery_to(
                    "dependency.changed",
                    &held.repo_ids(),
                    data.clone(),
                    &format!("{}:blocked_by:{updated_at}", held.item.id),
                    "EXISTS (SELECT 1 FROM work_items WHERE id = ?7 AND blocked_by = ?8 AND updated_at = ?9)",
                    vec![held.item.id.as_str().into(), blocked.as_str().into(), updated_at.as_str().into()],
                )?,
            ),
            _ => None,
        };
        self.db.batch(statements).await?;
        let before = held.item.assignees.clone();
        let blocked_before = held.item.blocked_by.clone();
        let Some(held) = self.item_by_id(&held.item.id).await? else {
            return Ok(no_item());
        };
        self.publish_item("work_item.updated", &held, Some(&a.actor), Self::item_event(&held)).await?;
        if let Some(data) = dependency {
            self.delivered(dependency_sent, "dependency.changed", held.event_repo().unwrap_or_default(), Some(a.actor.id.clone()), data)
                .await?;
            self.blocked_by_changed(&held, &blocked_before, &a.actor).await?;
        }
        if let Some(assignees) = assignees {
            self.note_changes(crate::On::Item(&held.item.id), &a.actor, &before, &assignees, ("assigned", "unassigned")).await?;
            let added: Vec<String> = assignees.iter().filter(|name| !before.contains(name)).cloned().collect();
            self.publish_item(
                "work_item.assigned",
                &held,
                Some(&a.actor),
                WorkItemEvent { assignees: Some(assignees), added: Some(added), ..Self::item_event(&held) },
            )
            .await?;
        }
        Ok(Outcome::Ok(held.shown(Some(&a.actor))))
    }


    pub(crate) async fn close_work_item(&self, args: CloseWorkItemArgs) -> Result<Outcome<WorkItem>> {
        let CloseWorkItemArgs { item: a, repo, commit, sub_items, move_to } = args;
        let held = check!(self.manageable_item(&a.actor, &a.workspace, a.number).await?);
        if held.item.state == State::Closed {
            return Ok(Outcome::fail(FailureCode::Conflict, "This work item is already closed."));
        }
        // Its open sub-items are never closed, or left, without being told;
        // a commit closing it leaves them.
        let closing = match commit {
            Some(_) => Vec::new(),
            None => check!(self.before_closing(&held, &a.actor, sub_items, move_to).await?),
        };
        // Closed by a commit on a repository's default branch: as its push
        // would have.
        if let Some(commit) = commit.as_deref() {
            if a.reason == Some(CloseReason::NotPlanned) {
                return Ok(Outcome::fail(FailureCode::Invalid, "A commit closes a work item as completed, not as not planned."));
            }
            let Some(path) = repo.as_ref() else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Say which repository the commit is in (repo)."));
            };
            let found = check!(self.repo(path, &Some(a.actor.clone())).await?);
            let (commit, named, tie) = check!(self.closing_commit(&found, &held, commit, &a.actor).await?);
            let session = match named {
                Some(session) => Some(session),
                None => self.caller_session(&held, &a.actor).await?,
            };
            let landing = Landing { pull: None, commit: Some(commit), pushed_by: Some(a.actor.username.clone()), tie: Some(tie) };
            self.land(&found, &landing, &a.actor, std::slice::from_ref(&held.item.id), &[], session.as_deref(), false).await?;
            return Ok(match self.item_by_id(&held.item.id).await? {
                Some(after) if after.item.state == State::Open && !after.item.missing().is_empty() => {
                    let missing: Vec<String> = after
                        .item
                        .repos
                        .iter()
                        .filter(|repo| repo.role == LinkRole::Target && !repo.landed)
                        .map(|repo| if after.may_read_repo(Some(&a.actor), &repo.repo_id) { repo.path.clone() } else { String::new() })
                        .collect();
                    Outcome::fail(FailureCode::Conflict, still_open(after.item.number, &path_of(&found), &missing))
                }
                Some(after) => Outcome::Ok(after.shown(Some(&a.actor))),
                None => no_item(),
            });
        }
        let session = self.caller_session(&held, &a.actor).await?;
        let reason = a.reason.unwrap_or(CloseReason::Completed);
        let now = rfc3339(now_ms());
        self.db
            .prepare("UPDATE work_items SET state = 'closed', reason = ?, closed_at = ?, updated_at = ? WHERE id = ?")
            .bind(&[reason.as_str().into(), now.as_str().into(), now.as_str().into(), held.item.id.as_str().into()])?
            .run()
            .await?;
        self.publish_item(
            "work_item.closed",
            &held,
            Some(&a.actor),
            WorkItemEvent { reason: Some(reason.as_str()), session: session.clone(), ..Self::item_event(&held) },
        )
        .await?;
        let note = match reason {
            CloseReason::Completed => "closed this as completed",
            CloseReason::NotPlanned => "closed this as not planned",
        };
        self.note_item(&held.item.id, &a.actor, &crate::pushed::closed_note(note, session.as_deref())).await?;
        // Its claims end, and the work items it blocks hear (coordination/).
        self.item_resolved(&held, &a.actor, true, None).await;
        // Then its sub-items asked to close too, deepest first.
        for sub_item in closing {
            let args = CloseWorkItemArgs {
                item: WorkItemActionArgs {
                    actor: a.actor.clone(),
                    workspace: sub_item.item.workspace.clone(),
                    number: sub_item.item.number,
                    reason: Some(reason),
                },
                repo: None,
                commit: None,
                sub_items: Some(OpenSubItems::Leave),
                move_to: None,
            };
            if let Outcome::Fail(failure) = Box::pin(self.close_work_item(args)).await? {
                let (number, sub_item) = (held.item.number, sub_item.item.number);
                worker::console_error!("#{number} closed, but its sub-item #{sub_item} did not: {}", failure.message);
            }
        }
        let mut item = held.shown(Some(&a.actor));
        item.state = State::Closed;
        item.reason = Some(reason);
        item.closed_at = Some(now.clone());
        item.updated_at = now;
        Ok(Outcome::Ok(item))
    }

    pub(crate) async fn reopen_work_item(&self, a: WorkItemActionArgs) -> Result<Outcome<WorkItem>> {
        let held = check!(self.manageable_item(&a.actor, &a.workspace, a.number).await?);
        if held.item.state == State::Open {
            return Ok(Outcome::fail(FailureCode::Conflict, "This work item is already open."));
        }
        let now = rfc3339(now_ms());
        // Reopened, nothing has landed for it any more.
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "UPDATE work_items
                         SET state = 'open', reason = NULL, resolutions = '[]', closed_at = NULL, urgent = 0, updated_at = ?
                         WHERE id = ?",
                    )
                    .bind(&[now.as_str().into(), held.item.id.as_str().into()])?,
                self.db.prepare("UPDATE work_item_repos SET landed_at = NULL WHERE item_id = ?").bind(&[held.item.id.as_str().into()])?,
            ])
            .await?;
        self.publish_item("work_item.reopened", &held, Some(&a.actor), Self::item_event(&held)).await?;
        self.note_item(&held.item.id, &a.actor, "reopened this").await?;
        self.sub_item_resolved(&held, &a.actor, false).await;
        Ok(match self.item_by_id(&held.item.id).await? {
            Some(held) => Outcome::Ok(held.shown(Some(&a.actor))),
            None => no_item(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::still_open;

    #[test]
    fn a_commit_that_does_not_close_says_where_it_has_still_to_land() {
        assert_eq!(
            still_open(12, "acme/web", &["acme/api".to_owned()]),
            "Recorded the commit as landed in acme/web, but #12 stays open until it lands in acme/api too."
        );
        assert_eq!(
            still_open(12, "acme/web", &["acme/api".to_owned(), String::new()]),
            "Recorded the commit as landed in acme/web, but #12 stays open until it lands in acme/api and 1 other repository too."
        );
    }
}
