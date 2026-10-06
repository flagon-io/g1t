//! Staff-only views of workspaces, for sudo.g1t.sh.
//!
//! These methods take no viewer and check no membership. Only sudo calls
//! them, over its service binding, once it has verified a Cloudflare Access
//! sign-in against its staff list; nothing a customer can reach forwards to
//! them. They read, and never change, anything.
//!
//! Every workspace is listed: there is one kind, and a person's own space
//! is simply a workspace with one member. A user with no workspace has
//! nothing to list, as nothing can exist outside one.

use std::collections::HashMap;

use g1t_contracts::Role;
use g1t_contracts::identity::*;
use serde::Deserialize;
use worker::Result;

use crate::Identity;

#[derive(Deserialize)]
struct ListRow {
    id: String,
    slug: String,
    name: String,
    created_at: String,
    member_count: u32,
}

#[derive(Deserialize)]
struct OwnerRow {
    workspace_id: String,
    username: String,
    email: Option<String>,
}

#[derive(Deserialize)]
struct DetailRow {
    id: String,
    slug: String,
    name: String,
    description: Option<String>,
    created_at: String,
    #[serde(default)]
    protected: u8,
}

#[derive(Deserialize)]
struct MemberRow {
    username: String,
    email: Option<String>,
    role: Role,
    joined: String,
}

