//! A workspace's labels, and putting them on work items and pull requests.
//!
//! Labels live in the `labels` table, one row per name in a workspace; a
//! work item or a pull request carries them by name in its `labels` JSON
//! array. Renaming or deleting a label rewrites those arrays, so a name on
//! one is always one its workspace has.

use g1t_contracts::access::{self, Capability, RepoRef};
use g1t_contracts::events::{EventLabel, PullEvent, WorkItemEvent};
use g1t_contracts::repos::Repo;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use super::rows::{Held, workspace_of};
use crate::retired::writable;
use crate::{On, Work};

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

/// A label as stored, with how many work items and pull requests carry it.
#[derive(Deserialize)]
struct LabelRow {
    name: String,
    color: String,
    description: String,
    #[serde(default)]
    items: u32,
    #[serde(default)]
    pulls: u32,
}

impl From<LabelRow> for Label {
    fn from(row: LabelRow) -> Self {
        Label { name: row.name, color: row.color, description: row.description, items: row.items, pulls: row.pulls }
    }
}

/// A workspace's labels with their counts, by name. `?1` is its slug.
const LABELS: &str = "SELECT name, color, description,
   (SELECT count(*) FROM work_items, json_each(work_items.labels)
    WHERE work_items.workspace = labels.workspace AND json_each.value = labels.name) AS items,
   (SELECT count(*) FROM pulls, json_each(pulls.labels)
    WHERE pulls.repo_id IN (SELECT repo_id FROM repo_workspaces WHERE workspace = labels.workspace)
      AND json_each.value = labels.name) AS pulls
 FROM labels WHERE workspace = ?1";

/// The most labels a workspace can have.
const MAX_WORKSPACE_LABELS: u32 = 500;

/// A work item or a pull request, as labels and milestones change on it.
#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)]
pub(crate) enum Labeled {
    Item(Held),
    Pull(Repo, Pull),
}

impl Labeled {
    /// The workspace whose labels and milestones it takes.
    pub(crate) fn workspace(&self) -> String {
        match self {
            Labeled::Item(held) => held.item.workspace.clone(),
            Labeled::Pull(repo, _) => repo.namespace.to_lowercase(),
        }
    }

    /// The repository whose role counts besides a membership of the
    /// workspace: a work item's origin, or the pull request's own.
    pub(crate) fn repo(&self) -> Option<RepoRef<'_>> {
        match self {
            Labeled::Item(held) => held.origin(),
            Labeled::Pull(repo, _) => Some(RepoRef::from(repo)),
        }
    }

    pub(crate) fn on(&self) -> On<'_> {
        match self {
            Labeled::Item(held) => On::Item(&held.item.id),
            Labeled::Pull(_, pull) => On::Pull(&pull.repo_id, pull.number),
        }
    }

    pub(crate) fn labels(&self) -> &[String] {
        match self {
            Labeled::Item(held) => &held.item.labels,
            Labeled::Pull(_, pull) => &pull.labels,
        }
    }

    pub(crate) fn milestone(&self) -> Option<&MilestoneRef> {
        match self {
            Labeled::Item(held) => held.item.milestone.as_ref(),
            Labeled::Pull(_, pull) => pull.milestone.as_ref(),
        }
    }

    /// Who may manage it without the Triage role.
    pub(crate) fn owned_by(&self, id: &str) -> bool {
        match self {
            Labeled::Item(held) => held.item.owner().id == id,
            Labeled::Pull(_, pull) => pull.is_owned_by(id),
        }
    }

    /// Whether `actor` may do `capability` on it.
    pub(crate) fn may(&self, actor: &User, capability: Capability) -> bool {
        access::can_item(Some(actor), &self.workspace(), self.repo(), capability)
    }

    /// Its row: the table and its id.
    pub(crate) fn row(&self) -> (&'static str, &str) {
        match self {
            Labeled::Item(held) => ("work_items", &held.item.id),
            Labeled::Pull(_, pull) => ("pulls", &pull.id),
        }
    }

    /// The event `what` happened to it: `work_item.labeled` or `pull.labeled`.
    pub(crate) fn kind(&self, what: &str) -> &'static str {
        match (self, what) {
            (Labeled::Item(_), "labeled") => "work_item.labeled",
            (Labeled::Item(_), "unlabeled") => "work_item.unlabeled",
            (Labeled::Item(_), "milestoned") => "work_item.milestoned",
            (Labeled::Item(_), _) => "work_item.demilestoned",
            (Labeled::Pull(..), "labeled") => "pull.labeled",
            (Labeled::Pull(..), "unlabeled") => "pull.unlabeled",
            (Labeled::Pull(..), "milestoned") => "pull.milestoned",
            (Labeled::Pull(..), _) => "pull.demilestoned",
        }
    }
}

