//! A workspace's people: the directory of its members and teams, and each
//! member's place in it (a title, who they report to, what they own). See
//! `g1t_contracts::people`. Agents live in the agents service; teams name
//! them by id.

use std::collections::HashMap;

use g1t_contracts::audit::Surface;
use g1t_contracts::people::*;
use g1t_contracts::teams::{TeamRef, TeamRole};
use g1t_contracts::{FailureCode, Outcome, Role};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;
use crate::teams::{TeamRow, budget_of, channel_of, may_see, role_of};

const MEMBERS_ONLY: &str = "Only members can see who is in a workspace.";
const NO_SUCH_MEMBER: &str = "There is no member with that username.";

/// What someone owns, from its stored JSON; nothing when it is missing or
/// not a list of words.
pub fn owns_from(json: Option<&str>) -> Vec<String> {
    json.and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .map(|owns| clean_owns(&owns))
        .unwrap_or_default()
}

/// One member's row, as the directory reads it.
#[derive(Deserialize)]
struct PersonRow {
    user_id: String,
    username: String,
    #[serde(default)]
    display_username: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
    #[serde(default)]
    bio: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    pronouns: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
    role: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    owns: Option<String>,
    #[serde(default)]
    manager: Option<String>,
    joined_at: String,
}

impl PersonRow {
    fn person(self) -> DirectoryPerson {
        let blank = |value: Option<String>| value.filter(|value| !value.trim().is_empty());
        DirectoryPerson {
            user_id: self.user_id,
            display_username: self.display_username.filter(|shown| *shown != self.username),
            username: self.username,
            name: blank(self.name),
            avatar: self.avatar,
            bio: blank(self.bio),
            location: blank(self.location),
            pronouns: blank(self.pronouns),
            timezone: blank(self.timezone),
            role: if self.role == "owner" { Role::Owner } else { Role::Member },
            title: self.title.as_deref().and_then(clean_title),
            manager: self.manager,
            owns: owns_from(self.owns.as_deref()),
            joined_at: self.joined_at,
        }
    }
}

/// Every member of a workspace (by slug, `?1`), with `filter` added.
fn people_sql(filter: &str) -> String {
    format!(
        "SELECT u.id AS user_id, u.username, u.display_username, u.display_name AS name, u.avatar, u.bio, u.location,
           u.pronouns, u.timezone, wm.role, wm.title, wm.owns, mu.username AS manager, wm.created_at AS joined_at
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id AND u.deleted_at IS NULL
         JOIN workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
         LEFT JOIN users mu ON mu.id = wm.manager_id AND mu.deleted_at IS NULL
         WHERE w.slug = ?1 {filter}
         ORDER BY lower(coalesce(u.display_name, u.username)) LIMIT 5000"
    )
}

#[derive(Deserialize)]
struct TeamPersonRow {
    team_id: String,
    username: String,
    role: String,
}

#[derive(Deserialize)]
struct TeamAgentRow {
    team_id: String,
    agent_id: String,
}

#[derive(Deserialize)]
struct BaseRow {
    #[serde(default)]
    base_permission: Option<String>,
}