/// A `LIKE` pattern matching `query` anywhere, lowercased, with `%`, `_`
/// and the escape character itself taken literally. None for a blank query.
pub(crate) fn like_pattern(query: Option<&str>) -> Option<String> {
    let query = query.map(str::trim).filter(|q| !q.is_empty())?;
    let mut pattern = String::from("%");
    for c in query.to_lowercase().chars().take(100) {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    Some(pattern)
}

/// The workspaces, in their order, each with its owners.
fn with_owners(rows: Vec<ListRow>, owners: Vec<OwnerRow>) -> Vec<AdminWorkspace> {
    let mut by_workspace: HashMap<String, Vec<AdminOwner>> = HashMap::new();
    for owner in owners {
        by_workspace.entry(owner.workspace_id).or_default().push(AdminOwner {
            username: owner.username,
            email: owner.email,
        });
    }
    rows.into_iter()
        .map(|row| AdminWorkspace {
            owners: by_workspace.remove(&row.id).unwrap_or_default(),
            slug: row.slug,
            name: row.name,
            created_at: row.created_at,
            member_count: row.member_count,
        })
        .collect()
}

impl Identity {
    /// The workspaces staff can see, newest first. Staff only: see the
    /// module's note.
    /// Emails each owner of the workspace with a confirmed address. Only
    /// other services call this; the link must stay on g1t.sh, so a notice
    /// can never point owners anywhere else.
    pub async fn notify_owners(&self, a: NotifyOwnersArgs) -> Result<u32> {
        if !a.link.starts_with("https://g1t.sh/") {
            return Ok(0);
        }
        #[derive(Deserialize)]
        struct Owner {
            email: Option<String>,
        }
        let owners = self
            .db
            .prepare(
                "SELECT u.email FROM workspace_members m
                 JOIN users u ON u.id = m.user_id
                 JOIN workspaces w ON w.id = m.workspace_id
                 WHERE w.slug = ? AND w.deleted_at IS NULL AND m.role = 'owner' AND u.email_verified_at IS NOT NULL",
            )
            .bind(&[a.workspace.to_lowercase().into()])?
            .all()
            .await?
            .results::<Owner>()?;
        let mut sent = 0;
        for email in owners.into_iter().filter_map(|owner| owner.email) {
            match crate::email::send_link(&self.env, &email, &a.subject, &a.intro, &a.action, &a.link, &a.footer).await {
                Ok(()) => sent += 1,
                Err(error) => worker::console_error!("could not email an owner of {}: {error}", a.workspace),
            }
        }
        Ok(sent)
    }

    pub async fn admin_workspaces(&self, a: AdminWorkspacesArgs) -> Result<Vec<AdminWorkspace>> {
        let pattern = like_pattern(a.query.as_deref());
        // The same filter picks the workspaces and, below, their owners.
        // Deleted ones are listed apart (`admin_deleted_workspaces`).
        let filter = if pattern.is_some() {
            "WHERE w.deleted_at IS NULL AND (w.slug LIKE ?1 ESCAPE '\\' OR lower(w.name) LIKE ?1 ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM workspace_members om JOIN users ou ON ou.id = om.user_id
                          WHERE om.workspace_id = w.id AND om.role = 'owner'
                            AND (lower(ou.username) LIKE ?1 ESCAPE '\\' OR lower(ou.email) LIKE ?1 ESCAPE '\\')))"
        } else {
            "WHERE w.deleted_at IS NULL"
        };
        let chosen = format!(
            "SELECT w.id FROM workspaces w {filter}
             ORDER BY w.created_at DESC, w.slug LIMIT {ADMIN_WORKSPACES_LIMIT}"
        );
        let binds: Vec<worker::wasm_bindgen::JsValue> = pattern.into_iter().map(Into::into).collect();
        let rows = self
            .db
            .prepare(format!(
                "SELECT w.id, w.slug, w.name, w.created_at,
                   (SELECT count(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count
                 FROM workspaces w WHERE w.id IN ({chosen})
                 ORDER BY w.created_at DESC, w.slug"
            ))
            .bind(&binds)?
            .all()
            .await?
            .results::<ListRow>()?;
        let owners = self
            .db
            .prepare(format!(
                "SELECT m.workspace_id, u.username, u.email FROM workspace_members m
                 JOIN users u ON u.id = m.user_id
                 WHERE m.role = 'owner' AND m.workspace_id IN ({chosen})
                 ORDER BY m.created_at, u.username"
            ))
            .bind(&binds)?
            .all()
            .await?
            .results::<OwnerRow>()?;
        Ok(with_owners(rows, owners))
    }

    /// One workspace with every member, or None. Staff only: see the
    /// module's note.
    pub async fn admin_workspace(&self, a: SlugArgs) -> Result<Option<AdminWorkspaceDetail>> {
        let Some(row) = self
            .db
            .prepare("SELECT id, slug, name, description, created_at, protected FROM workspaces WHERE slug = ?")
            .bind(&[a.slug.trim().to_lowercase().into()])?
            .first::<DetailRow>(None)
            .await?
        else {
            return Ok(None);
        };
        let members = self
            .db
            .prepare(
                "SELECT u.username, u.email, m.role, m.created_at AS joined FROM workspace_members m
                 JOIN users u ON u.id = m.user_id
                 WHERE m.workspace_id = ?
                 ORDER BY m.role DESC, u.username",
            )
            .bind(&[row.id.as_str().into()])?
            .all()
            .await?
            .results::<MemberRow>()?
            .into_iter()
            .map(|m| AdminMember {
                username: m.username,
                email: m.email,
                role: m.role,
                joined: m.joined,
            })
            .collect();
        let protected = self.is_protected(&row.id, &row.slug, row.protected != 0).await?;
        Ok(Some(AdminWorkspaceDetail {
            protected,
            slug: row.slug,
            name: row.name,
            description: row.description,
            created_at: row.created_at,
            members,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_query_matches_everything() {
        assert_eq!(like_pattern(None), None);
        assert_eq!(like_pattern(Some("  ")), None);
    }

    #[test]
    fn a_query_is_matched_literally_anywhere() {
        assert_eq!(like_pattern(Some(" Acme ")).as_deref(), Some("%acme%"));
        assert_eq!(like_pattern(Some("50%_off\\")).as_deref(), Some("%50\\%\\_off\\\\%"));
    }

    #[test]
    fn owners_go_to_their_workspaces_in_order() {
        let row = |id: &str, slug: &str| ListRow {
            id: id.into(),
            slug: slug.into(),
            name: slug.into(),
            created_at: "2026-10-04T00:00:00Z".into(),
            member_count: 2,
        };
        let owner = |workspace_id: &str, username: &str| OwnerRow {
            workspace_id: workspace_id.into(),
            username: username.into(),
            email: Some(format!("{username}@example.com")),
        };
        let listed = with_owners(
            vec![row("wsp_2", "newer"), row("wsp_1", "older"), row("wsp_3", "orphan")],
            vec![owner("wsp_1", "ada"), owner("wsp_2", "bob"), owner("wsp_1", "cy")],
        );
        let slugs: Vec<_> = listed.iter().map(|w| w.slug.as_str()).collect();
        assert_eq!(slugs, ["newer", "older", "orphan"]);
        let owners = |i: usize| listed[i].owners.iter().map(|o| o.username.as_str()).collect::<Vec<_>>();
        assert_eq!(owners(0), ["bob"]);
        assert_eq!(owners(1), ["ada", "cy"]);
        assert!(owners(2).is_empty());
        assert_eq!(listed[1].owners[0].email.as_deref(), Some("ada@example.com"));
    }
}