/// What was added and what taken away, going from `before` to `after`.
pub(crate) fn label_changes(before: &[String], after: &[String]) -> (Vec<String>, Vec<String>) {
    let added = after.iter().filter(|name| !before.contains(name)).cloned().collect();
    let removed = before.iter().filter(|name| !after.contains(name)).cloned().collect();
    (added, removed)
}

/// What an item's labels become under `change`.
pub(crate) fn changed_labels(current: &[String], given: &[String], change: LabelChange) -> Vec<String> {
    match change {
        LabelChange::Set => given.to_vec(),
        LabelChange::Add => current.iter().chain(given).cloned().collect(),
        LabelChange::Remove => current.iter().filter(|name| !given.contains(name)).cloned().collect(),
    }
}

/// A sentence for the conversation, about the labels added or removed:
/// "added the bug and docs labels".
pub(crate) fn label_note(verb: &str, names: &[String]) -> String {
    let quoted: Vec<String> = names.iter().map(|name| format!("`{name}`")).collect();
    let list = match quoted.as_slice() {
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
        [] => String::new(),
    };
    let noun = if names.len() == 1 { "label" } else { "labels" };
    format!("{verb} the {list} {noun}")
}

/// One label name, tidied as [`normalize_labels`] tidies them, or why not.
fn one_name(name: &str) -> Result<String, &'static str> {
    match normalize_labels(&[name.to_owned()]).and_then(|mut names| names.pop()) {
        Some(name) => Ok(name),
        None if name.trim().is_empty() => Err("A label needs a name."),
        None => Err("A label's name can be at most 50 characters."),
    }
}

fn tidy_description(description: &str) -> Result<String, &'static str> {
    let description = description.trim();
    if description.chars().count() > MAX_LABEL_DESCRIPTION_CHARS {
        return Err("A label's description can be at most 100 characters.");
    }
    Ok(description.to_owned())
}

/// Whether `actor` may make labels in `workspace`, which are the whole
/// workspace's: through their membership of it alone, never their role on
/// one repository (an outside collaborator's Write on a public repository
/// makes no workspace labels).
pub(crate) fn may_create_labels(actor: &User, workspace: &str) -> bool {
    access::can_item(Some(actor), workspace, None, Capability::ManageLabels)
}

/// Refused while issues are still being moved into work items: what is
/// numbered or kept by workspace is not all there yet.
pub(crate) fn still_moving<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::Conflict, "Work items are still being moved into this workspace; try again in a few minutes.")
}

impl Work {
    /// The workspace, if `actor` may create, edit and delete its labels
    /// and milestones: Write in it, as on GitHub. Applying them is Triage.
    pub(crate) async fn labelled_workspace(&self, actor: &User, workspace: &str) -> Result<Outcome<String>> {
        let workspace = workspace_of(workspace, None);
        if !access::can_item(Some(actor), &workspace, None, Capability::ManageLabels) {
            return Ok(Outcome::fail(FailureCode::Forbidden, access::needs_on_item(Capability::ManageLabels, &workspace)));
        }
        if !self.items_moved().await? {
            return Ok(still_moving());
        }
        Ok(Outcome::Ok(workspace))
    }

