//! A repository's labels, and putting them on issues and pull requests.
//!
//! Labels live in the `labels` table, one row per name; an issue or a pull
//! request carries them by name in its `labels` JSON array. Renaming or
//! deleting a label rewrites those arrays, so a name on an item is always
//! one the repository has.

use g1t_contracts::access::Capability;
use g1t_contracts::events::{EventLabel, IssueEvent, PullEvent};
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::retired::writable;
use crate::{Work, allowed};

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

/// A label as stored, with how many issues and pull requests carry it.
#[derive(Deserialize)]
struct LabelRow {
    name: String,
    color: String,
    description: String,
    #[serde(default)]
    issues: u32,
    #[serde(default)]
    pulls: u32,
}

impl From<LabelRow> for Label {
    fn from(row: LabelRow) -> Self {
        Label { name: row.name, color: row.color, description: row.description, issues: row.issues, pulls: row.pulls }
    }
}

/// A repository's labels with their counts, by name. `?1` is its id.
const LABELS: &str = "SELECT name, color, description,
   (SELECT count(*) FROM issues, json_each(issues.labels)
    WHERE issues.repo_id = labels.repo_id AND json_each.value = labels.name) AS issues,
   (SELECT count(*) FROM pulls, json_each(pulls.labels)
    WHERE pulls.repo_id = labels.repo_id AND json_each.value = labels.name) AS pulls
 FROM labels WHERE repo_id = ?1";

/// The most labels a repository can have.
const MAX_REPO_LABELS: u32 = 500;

/// An issue or a pull request, as labels and milestones change on it.
pub(crate) enum Item {
    Issue(Issue),
    Pull(Pull),
}

impl Item {
    pub(crate) fn number(&self) -> u32 {
        match self {
            Item::Issue(issue) => issue.number,
            Item::Pull(pull) => pull.number,
        }
    }

    pub(crate) fn repo_id(&self) -> &str {
        match self {
            Item::Issue(issue) => &issue.repo_id,
            Item::Pull(pull) => &pull.repo_id,
        }
    }

    pub(crate) fn labels(&self) -> &[String] {
        match self {
            Item::Issue(issue) => &issue.labels,
            Item::Pull(pull) => &pull.labels,
        }
    }

    pub(crate) fn milestone(&self) -> Option<&MilestoneRef> {
        match self {
            Item::Issue(issue) => issue.milestone.as_ref(),
            Item::Pull(pull) => pull.milestone.as_ref(),
        }
    }

    /// Who may manage it without the Triage role.
    pub(crate) fn owned_by(&self, id: &str) -> bool {
        match self {
            Item::Issue(issue) => issue.owner().id == id,
            Item::Pull(pull) => pull.is_owned_by(id),
        }
    }

