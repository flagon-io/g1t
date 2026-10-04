//! Secrets and variables, a repository's or its workspace's: one list for
//! every reader, shaped like Vercel's environment variables. Each row is a
//! key, its type (a secret, or a variable shown as Config), the
//! environments it applies to and who reads it: workflows, deployments, or
//! both. A key may have one row per environment, so production and
//! previews can hold different values; a key's rows never overlap.
//!
//! A reader asking for an environment gets the row naming it, else the
//! key's row for every environment. A repository's row overrides its
//! workspace's of the same key. Names are upper-cased, as GitHub treats
//! them without regard to case. Agents never read any.

use g1t_contracts::actions::{
    CONSUMERS, DeleteSettingArgs, ResolveSettingsArgs, ResolvedSettings, SetSettingArgs, Setting, SettingsArgs,
    SettingsOwner,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::{Map, Value};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Actions, check, fail};

/// The largest value, as on GitHub.
const MAX_VALUE_BYTES: usize = 48 * 1024;
const MAX_PER_OWNER: u32 = 200;
const MAX_NOTE: usize = 500;

#[derive(Deserialize)]
struct SettingRow {
    id: String,
    scope: String,
    kind: String,
    name: String,
    value: String,
    updated_at: String,
    available_to: String,
    environments: String,
    repositories: Option<String>,
    note: Option<String>,
    updated_by: Option<String>,
}

/// A name GitHub would accept: letters, digits and `_`, not starting with
/// a digit, `GITHUB_` or `G1T_`, which are g1t's own (`G1T_TOKEN` and its
/// alias `GITHUB_TOKEN`).
fn valid_name(name: &str) -> Result<String, String> {
    let upper = name.trim().to_ascii_uppercase();
    if upper.is_empty() || upper.len() > 100 {
        return Err("A name is 1 to 100 characters.".to_owned());
    }
    if !upper.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("A name has only letters, digits and underscores.".to_owned());
    }
    if upper.starts_with(|c: char| c.is_ascii_digit()) {
        return Err("A name cannot start with a digit.".to_owned());
    }
    if upper.starts_with("GITHUB_") || upper.starts_with("G1T_") {
        return Err("Names starting with G1T_ or GITHUB_ are kept for g1t's own, such as G1T_TOKEN.".to_owned());
    }
    Ok(upper)
}

/// Environments' names: lowercase letters, digits, `-` and `_`, each once.
fn valid_environments(list: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for name in list {
        let lower = name.trim().to_ascii_lowercase();
        if lower.is_empty() {
            continue;
        }
        if lower.len() > 40 || !lower.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(format!("`{name}` is not an environment's name: up to 40 letters, digits, - and _."));
        }
        if !out.contains(&lower) {
            out.push(lower);
        }
    }
    out.sort();
    Ok(out)
}

fn consumers(list: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let item = item.trim().to_ascii_lowercase();
        if !CONSUMERS.contains(&item.as_str()) {
            return Err(format!("`{item}` is not a reader: use workflows or deployments."));
        }
        if !out.contains(&item) {
            out.push(item);
        }
    }
    if out.is_empty() {
        return Err("Choose who reads it: workflows, deployments, or both.".to_owned());
    }
    Ok(out)
}