impl Identity {
    pub async fn people_directory(&self, a: PeopleArgs) -> Result<Outcome<PeopleDirectory>> {
        let workspace = a.workspace.trim().to_lowercase();
        let Some(viewer) = a.viewer.as_ref() else {
            return Ok(Outcome::fail(FailureCode::Forbidden, MEMBERS_ONLY));
        };
        let Some(role) = role_of(viewer, &workspace) else {
            return Ok(Outcome::fail(FailureCode::Forbidden, MEMBERS_ONLY));
        };
        let owner = role == Role::Owner;
        let slug = JsValue::from(workspace.as_str());
        let mut found = self
            .db
            .batch(vec![
                self.db.prepare(people_sql("")).bind(std::slice::from_ref(&slug))?,
                self.db
                    .prepare(
                        "SELECT tm.team_id, u.username, tm.role FROM team_members tm
                         JOIN teams t ON t.id = tm.team_id
                         JOIN workspaces w ON w.id = t.workspace_id
                         JOIN users u ON u.id = tm.user_id AND u.deleted_at IS NULL
                         WHERE w.slug = ?1 ORDER BY tm.role DESC, u.username LIMIT 20000",
                    )
                    .bind(std::slice::from_ref(&slug))?,
                self.db
                    .prepare(
                        "SELECT ta.team_id, ta.agent_id FROM team_agents ta
                         JOIN teams t ON t.id = ta.team_id
                         JOIN workspaces w ON w.id = t.workspace_id
                         WHERE w.slug = ?1 ORDER BY ta.created_at LIMIT 20000",
                    )
                    .bind(std::slice::from_ref(&slug))?,
                self.db
                    .prepare("SELECT base_permission FROM workspaces WHERE slug = ?1 AND deleted_at IS NULL")
                    .bind(std::slice::from_ref(&slug))?,
            ])
            .await?
            .into_iter();
        let mut next = || found.next().ok_or_else(|| worker::Error::RustError("a statement of the batch did not answer".into()));
        let people = next()?.results::<PersonRow>()?;
        let team_people = next()?.results::<TeamPersonRow>()?;
        let team_agents = next()?.results::<TeamAgentRow>()?;
        let base = next()?.results::<BaseRow>()?;
        let rows = self.workspace_team_rows(&workspace, &viewer.id).await?;
        let teams = rows
            .iter()
            .filter(|row| may_see(row.visibility(), owner, row.viewer_role.is_some()))
            .map(|row| DirectoryTeam {
                slug: row.slug.clone(),
                name: row.name.clone(),
                description: row.description.clone(),
                visibility: row.visibility(),
                parent: match (&row.parent_slug, &row.parent_name) {
                    (Some(slug), Some(name)) => Some(TeamRef {
                        slug: slug.clone(),
                        name: name.clone(),
                    }),
                    _ => None,
                },
                lead: row.lead(),
                channel: channel_of(row.channel_id.as_deref(), row.channel_name.as_deref()),
                budget_micros: budget_of(row.budget_micros),
                people: team_people
                    .iter()
                    .filter(|person| person.team_id == row.id)
                    .map(|person| TeamPersonRef {
                        username: person.username.clone(),
                        role: TeamRole::parse(&person.role).unwrap_or(TeamRole::Member),
                    })
                    .collect(),
                agent_ids: team_agents.iter().filter(|agent| agent.team_id == row.id).map(|agent| agent.agent_id.clone()).collect(),
                repos_count: row.repos_count,
            })
            .collect();
        Ok(Outcome::Ok(PeopleDirectory {
            people: people.into_iter().map(PersonRow::person).collect(),
            teams,
            base_permission: base
                .into_iter()
                .next()
                .and_then(|row| row.base_permission)
                .filter(|base| !base.trim().is_empty())
                .unwrap_or_else(|| "write".to_owned()),
            can_manage: owner,
        }))
    }

