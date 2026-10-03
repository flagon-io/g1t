//! Secrets and variables, a repository's or its workspace's. A
//! repository's override its workspace's of the same name. Names are
//! upper-cased, as GitHub treats them without regard to case.

use g1t_contracts::actions::{DeleteSettingArgs, SetSettingArgs, Setting, SettingsArgs, SettingsOwner};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::{Map, Value};
use worker::Result;

use crate::{Actions, check, fail};

/// The largest value, as on GitHub.
const MAX_VALUE_BYTES: usize = 48 * 1024;
const MAX_PER_OWNER: u32 = 100;

#[derive(Deserialize)]
struct SettingRow {
    id: String,
    scope: String,
    name: String,
    value: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct Count {
    n: u32,
}

/// A name GitHub would accept: letters, digits and `_`, not starting with
/// a digit or `GITHUB_`.
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
    if upper.starts_with("GITHUB_") {
        return Err("Names starting with GITHUB_ are kept for GitHub's own.".to_owned());
    }
    Ok(upper)
}

/// Where settings live: `(scope, owner)` with the owner a repository id or
/// a workspace slug, and whether the actor may change them.
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

    fn kind(kind: &str) -> Outcome<&'static str> {
        match kind {
            "secret" | "secrets" => Outcome::Ok("secret"),
            "variable" | "variables" => Outcome::Ok("variable"),
            _ => fail(FailureCode::Invalid, "`kind` is `secret` or `variable`."),
        }
    }

    pub async fn settings(&self, a: SettingsArgs) -> Result<Outcome<Vec<Setting>>> {
        let kind = check!(Self::kind(&a.kind));
        let place = check!(self.place(&a.actor, &a.owner, false).await?);
        // A repository's list shows its workspace's too, which it inherits.
        let owners: Vec<&str> = if place.scope == "repository" { vec![place.namespace.as_str(), place.owner.as_str()] } else { vec![place.owner.as_str()] };
        let mut out: Vec<Setting> = Vec::new();
        for owner in owners {
            let rows = self
                .db
                .prepare("SELECT * FROM settings WHERE owner = ? AND kind = ? ORDER BY name")
                .bind(&[owner.into(), kind.into()])?
                .all()
                .await?
                .results::<SettingRow>()?;
            for row in rows {
                out.retain(|setting| setting.name != row.name);
                out.push(Setting {
                    name: row.name,
                    value: (kind == "variable").then_some(row.value),
                    scope: row.scope,
                    updated_at: row.updated_at,
                });
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(Outcome::Ok(out))
    }

    pub async fn set_setting(&self, a: SetSettingArgs) -> Result<Outcome<Setting>> {
        let kind = check!(Self::kind(&a.kind));
        let name = match valid_name(&a.name) {
            Ok(name) => name,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        if a.value.len() > MAX_VALUE_BYTES {
            return Ok(fail(FailureCode::Invalid, "A value is at most 48 KB."));
        }
        let place = check!(self.place(&a.actor, &a.owner, true).await?);
        let count = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM settings WHERE owner = ? AND kind = ? AND name != ?")
            .bind(&[place.owner.as_str().into(), kind.into(), name.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |c| c.n);
        if count >= MAX_PER_OWNER {
            return Ok(fail(FailureCode::Invalid, format!("There can be at most {MAX_PER_OWNER} {kind}s here.")));
        }
        let existing = self
            .db
            .prepare("SELECT * FROM settings WHERE owner = ? AND kind = ? AND name = ?")
            .bind(&[place.owner.as_str().into(), kind.into(), name.as_str().into()])?
            .first::<SettingRow>(None)
            .await?;
        let id = existing.map(|row| row.id).unwrap_or_else(|| new_id("set", now_ms()));
        let value = if kind == "secret" {
            let Some(sealer) = &self.sealer else {
                return Ok(fail(FailureCode::Conflict, "Secrets cannot be saved yet: g1t's key for them is not set."));
            };
            sealer.seal(&a.value, &id)
        } else {
            a.value.clone()
        };
        let at = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO settings (id, scope, owner, kind, name, value, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (owner, kind, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            )
            .bind(&[id.as_str().into(), place.scope.into(), place.owner.as_str().into(), kind.into(), name.as_str().into(), value.into(), at.as_str().into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(Setting {
            name,
            value: (kind == "variable").then_some(a.value),
            scope: place.scope.to_owned(),
            updated_at: at,
        }))
    }

    pub async fn delete_setting(&self, a: DeleteSettingArgs) -> Result<Outcome<bool>> {
        let kind = check!(Self::kind(&a.kind));
        let place = check!(self.place(&a.actor, &a.owner, true).await?);
        let removed = self
            .db
            .prepare("DELETE FROM settings WHERE owner = ? AND kind = ? AND name = ? RETURNING id")
            .bind(&[place.owner.as_str().into(), kind.into(), a.name.trim().to_ascii_uppercase().into()])?
            .first::<Value>(None)
            .await?;
        Ok(match removed {
            Some(_) => Outcome::Ok(true),
            None => fail(FailureCode::NotFound, format!("There is no {kind} called {}.", a.name)),
        })
    }

    async fn resolved(&self, repo_id: &str, namespace: &str, kind: &str) -> Result<Map<String, Value>> {
        let mut out = Map::new();
        for owner in [namespace.to_lowercase(), repo_id.to_owned()] {
            let rows = self
                .db
                .prepare("SELECT * FROM settings WHERE owner = ? AND kind = ?")
                .bind(&[owner.into(), kind.into()])?
                .all()
                .await?
                .results::<SettingRow>()?;
            for row in rows {
                let value = if kind == "secret" {
                    match self.sealer.as_ref().and_then(|sealer| sealer.open(&row.value, &row.id)) {
                        Some(value) => value,
                        None => continue,
                    }
                } else {
                    row.value
                };
                out.insert(row.name, Value::String(value));
            }
        }
        Ok(out)
    }

    /// The `vars` context of a repository's runs.
    pub async fn variables_for(&self, repo_id: &str, namespace: &str) -> Result<Map<String, Value>> {
        self.resolved(repo_id, namespace, "variable").await
    }

    /// The `secrets` context of a repository's runs, opened.
    pub async fn secrets_for(&self, repo_id: &str, namespace: &str) -> Result<Map<String, Value>> {
        self.resolved(repo_id, namespace, "secret").await
    }
}

#[cfg(test)]
mod tests {
    use super::valid_name;

    #[test]
    fn names_follow_githubs_rules() {
        assert_eq!(valid_name("npm_token").unwrap(), "NPM_TOKEN");
        assert!(valid_name("GITHUB_TOKEN").is_err());
        assert!(valid_name("1PASSWORD").is_err());
        assert!(valid_name("MY-TOKEN").is_err());
        assert!(valid_name("").is_err());
    }
}