fn split(list: &str) -> Vec<String> {
    list.split(',').filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

impl SettingRow {
    fn environments(&self) -> Vec<String> {
        split(&self.environments)
    }

    fn repositories(&self) -> Vec<String> {
        self.repositories.as_deref().and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default()
    }

    fn reaches(&self, repo: &str) -> bool {
        let list = self.repositories();
        list.is_empty() || list.iter().any(|r| r.eq_ignore_ascii_case(repo))
    }

    /// Whether it and rows for `environments` would both apply somewhere.
    fn overlaps(&self, environments: &[String]) -> bool {
        let mine = self.environments();
        mine.is_empty() == environments.is_empty() && (mine.is_empty() || mine.iter().any(|e| environments.contains(e)))
    }

    fn describe(self) -> Setting {
        Setting {
            available_to: split(&self.available_to),
            environments: self.environments(),
            repositories: self.repositories(),
            value: (self.kind == "variable").then_some(self.value),
            id: self.id,
            name: self.name,
            kind: self.kind,
            scope: self.scope,
            updated_at: self.updated_at,
            note: self.note,
            updated_by: self.updated_by,
        }
    }
}

/// Where settings live: `(scope, owner)` with the owner a repository id or
/// a workspace slug.
struct Place {
    scope: &'static str,
    owner: String,
    namespace: String,
}

impl Actions {
    async fn place(&self, actor: &User, owner: &SettingsOwner, changing: bool) -> Result<Outcome<Place>> {
        if actor.kind == PrincipalKind::Agent {
            return Ok(fail(FailureCode::Forbidden, "Agents cannot read or change secrets and variables."));
        }
        // A workspace's tokens, G1T_TOKEN among them, read the names but
        // never change them: a workflow must not rewrite what it runs with.
        if changing && actor.kind == PrincipalKind::Workspace {
            return Ok(fail(
                FailureCode::Forbidden,
                "A workspace's tokens, G1T_TOKEN included, cannot change secrets and variables. Use a person's token or the site.",
            ));
        }
        match (&owner.repo, &owner.workspace) {
            (Some(path), _) => {
                if !actor.is_member(&path.namespace.to_lowercase()) {
                    return Ok(fail(FailureCode::Forbidden, format!("Only members of {} can see its secrets and variables.", path.namespace)));
                }
                let Some(repo) = self.visible_repo(path, &Some(actor.clone())).await? else {
                    return Ok(fail(FailureCode::NotFound, "There is no such repository."));
                };
                Ok(Outcome::Ok(Place { scope: "repository", owner: repo.id, namespace: repo.namespace }))
            }
            (None, Some(slug)) => {
                let slug = slug.to_lowercase();
                let role = actor.workspaces.iter().find(|m| m.slug.eq_ignore_ascii_case(&slug)).map(|m| m.role);
                match role {
                    None => Ok(fail(FailureCode::Forbidden, format!("Only members of {slug} can see its secrets and variables."))),
                    Some(Role::Member) if changing => Ok(fail(FailureCode::Forbidden, format!("Only owners of {slug} can change its secrets and variables."))),
                    Some(_) => Ok(Outcome::Ok(Place { scope: "workspace", owner: slug.clone(), namespace: slug })),
                }
            }
            (None, None) => Ok(fail(FailureCode::Invalid, "Give `repo` or `workspace`.")),
        }
    }

    /// `secret`, `variable`, or `None` for both.
    fn kind(kind: &str) -> Outcome<Option<&'static str>> {
        match kind {
            "secret" | "secrets" => Outcome::Ok(Some("secret")),
            "variable" | "variables" | "config" => Outcome::Ok(Some("variable")),
            "" | "all" => Outcome::Ok(None),
            _ => fail(FailureCode::Invalid, "`kind` is `secret` or `variable`."),
        }
    }

    async fn rows(&self, owner: &str) -> Result<Vec<SettingRow>> {
        self.db
            .prepare("SELECT * FROM settings WHERE owner = ? ORDER BY name, environments")
            .bind(&[owner.into()])?
            .all()
            .await?
            .results::<SettingRow>()
    }

    pub async fn settings(&self, a: SettingsArgs) -> Result<Outcome<Vec<Setting>>> {
        let kind = check!(Self::kind(&a.kind));
        let place = check!(self.place(&a.actor, &a.owner, false).await?);
        let repo_name = a.owner.repo.as_ref().map(|r| r.name.clone());
        let mut out: Vec<Setting> = Vec::new();
        // A repository's list shows the workspace's rows that reach it, but
        // for keys it sets itself.
        if place.scope == "repository" {
            let own: Vec<String> = self.rows(&place.owner).await?.into_iter().map(|row| row.name).collect();
            for row in self.rows(&place.namespace.to_lowercase()).await? {
                if repo_name.as_deref().is_some_and(|name| row.reaches(name)) && !own.contains(&row.name) {
                    out.push(row.describe());
                }
            }
        }
        out.extend(self.rows(&place.owner).await?.into_iter().map(SettingRow::describe));
        out.retain(|setting| kind.is_none_or(|kind| setting.kind == kind));
        out.sort_by(|a, b| a.name.cmp(&b.name).then(a.environments.cmp(&b.environments)));
        Ok(Outcome::Ok(out))
    }

    fn seal(&self, value: &str, id: &str) -> Outcome<String> {
        match &self.sealer {
            Some(sealer) => Outcome::Ok(sealer.seal(value, id)),
            None => fail(FailureCode::Conflict, "Secrets cannot be saved yet: g1t's key for them is not set."),
        }
    }

    pub async fn set_setting(&self, a: SetSettingArgs) -> Result<Outcome<Setting>> {
        let Some(kind) = check!(Self::kind(&a.kind)) else {
            return Ok(fail(FailureCode::Invalid, "`kind` is `secret` or `variable`."));
        };
        let name = match valid_name(&a.name) {
            Ok(name) => name,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        if a.value.as_ref().is_some_and(|v| v.len() > MAX_VALUE_BYTES) {
            return Ok(fail(FailureCode::Invalid, "A value is at most 48 KB."));
        }
        if a.note.as_ref().is_some_and(|n| n.len() > MAX_NOTE) {
            return Ok(fail(FailureCode::Invalid, "A note is at most 500 characters."));
        }
        let readers = match a.available_to.as_deref().map(consumers).transpose() {
            Ok(readers) => readers,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        let environments = match a.environments.as_deref().map(valid_environments).transpose() {
            Ok(environments) => environments,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        let place = check!(self.place(&a.actor, &a.owner, true).await?);
        if a.repositories.as_ref().is_some_and(|r| !r.is_empty()) && place.scope != "workspace" {
            return Ok(fail(FailureCode::Invalid, "Only a workspace's rows choose repositories."));
        }
        let rows = self.rows(&place.owner).await?;
        // A secret and a variable may share a key, as on GitHub, where
        // workflows read them apart (`secrets.X`, `vars.X`).
        let same_key: Vec<&SettingRow> = rows.iter().filter(|row| row.name == name).collect();
        // The row being changed: by id, else the key's row for every
        // environment (GitHub's API names a secret by its key alone).
        let existing = match &a.id {
            Some(id) => match rows.iter().find(|row| &row.id == id) {
                Some(row) => Some(row),
                None => return Ok(fail(FailureCode::NotFound, "There is no such row.")),
            },
            None if a.environments.is_none() => same_key.iter().copied().find(|row| row.environments.is_empty() && row.kind == kind),
            None => None,
        };
        if existing.is_some_and(|row| row.kind == "secret" && kind == "variable") {
            return Ok(fail(FailureCode::Invalid, "A secret cannot become config: its value is sealed. Add a config row and remove the secret."));
        }
        let environments = environments.unwrap_or_else(|| existing.map(SettingRow::environments).unwrap_or_default());
        // A key's rows never apply to the same environment twice.
        if let Some(clash) = same_key
            .iter()
            .find(|row| row.kind == kind && existing.is_none_or(|e| e.id != row.id) && row.overlaps(&environments))
        {
            let at = if clash.environments.is_empty() { "all environments".to_owned() } else { clash.environments.replace(',', ", ") };
            let what = if kind == "secret" { "secret" } else { "config" };
            return Ok(fail(
                FailureCode::Conflict,
                format!("{name} already has a {what} row for {at}. Edit that row, or choose other environments."),
            ));
        }
        if existing.is_none() && rows.len() as u32 >= MAX_PER_OWNER {
            return Ok(fail(FailureCode::Invalid, format!("There can be at most {MAX_PER_OWNER} secrets and variables here.")));
        }
        let id = existing.map(|row| row.id.clone()).unwrap_or_else(|| new_id("set", now_ms()));
        let value = match (&a.value, existing) {
            (Some(value), _) if kind == "secret" => check!(self.seal(value, &id)),
            (Some(value), _) => value.clone(),
            // Config becoming a secret: its value is sealed now.
            (None, Some(row)) if row.kind == "variable" && kind == "secret" => check!(self.seal(&row.value, &id)),
            (None, Some(row)) => row.value.clone(),
            (None, None) => return Ok(fail(FailureCode::Invalid, "A new row needs a `value`.")),
        };
        let available_to = readers
            .map(|r| r.join(","))
            .or_else(|| existing.map(|row| row.available_to.clone()))
            .unwrap_or_else(|| CONSUMERS.join(","));
        let repositories: Option<String> = match &a.repositories {
            Some(list) if list.is_empty() => None,
            Some(list) => Some(serde_json::to_string(list).unwrap_or_default()),
            None => existing.and_then(|row| row.repositories.clone()),
        };
        let note = match &a.note {
            Some(note) if note.trim().is_empty() => None,
            Some(note) => Some(note.trim().to_owned()),
            None => existing.and_then(|row| row.note.clone()),
        };
        let at = rfc3339(now_ms());
        let optional = |v: Option<&str>| v.map_or(JsValue::NULL, JsValue::from);
        self.db
            .prepare(
                "INSERT INTO settings (id, scope, owner, kind, name, value, updated_at, available_to, environments, repositories, note, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, value = excluded.value, updated_at = excluded.updated_at,
                   available_to = excluded.available_to, environments = excluded.environments,
                   repositories = excluded.repositories, note = excluded.note, updated_by = excluded.updated_by",
            )
            .bind(&[
                id.as_str().into(),
                place.scope.into(),
                place.owner.as_str().into(),
                kind.into(),
                name.as_str().into(),
                value.into(),
                at.as_str().into(),
                available_to.as_str().into(),
                environments.join(",").into(),
                optional(repositories.as_deref()),
                optional(note.as_deref()),
                a.actor.username.as_str().into(),
            ])?
            .run()
            .await?;
        let row = self
            .db
            .prepare("SELECT * FROM settings WHERE id = ?")
            .bind(&[id.as_str().into()])?
            .first::<SettingRow>(None)
            .await?
            .expect("just written");
        Ok(Outcome::Ok(row.describe()))
    }

    pub async fn delete_setting(&self, a: DeleteSettingArgs) -> Result<Outcome<bool>> {
        let kind = check!(Self::kind(&a.kind));
        let place = check!(self.place(&a.actor, &a.owner, true).await?);
        let name = a.name.trim().to_ascii_uppercase();
        let removed = match &a.id {
            Some(id) => self
                .db
                .prepare("DELETE FROM settings WHERE owner = ? AND id = ? RETURNING id")
                .bind(&[place.owner.as_str().into(), id.as_str().into()])?
                .all()
                .await?,
            None => self
                .db
                .prepare("DELETE FROM settings WHERE owner = ? AND name = ? AND (?3 IS NULL OR kind = ?3) RETURNING id")
                .bind(&[place.owner.as_str().into(), name.as_str().into(), kind.map_or(JsValue::NULL, JsValue::from)])?
                .all()
                .await?,
        };
        Ok(if removed.results::<Value>()?.is_empty() {
            fail(FailureCode::NotFound, format!("There is nothing called {} here.", a.name))
        } else {
            Outcome::Ok(true)
        })
    }

    /// What one reader of a repository gets: per key, the row for
    /// `environment`, else the row for every environment; the repository's
    /// over its workspace's. No secrets unless `trusted`.
    #[allow(clippy::too_many_arguments)]
    async fn resolved(
        &self,
        repo_id: &str,
        repo_name: &str,
        namespace: &str,
        kind: &str,
        consumer: &str,
        environment: Option<&str>,
        trusted: bool,
    ) -> Result<Map<String, Value>> {
        if kind == "secret" && !trusted {
            return Ok(Map::new());
        }
        let environment = environment.map(str::to_ascii_lowercase);
        let mut out = Map::new();
        for owner in [namespace.to_lowercase(), repo_id.to_owned()] {
            let rows: Vec<SettingRow> = self
                .rows(&owner)
                .await?
                .into_iter()
                .filter(|row| row.kind == kind)
                .filter(|row| split(&row.available_to).iter().any(|r| r == consumer))
                .filter(|row| row.scope != "workspace" || row.reaches(repo_name))
                .collect();
            let mut names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
            names.dedup();
            for name in names {
                let of_key: Vec<&SettingRow> = rows.iter().filter(|row| row.name == name).collect();
                let chosen = environment
                    .as_deref()
                    .and_then(|env| of_key.iter().find(|row| row.environments().iter().any(|e| e == env)))
                    .or_else(|| of_key.iter().find(|row| row.environments.is_empty()));
                let Some(row) = chosen else {
                    // Rows only for other environments: this reader gets
                    // none, nor the workspace's.
                    out.remove(name);
                    continue;
                };
                let value = if kind == "secret" {
                    match self.sealer.as_ref().and_then(|sealer| sealer.open(&row.value, &row.id)) {
                        Some(value) => value,
                        None => continue,
                    }
                } else {
                    row.value.clone()
                };
                out.insert(name.to_owned(), Value::String(value));
            }
        }
        Ok(out)
    }

    /// The `vars` context of a repository's runs. `environment` is the job's
    /// `environment:`, when it has one.
    pub async fn variables_for(&self, repo_id: &str, repo: &str, environment: Option<&str>, trusted: bool) -> Result<Map<String, Value>> {
        let (namespace, name) = repo.split_once('/').unwrap_or((repo, ""));
        self.resolved(repo_id, name, namespace, "variable", "workflows", environment, trusted).await
    }

    /// The `secrets` context of a repository's runs, opened.
    pub async fn secrets_for(&self, repo_id: &str, repo: &str, environment: Option<&str>, trusted: bool) -> Result<Map<String, Value>> {
        let (namespace, name) = repo.split_once('/').unwrap_or((repo, ""));
        self.resolved(repo_id, name, namespace, "secret", "workflows", environment, trusted).await
    }

    /// `resolve_settings`, for the deployments service: what a deploy build
    /// and its running app get.
    pub async fn resolve_settings(&self, a: ResolveSettingsArgs) -> Result<ResolvedSettings> {
        let environment = a.environment.as_deref();
        Ok(ResolvedSettings {
            secrets: self
                .resolved(&a.repo_id, &a.repo.name, &a.repo.namespace, "secret", &a.consumer, environment, a.trusted)
                .await?,
            variables: self
                .resolved(&a.repo_id, &a.repo.name, &a.repo.namespace, "variable", &a.consumer, environment, a.trusted)
                .await?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{SettingRow, consumers, valid_environments, valid_name};

    fn row(environments: &str) -> SettingRow {
        SettingRow {
            id: "set_1".into(),
            scope: "repository".into(),
            kind: "secret".into(),
            name: "STRIPE_KEY".into(),
            value: String::new(),
            updated_at: String::new(),
            available_to: "workflows,deployments".into(),
            environments: environments.into(),
            repositories: None,
            note: None,
            updated_by: None,
        }
    }

    #[test]
    fn names_follow_githubs_rules_and_keep_g1ts_own() {
        assert_eq!(valid_name("npm_token").unwrap(), "NPM_TOKEN");
        assert!(valid_name("GITHUB_TOKEN").is_err());
        assert!(valid_name("G1T_TOKEN").is_err());
        assert!(valid_name("1PASSWORD").is_err());
        assert!(valid_name("MY-TOKEN").is_err());
        assert!(valid_name("").is_err());
    }

    #[test]
    fn environments_and_readers_are_checked() {
        assert_eq!(valid_environments(&["Production".into(), "preview".into(), "production".into()]).unwrap(), vec!["preview", "production"]);
        assert!(valid_environments(&["staging env".into()]).is_err());
        assert_eq!(consumers(&["Deployments".into(), "deployments".into()]).unwrap(), vec!["deployments"]);
        assert!(consumers(&["agents".into()]).is_err());
        assert!(consumers(&[]).is_err());
    }

    #[test]
    fn a_keys_rows_cannot_share_an_environment() {
        assert!(row("production").overlaps(&["production".into(), "preview".into()]));
        assert!(!row("production").overlaps(&["preview".into()]));
        // One row for every environment, and others for some, live together.
        assert!(!row("").overlaps(&["preview".into()]));
        assert!(row("").overlaps(&[]));
    }
}