    /// Whether `viewer` may see what a workspace keeps: a member, someone
    /// given a role on one of its repositories, or anyone where one of its
    /// repositories is public.
    pub(crate) async fn workspace_visible(&self, viewer: &Viewer, workspace: &str) -> Result<bool> {
        if viewer.as_ref().is_some_and(|user| access::has_access_in(user, workspace)) {
            return Ok(true);
        }
        Ok(self
            .db
            .prepare("SELECT repo_id AS value FROM repo_workspaces WHERE workspace = ? AND private = 0 LIMIT 1")
            .bind(&[workspace.into()])?
            .first::<crate::rows::ValueRow>(None)
            .await?
            .is_some())
    }

    async fn labels_in(&self, workspace: &str, only: Option<&str>) -> Result<Vec<Label>> {
        let rows = match only {
            Some(name) => self.db.prepare(format!("{LABELS} AND name = ?2")).bind(&[workspace.into(), name.into()])?.all().await?,
            None => {
                self.db.prepare(format!("{LABELS} ORDER BY name LIMIT {MAX_WORKSPACE_LABELS}")).bind(&[workspace.into()])?.all().await?
            }
        };
        Ok(rows.results::<LabelRow>()?.into_iter().map(Label::from).collect())
    }

    /// A workspace's labels, by name, with how many work items and pull
    /// requests carry each.
    pub(crate) async fn list_labels(&self, a: WorkspaceViewArgs) -> Result<Outcome<Vec<Label>>> {
        let workspace = workspace_of(&a.workspace, None);
        if !self.workspace_visible(&a.viewer, &workspace).await? {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        }
        Ok(Outcome::Ok(self.labels_in(&workspace, None).await?))
    }

    /// Gives a workspace the default labels it does not have yet.
    pub(crate) async fn seed_labels(&self, workspace: &str) -> Result<()> {
        let now = rfc3339(now_ms());
        let statements = DEFAULT_LABELS
            .iter()
            .map(|(name, color, description)| {
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO labels (workspace, name, color, description, created_at)
                         VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(&[workspace.into(), (*name).into(), (*color).into(), (*description).into(), now.as_str().into()])
            })
            .collect::<Result<Vec<_>>>()?;
        self.db.batch(statements).await?;
        Ok(())
    }

    pub(crate) async fn add_default_labels(&self, a: WorkspaceActorArgs) -> Result<Outcome<Vec<Label>>> {
        let workspace = check!(self.labelled_workspace(&a.actor, &a.workspace).await?);
        self.seed_labels(&workspace).await?;
        Ok(Outcome::Ok(self.labels_in(&workspace, None).await?))
    }