    pub async fn set_member_profile(&self, a: SetMemberProfileArgs) -> Result<Outcome<DirectoryPerson>> {
        let workspace = a.workspace.trim().to_lowercase();
        if !crate::security::is_person(&a.actor) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only a person can change a profile, signed in as themselves.",
            ));
        }
        let Some(role) = role_of(&a.actor, &workspace) else {
            return Ok(Outcome::fail(FailureCode::Forbidden, MEMBERS_ONLY));
        };
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        let owner = role == Role::Owner;
        let Some(workspace_id) = self.workspace_id_of(&workspace).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        let Some((user_id, username)) = self.person_by_username(&a.username).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_MEMBER));
        };
        if !self.is_member_of(&workspace_id, &user_id).await? {
            return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_MEMBER));
        }
        let is_self = a.actor.id == user_id;
        let mut sets: Vec<String> = Vec::new();
        let mut binds: Vec<JsValue> = Vec::new();
        let mut changed: Vec<&str> = Vec::new();
        let refused = |what: &str| {
            Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!("Only owners of {workspace} can change {what} for someone else."),
            ))
        };
        if let Some(title) = &a.title {
            if !may_edit_profile(ProfileField::Title, is_self, owner) {
                return refused("a title");
            }
            binds.push(clean_title(title).map_or(JsValue::NULL, JsValue::from));
            sets.push(format!("title = ?{}", binds.len()));
            changed.push("title");
        }
        if let Some(owns) = &a.owns {
            if !may_edit_profile(ProfileField::Owns, is_self, owner) {
                return refused("what someone owns");
            }
            let owns = clean_owns(owns);
            binds.push(if owns.is_empty() { JsValue::NULL } else { serde_json::to_string(&owns)?.into() });
            sets.push(format!("owns = ?{}", binds.len()));
            changed.push("what they own");
        }
        if let Some(manager) = a.manager.as_deref().map(str::trim) {
            if !may_edit_profile(ProfileField::Manager, is_self, owner) {
                return Ok(Outcome::fail(FailureCode::Forbidden, format!("Only owners of {workspace} set who someone reports to.")));
            }
            if manager.is_empty() {
                binds.push(JsValue::NULL);
            } else {
                let Some((manager_id, manager_name)) = self.person_by_username(manager).await? else {
                    return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_MEMBER));
                };
                if !self.is_member_of(&workspace_id, &manager_id).await? {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("{manager_name} is not a member of {workspace}."),
                    ));
                }
                let lines = self.reporting_lines(&workspace_id).await?;
                if makes_loop(&user_id, &manager_id, |id| lines.get(id).cloned()) {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("{username} can't report to {manager_name}: {manager_name} already reports to {username}, directly or through others."),
                    ));
                }
                binds.push(manager_id.into());
            }
            sets.push(format!("manager_id = ?{}", binds.len()));
            changed.push("manager");
        }
        if !sets.is_empty() {
            binds.push(JsValue::from(workspace_id.clone()));
            binds.push(JsValue::from(user_id.clone()));
            self.db
                .prepare(format!(
                    "UPDATE workspace_members SET {} WHERE workspace_id = ?{} AND user_id = ?{}",
                    sets.join(", "),
                    binds.len() - 1,
                    binds.len()
                ))
                .bind(&binds)?
                .run()
                .await?;
            self.audit_workspace(
                &a.actor,
                "member.profile_edited",
                &workspace,
                a.surface.unwrap_or(Surface::Web),
                format!("Changed {} for {username}", changed.join(", ")),
            )
            .await;
        }
        let person = self
            .db
            .prepare(people_sql("AND u.id = ?2"))
            .bind(&[workspace.as_str().into(), user_id.as_str().into()])?
            .first::<PersonRow>(None)
            .await?;
        Ok(match person {
            Some(person) => Outcome::Ok(person.person()),
            None => Outcome::fail(FailureCode::NotFound, NO_SUCH_MEMBER),
        })
    }

    /// Each member's manager in a workspace, by user id.
    async fn reporting_lines(&self, workspace_id: &str) -> Result<HashMap<String, String>> {
        #[derive(Deserialize)]
        struct Line {
            user_id: String,
            manager_id: String,
        }
        Ok(self
            .db
            .prepare("SELECT user_id, manager_id FROM workspace_members WHERE workspace_id = ? AND manager_id IS NOT NULL")
            .bind(&[workspace_id.into()])?
            .all()
            .await?
            .results::<Line>()?
            .into_iter()
            .map(|line| (line.user_id, line.manager_id))
            .collect())
    }

    /// Every team of a workspace, as `viewer_id` stands in each.
    async fn workspace_team_rows(&self, workspace: &str, viewer_id: &str) -> Result<Vec<TeamRow>> {
        self.team_rows("WHERE w.slug = ?2 ORDER BY lower(t.name)", &[viewer_id.into(), workspace.into()])
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_someone_owns_reads_back_from_storage() {
        assert_eq!(owns_from(Some(r#"["storefront"," Storefront ","releases"]"#)), vec!["storefront", "releases"]);
        assert!(owns_from(Some("not json")).is_empty());
        assert!(owns_from(None).is_empty());
    }
}