    pub(crate) fn table(&self) -> &'static str {
        match self {
            Item::Issue(_) => "issues",
            Item::Pull(_) => "pulls",
        }
    }

    /// The event `what` happened to it: `issue.labeled` or `pull.labeled`.
    pub(crate) fn kind(&self, what: &str) -> &'static str {
        match (self, what) {
            (Item::Issue(_), "labeled") => "issue.labeled",
            (Item::Issue(_), "unlabeled") => "issue.unlabeled",
            (Item::Issue(_), "milestoned") => "issue.milestoned",
            (Item::Issue(_), _) => "issue.demilestoned",
            (Item::Pull(_), "labeled") => "pull.labeled",
            (Item::Pull(_), "unlabeled") => "pull.unlabeled",
            (Item::Pull(_), "milestoned") => "pull.milestoned",
            (Item::Pull(_), _) => "pull.demilestoned",
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

impl Work {
    /// The repository, if `actor` may manage its labels and milestones.
    pub(crate) async fn triaged_repo(&self, actor: &User, path: &RepoPath) -> Result<Outcome<Repo>> {
        let repo = check!(self.repo(path, &Some(actor.clone())).await?);
        check!(writable(&repo));
        check!(allowed(Some(actor), &repo, Capability::Triage));
        Ok(Outcome::Ok(repo))
    }

    async fn labels_in(&self, repo_id: &str, only: Option<&str>) -> Result<Vec<Label>> {
        let rows = match only {
            Some(name) => {
                self.db
                    .prepare(format!("{LABELS} AND name = ?2"))
                    .bind(&[repo_id.into(), name.into()])?
                    .all()
                    .await?
            }
            None => {
                self.db
                    .prepare(format!("{LABELS} ORDER BY name LIMIT {MAX_REPO_LABELS}"))
                    .bind(&[repo_id.into()])?
                    .all()
                    .await?
            }
        };
        Ok(rows.results::<LabelRow>()?.into_iter().map(Label::from).collect())
    }

    /// A repository's labels, by name, with how many issues and pull
    /// requests carry each.
    pub(crate) async fn list_labels(&self, a: ViewArgs) -> Result<Outcome<Vec<Label>>> {
        let read = |repo_id: String| async move {
            let query = self
                .db
                .prepare(format!("{LABELS} ORDER BY name LIMIT {MAX_REPO_LABELS}"))
                .bind(&[repo_id.into()])?;
            self.timing.db(1, query.all()).await?.results::<LabelRow>()
        };
        let (_, rows) = check!(self.repo_then(&a.repo, &a.viewer, read).await?);
        Ok(Outcome::Ok(rows.into_iter().map(Label::from).collect()))
    }

    /// Gives a repository the default labels it does not have yet.
    pub(crate) async fn seed_labels(&self, repo_id: &str) -> Result<()> {
        let now = rfc3339(now_ms());
        let statements = DEFAULT_LABELS
            .iter()
            .map(|(name, color, description)| {
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO labels (repo_id, name, color, description, created_at)
                         VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(&[repo_id.into(), (*name).into(), (*color).into(), (*description).into(), now.as_str().into()])
            })
            .collect::<Result<Vec<_>>>()?;
        self.db.batch(statements).await?;
        Ok(())
    }

    pub(crate) async fn add_default_labels(&self, a: RepoActorArgs) -> Result<Outcome<Vec<Label>>> {
        let repo = check!(self.triaged_repo(&a.actor, &a.repo).await?);
        self.seed_labels(&repo.id).await?;
        Ok(Outcome::Ok(self.labels_in(&repo.id, None).await?))
    }

    /// Creates a label, or changes one: its name (on every issue and pull
    /// request that carries it), color or description.
    pub(crate) async fn save_label(&self, a: SaveLabelArgs) -> Result<Outcome<Label>> {
        let repo = check!(self.triaged_repo(&a.actor, &a.repo).await?);
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
        let taken = async |name: &str| -> Result<bool> { Ok(!self.labels_in(&repo.id, Some(name)).await?.is_empty()) };

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
                .prepare("SELECT count(*) AS n FROM labels WHERE repo_id = ?")
                .bind(&[repo.id.as_str().into()])?
                .first::<crate::rows::NumberRow>(None)
                .await?
                .map_or(0, |row| row.n);
            if count >= MAX_REPO_LABELS {
                return invalid("A repository can have at most 500 labels.");
            }
            self.db
                .prepare(
                    "INSERT INTO labels (repo_id, name, color, description, created_at) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(&[
                    repo.id.as_str().into(),
                    name.as_str().into(),
                    color.unwrap_or_else(|| label_color_for(&name)).into(),
                    description.unwrap_or_default().into(),
                    rfc3339(now_ms()).into(),
                ])?
                .run()
                .await?;
            return self.label_now(&repo.id, &name).await;
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
                     WHERE repo_id = ?1 AND name = ?2",
                )
                .bind(&[
                    repo.id.as_str().into(),
                    name.as_str().into(),
                    to.as_str().into(),
                    crate::optional(&color),
                    crate::optional(&description),
                ])?,
        ];
        if renamed.is_some() {
            for table in ["issues", "pulls"] {
                statements.push(
                    self.db
                        .prepare(format!(
                            "UPDATE {table}
                             SET labels = (SELECT json_group_array(CASE WHEN value = ?2 THEN ?3 ELSE value END)
                                           FROM json_each({table}.labels))
                             WHERE repo_id = ?1
                               AND EXISTS (SELECT 1 FROM json_each({table}.labels) WHERE value = ?2)"
                        ))
                        .bind(&[repo.id.as_str().into(), name.as_str().into(), to.as_str().into()])?,
                );
            }
        }
        self.db.batch(statements).await?;
        self.label_now(&repo.id, &to).await
    }

    async fn label_now(&self, repo_id: &str, name: &str) -> Result<Outcome<Label>> {
        Ok(match self.labels_in(repo_id, Some(name)).await?.pop() {
            Some(label) => Outcome::Ok(label),
            None => Outcome::fail(FailureCode::NotFound, format!("There is no label named {name}.")),
        })
    }

    /// Removes a label from the repository and from everything carrying it.
    pub(crate) async fn delete_label(&self, a: DeleteLabelArgs) -> Result<Outcome<bool>> {
        let repo = check!(self.triaged_repo(&a.actor, &a.repo).await?);
        let name = a.name.trim().to_lowercase();
        if self.labels_in(&repo.id, Some(&name)).await?.is_empty() {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no label named {name}.")));
        }
        let mut statements = vec![
            self.db
                .prepare("DELETE FROM labels WHERE repo_id = ?1 AND name = ?2")
                .bind(&[repo.id.as_str().into(), name.as_str().into()])?,
        ];
        for table in ["issues", "pulls"] {
            statements.push(
                self.db
                    .prepare(format!(
                        "UPDATE {table}
                         SET labels = (SELECT json_group_array(value) FROM json_each({table}.labels) WHERE value != ?2)
                         WHERE repo_id = ?1 AND EXISTS (SELECT 1 FROM json_each({table}.labels) WHERE value = ?2)"
                    ))
                    .bind(&[repo.id.as_str().into(), name.as_str().into()])?,
            );
        }
        self.db.batch(statements).await?;
        Ok(Outcome::Ok(true))
    }

    /// Makes sure every label in `names` exists on the repository: those
    /// missing are created when `actor` may triage it, and refused
    /// otherwise. Returns their colors, by name.
    pub(crate) async fn ensure_labels(
        &self,
        actor: &User,
        repo: &Repo,
        names: &[String],
    ) -> Result<Outcome<Vec<(String, String)>>> {
        if names.is_empty() {
            return Ok(Outcome::Ok(Vec::new()));
        }
        let existing: Vec<Label> = self.labels_in(&repo.id, None).await?;
        let missing: Vec<&String> = names.iter().filter(|name| !existing.iter().any(|label| label.name == **name)).collect();
        if !missing.is_empty() {
            if !g1t_contracts::access::check(Some(actor), repo, Capability::Triage).is_ok() {
                let list = missing.iter().map(|name| name.as_str()).collect::<Vec<_>>().join(", ");
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!(
                        "{} has no label named {list}. Someone with the Triage role can create it on the labels page.",
                        repo.name
                    ),
                ));
            }
            let now = rfc3339(now_ms());
            let statements = missing
                .iter()
                .map(|name| {
                    self.db
                        .prepare(
                            "INSERT OR IGNORE INTO labels (repo_id, name, color, description, created_at)
                             VALUES (?, ?, ?, '', ?)",
                        )
                        .bind(&[
                            repo.id.as_str().into(),
                            name.as_str().into(),
                            label_color_for(name).into(),
                            now.as_str().into(),
                        ])
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

    /// Gives an issue or a pull request the labels `wanted`, creating the
    /// missing ones as [`ensure_labels`](Work::ensure_labels) does, and says
    /// what changed: in its conversation, and as one `labeled` or
    /// `unlabeled` event for each label. Returns its labels now.
    pub(crate) async fn relabel(
        &self,
        actor: &User,
        repo: &Repo,
        item: &Item,
        wanted: &[String],
    ) -> Result<Outcome<Vec<String>>> {
        let Some(after) = normalize_labels(wanted) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("An issue or pull request can have up to {MAX_LABELS} labels of up to {MAX_LABEL_CHARS} characters each."),
            ));
        };
        let colors = check!(self.ensure_labels(actor, repo, &after).await?);
        let before = item.labels().to_vec();
        let (added, removed) = label_changes(&before, &after);
        if added.is_empty() && removed.is_empty() {
            return Ok(Outcome::Ok(after));
        }
        self.db
            .prepare(format!("UPDATE {} SET labels = ?, updated_at = ? WHERE repo_id = ? AND number = ?", item.table()))
            .bind(&[
                serde_json::to_string(&after)?.into(),
                rfc3339(now_ms()).into(),
                repo.id.as_str().into(),
                item.number().into(),
            ])?
            .run()
            .await?;
        self.announce_labels(actor, item, &added, &removed, &colors).await?;
        Ok(Outcome::Ok(after))
    }

    /// Notes and events for labels put on and taken off an item.
    pub(crate) async fn announce_labels(
        &self,
        actor: &User,
        item: &Item,
        added: &[String],
        removed: &[String],
        colors: &[(String, String)],
    ) -> Result<()> {
        let who = (actor.id.as_str(), actor.username.as_str());
        if !added.is_empty() {
            self.note(item.repo_id(), item.number(), who, &label_note("added", added)).await?;
        }
        if !removed.is_empty() {
            self.note(item.repo_id(), item.number(), who, &label_note("removed", removed)).await?;
        }
        let color_of = |name: &String| {
            colors.iter().find(|(known, _)| known == name).map_or_else(|| label_color_for(name), |(_, color)| color.clone())
        };
        for (what, names) in [("labeled", added), ("unlabeled", removed)] {
            for name in names {
                let label = Some(EventLabel { name: name.clone(), color: color_of(name) });
                match item {
                    Item::Issue(issue) => {
                        self.publish(item.kind(what), &issue.repo_id, actor, IssueEvent { label, ..Self::issue_event(issue) })
                            .await?;
                    }
                    Item::Pull(pull) => {
                        self.publish(item.kind(what), &pull.repo_id, actor, PullEvent { label, ..Self::pull_event(pull) })
                            .await?;
                    }
                }
            }
        }
        Ok(())
    }

    /// `set_labels`: the labels of an issue or a pull request, replaced,
    /// added to or taken from. Its owner may use the repository's labels
    /// on it; anyone else needs the Triage role.
    pub(crate) async fn set_labels(&self, a: SetLabelsArgs) -> Result<Outcome<Vec<String>>> {
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        let item = match self.issue(&repo.id, a.number).await? {
            Some(issue) => Item::Issue(issue),
            None => match self.pull(&repo.id, a.number).await? {
                Some(pull) => Item::Pull(pull),
                None => {
                    return Ok(Outcome::fail(FailureCode::NotFound, "No issue or pull request has that number."));
                }
            },
        };
        if !item.owned_by(&a.actor.id) {
            check!(allowed(Some(&a.actor), &repo, Capability::Triage));
        }
        let given = match a.change {
            // Taking off works on names as given, tidied the same way.
            LabelChange::Remove => normalize_labels(&a.labels).unwrap_or_default(),
            _ => a.labels.clone(),
        };
        let wanted = changed_labels(item.labels(), &given, a.change);
        let labels = check!(self.relabel(&a.actor, &repo, &item, &wanted).await?);
        if let Item::Issue(issue) = &item
            && let Some(now) = self.issue(&repo.id, issue.number).await?
        {
            self.apply_label_rule(&a.actor, &now, &issue.labels).await?;
        }
        Ok(Outcome::Ok(labels))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| (*name).to_owned()).collect()
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
        assert_eq!(
            label_note("added", &names(&["a", "b", "c"])),
            "added the `a`, `b` and `c` labels"
        );
    }

    #[test]
    fn a_name_is_tidied_or_refused() {
        assert_eq!(one_name("  Good   First Issue ").unwrap(), "good first issue");
        assert!(one_name(" ").is_err());
        assert!(one_name(&"x".repeat(51)).is_err());
        assert!(tidy_description(&"x".repeat(101)).is_err());
    }
}