    /// Creates a label, or changes one: its name (on every work item and
    /// pull request that carries it), color or description.
    pub(crate) async fn save_label(&self, a: SaveLabelArgs) -> Result<Outcome<Label>> {
        let workspace = check!(self.labelled_workspace(&a.actor, &a.workspace).await?);
        let invalid = |message: &str| Ok(Outcome::fail(FailureCode::Invalid, message));
        let new_name = match a.new_name.as_deref().map(one_name) {
            Some(Err(message)) => return invalid(message),
            Some(Ok(name)) => Some(name),
            None => None,
        };
        let color = match a.color.as_deref().map(tidy_color) {
            Some(None) => return invalid("A color is six hex digits, such as d73a4a."),
            Some(Some(color)) => Some(color),
            None => None,
        };
        let description = match a.description.as_deref().map(tidy_description) {
            Some(Err(message)) => return invalid(message),
            Some(Ok(description)) => Some(description),
            None => None,
        };
        let taken = async |name: &str| -> Result<bool> { Ok(!self.labels_in(&workspace, Some(name)).await?.is_empty()) };

        let Some(name) = a.name.as_deref().map(|name| name.trim().to_lowercase()).filter(|name| !name.is_empty()) else {
            // A new label.
            let Some(name) = new_name else {
                return invalid("A label needs a name.");
            };
            if taken(&name).await? {
                return Ok(Outcome::fail(FailureCode::Conflict, format!("A label named {name} already exists.")));
            }
            let count = self
                .db
                .prepare("SELECT count(*) AS n FROM labels WHERE workspace = ?")
                .bind(&[workspace.as_str().into()])?
                .first::<crate::rows::NumberRow>(None)
                .await?
                .map_or(0, |row| row.n);
            if count >= MAX_WORKSPACE_LABELS {
                return invalid("A workspace can have at most 500 labels.");
            }
            self.db
                .prepare("INSERT INTO labels (workspace, name, color, description, created_at) VALUES (?, ?, ?, ?, ?)")
                .bind(&[
                    workspace.as_str().into(),
                    name.as_str().into(),
                    color.unwrap_or_else(|| label_color_for(&name)).into(),
                    description.unwrap_or_default().into(),
                    rfc3339(now_ms()).into(),
                ])?
                .run()
                .await?;
            return self.label_now(&workspace, &name).await;
        };
        if !taken(&name).await? {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no label named {name}.")));
        }
        let renamed = new_name.filter(|new_name| *new_name != name);
        if let Some(new_name) = &renamed
            && taken(new_name).await?
        {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("A label named {new_name} already exists.")));
        }
        let to = renamed.clone().unwrap_or_else(|| name.clone());
        let mut statements = vec![
            self.db
                .prepare(
                    "UPDATE labels SET name = ?3, color = COALESCE(?4, color), description = COALESCE(?5, description)
                 WHERE workspace = ?1 AND name = ?2",
                )
                .bind(&[
                    workspace.as_str().into(),
                    name.as_str().into(),
                    to.as_str().into(),
                    crate::optional(&color),
                    crate::optional(&description),
                ])?,
        ];
        if renamed.is_some() {
            for (table, scope) in WHERE_IN_WORKSPACE {
                statements.push(
                    self.db
                        .prepare(format!(
                            "UPDATE {table}
                             SET labels = (SELECT json_group_array(CASE WHEN value = ?2 THEN ?3 ELSE value END)
                                           FROM json_each({table}.labels))
                             WHERE {scope}
                               AND EXISTS (SELECT 1 FROM json_each({table}.labels) WHERE value = ?2)"
                        ))
                        .bind(&[workspace.as_str().into(), name.as_str().into(), to.as_str().into()])?,
                );
            }
        }
        self.db.batch(statements).await?;
        self.label_now(&workspace, &to).await
    }

    async fn label_now(&self, workspace: &str, name: &str) -> Result<Outcome<Label>> {
        Ok(match self.labels_in(workspace, Some(name)).await?.pop() {
            Some(label) => Outcome::Ok(label),
            None => Outcome::fail(FailureCode::NotFound, format!("There is no label named {name}.")),
        })
    }

    /// Removes a label from the workspace and from everything carrying it.
    pub(crate) async fn delete_label(&self, a: DeleteLabelArgs) -> Result<Outcome<bool>> {
        let workspace = check!(self.labelled_workspace(&a.actor, &a.workspace).await?);
        let name = a.name.trim().to_lowercase();
        if self.labels_in(&workspace, Some(&name)).await?.is_empty() {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no label named {name}.")));
        }
        let mut statements = vec![
            self.db
                .prepare("DELETE FROM labels WHERE workspace = ?1 AND name = ?2")
                .bind(&[workspace.as_str().into(), name.as_str().into()])?,
        ];
        for (table, scope) in WHERE_IN_WORKSPACE {
            statements.push(
                self.db
                    .prepare(format!(
                        "UPDATE {table}
                         SET labels = (SELECT json_group_array(value) FROM json_each({table}.labels) WHERE value != ?2)
                         WHERE {scope} AND EXISTS (SELECT 1 FROM json_each({table}.labels) WHERE value = ?2)"
                    ))
                    .bind(&[workspace.as_str().into(), name.as_str().into()])?,
            );
        }
        self.db.batch(statements).await?;
        Ok(Outcome::Ok(true))
    }

    /// Makes sure every label in `names` exists in the workspace: those
    /// missing are created when `actor` may manage the workspace's labels
    /// ([`may_create_labels`]), and refused otherwise. Returns their
    /// colors, by name.
    pub(crate) async fn ensure_labels(&self, actor: &User, workspace: &str, names: &[String]) -> Result<Outcome<Vec<(String, String)>>> {
        if names.is_empty() {
            return Ok(Outcome::Ok(Vec::new()));
        }
        let existing: Vec<Label> = self.labels_in(workspace, None).await?;
        let missing: Vec<&String> = names.iter().filter(|name| !existing.iter().any(|label| label.name == **name)).collect();
        if !missing.is_empty() {
            if !may_create_labels(actor, workspace) {
                let list = missing.iter().map(|name| name.as_str()).collect::<Vec<_>>().join(", ");
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("{workspace} has no label named {list}. Someone with the Write role can create it on the labels page."),
                ));
            }
            if !self.items_moved().await? {
                return Ok(still_moving());
            }
            let now = rfc3339(now_ms());
            let statements = missing
                .iter()
                .map(|name| {
                    self.db
                        .prepare(
                            "INSERT OR IGNORE INTO labels (workspace, name, color, description, created_at)
                             VALUES (?, ?, ?, '', ?)",
                        )
                        .bind(&[workspace.into(), name.as_str().into(), label_color_for(name).into(), now.as_str().into()])
                })
                .collect::<Result<Vec<_>>>()?;
            self.db.batch(statements).await?;
        }
        Ok(Outcome::Ok(
            names
                .iter()
                .map(|name| {
                    let color = existing
                        .iter()
                        .find(|label| label.name == *name)
                        .map_or_else(|| label_color_for(name), |label| label.color.clone());
                    (name.clone(), color)
                })
                .collect(),
        ))
    }

    /// Gives a work item or a pull request the labels `wanted`, creating
    /// the missing ones as [`ensure_labels`](Work::ensure_labels) does, and
    /// says what changed: in its conversation, and as one `labeled` or
    /// `unlabeled` event for each label. Returns its labels now.
    pub(crate) async fn relabel(&self, actor: &User, labeled: &Labeled, wanted: &[String]) -> Result<Outcome<Vec<String>>> {
        let Some(after) = normalize_labels(wanted) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("A work item or pull request can have up to {MAX_LABELS} labels of up to {MAX_LABEL_CHARS} characters each."),
            ));
        };
        let colors = check!(self.ensure_labels(actor, &labeled.workspace(), &after).await?);
        let before = labeled.labels().to_vec();
        let (added, removed) = label_changes(&before, &after);
        if added.is_empty() && removed.is_empty() {
            return Ok(Outcome::Ok(after));
        }
        let (table, id) = labeled.row();
        self.db
            .prepare(format!("UPDATE {table} SET labels = ?, updated_at = ? WHERE id = ?"))
            .bind(&[serde_json::to_string(&after)?.into(), rfc3339(now_ms()).into(), id.into()])?
            .run()
            .await?;
        self.announce_labels(actor, labeled, &added, &removed, &colors).await?;
        Ok(Outcome::Ok(after))
    }

    /// Notes and events for labels put on and taken off a work item or
    /// pull request.
    pub(crate) async fn announce_labels(
        &self,
        actor: &User,
        labeled: &Labeled,
        added: &[String],
        removed: &[String],
        colors: &[(String, String)],
    ) -> Result<()> {
        if !added.is_empty() {
            self.note_on(labeled.on(), actor.into(), &label_note("added", added)).await?;
        }
        if !removed.is_empty() {
            self.note_on(labeled.on(), actor.into(), &label_note("removed", removed)).await?;
        }
        let color_of = |name: &String| {
            colors.iter().find(|(known, _)| known == name).map_or_else(|| label_color_for(name), |(_, color)| color.clone())
        };
        for (what, names) in [("labeled", added), ("unlabeled", removed)] {
            for name in names {
                let label = Some(EventLabel { name: name.clone(), color: color_of(name) });
                match labeled {
                    Labeled::Item(held) => {
                        self.publish_item(labeled.kind(what), held, Some(actor), WorkItemEvent { label, ..Self::item_event(held) }).await?;
                    }
                    Labeled::Pull(_, pull) => {
                        self.publish(labeled.kind(what), &pull.repo_id, actor, PullEvent { label, ..Self::pull_event(pull) }).await?;
                    }
                }
            }
        }
        Ok(())
    }

    /// `set_labels`: the labels of a work item or a pull request, replaced,
    /// added to or taken from. Its owner may use the workspace's labels on
    /// it; anyone else needs the Triage role.
    pub(crate) async fn set_labels(&self, a: SetLabelsArgs) -> Result<Outcome<Vec<String>>> {
        let labeled = check!(self.labeled(&a.actor, a.repo.as_ref(), &a.workspace, a.number).await?);
        let given = match a.change {
            // Taking off works on names as given, tidied the same way.
            LabelChange::Remove => normalize_labels(&a.labels).unwrap_or_default(),
            _ => a.labels.clone(),
        };
        let wanted = changed_labels(labeled.labels(), &given, a.change);
        let labels = check!(self.relabel(&a.actor, &labeled, &wanted).await?);
        Ok(Outcome::Ok(labels))
    }

    /// The thread `actor` changes the labels or milestone of: theirs, or
    /// one they may triage.
    pub(crate) async fn labeled(
        &self,
        actor: &User,
        repo: Option<&g1t_contracts::repos::RepoPath>,
        workspace: &str,
        number: u32,
    ) -> Result<Outcome<Labeled>> {
        let labeled = match check!(self.thread(&Some(actor.clone()), repo, workspace, number).await?) {
            crate::Thread::Pull(repo, pull) => {
                check!(writable(&repo));
                Labeled::Pull(repo, pull)
            }
            crate::Thread::Item(held) => Labeled::Item(held),
        };
        if !labeled.owned_by(&actor.id) && !labeled.may(actor, Capability::Triage) {
            return Ok(Outcome::fail(FailureCode::Forbidden, access::needs_on_item(Capability::Triage, &labeled.workspace())));
        }
        Ok(Outcome::Ok(labeled))
    }
}

/// The rows of a workspace (`?1`) that carry labels: its work items, and
/// its repositories' pull requests.
const WHERE_IN_WORKSPACE: [(&str, &str); 2] =
    [("work_items", "workspace = ?1"), ("pulls", "repo_id IN (SELECT repo_id FROM repo_workspaces WHERE workspace = ?1)")];

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn only_the_workspaces_members_make_its_labels() {
        use crate::items::rows_for_test::person_for_test;
        // An outside collaborator with Write on one of acme's repositories.
        let mut outsider = person_for_test("usr_9", None);
        outsider.grants.push(g1t_contracts::access::RepoGrant {
            repo_id: "rep_web".into(),
            workspace: "acme".into(),
            role: g1t_contracts::access::RepoRole::Write,
            team: None,
        });
        assert!(!may_create_labels(&outsider, "acme"));
        assert!(may_create_labels(&person_for_test("usr_2", Some("acme")), "acme"));
    }

    #[test]
    fn labels_are_set_added_to_and_taken_off() {
        let current = names(&["bug", "docs"]);
        assert_eq!(changed_labels(&current, &names(&["question"]), LabelChange::Set), names(&["question"]));
        assert_eq!(changed_labels(&current, &names(&["question"]), LabelChange::Add), names(&["bug", "docs", "question"]));
        assert_eq!(changed_labels(&current, &names(&["bug"]), LabelChange::Remove), names(&["docs"]));
    }

    #[test]
    fn what_changed_is_said_in_a_sentence() {
        let (added, removed) = label_changes(&names(&["bug", "docs"]), &names(&["docs", "security", "wontfix"]));
        assert_eq!(added, names(&["security", "wontfix"]));
        assert_eq!(removed, names(&["bug"]));
        assert_eq!(label_note("added", &added), "added the `security` and `wontfix` labels");
        assert_eq!(label_note("removed", &removed), "removed the `bug` label");
        assert_eq!(label_note("added", &names(&["a", "b", "c"])), "added the `a`, `b` and `c` labels");
    }

    #[test]
    fn a_name_is_tidied_or_refused() {
        assert_eq!(one_name("  Good   First Issue ").unwrap(), "good first issue");
        assert!(one_name(" ").is_err());
        assert!(one_name(&"x".repeat(51)).is_err());
        assert!(tidy_description(&"x".repeat(101)).is_err());
    }
}
