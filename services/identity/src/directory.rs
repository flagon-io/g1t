//! What other services may know of every account and workspace: the
//! directory search indexes, and the events that keep it current.
//!
//! Only what public pages already show goes out: a username or slug, a
//! name, a bio or description, an avatar. Never an email address, and
//! never who belongs to which workspace.

use g1t_contracts::events::{NewEvent, Publish, UserUpdated, WorkspaceUpdated};
use g1t_contracts::identity::{DirectoryArgs, DirectoryEntry, DirectoryPage};
use serde::{Deserialize, Serialize};
use worker::Result;

use crate::Identity;

const SOURCE: &str = "identity";
/// The most entries on one page of the directory.
const MAX_PAGE: u32 = 200;

#[derive(Deserialize)]
struct Row {
    id: String,
    slug: String,
    name: Option<String>,
    bio: Option<String>,
    avatar: Option<String>,
    created_at: String,
}

impl Identity {
    pub async fn directory(&self, a: DirectoryArgs) -> Result<DirectoryPage> {
        let limit = a.limit.clamp(1, MAX_PAGE);
        let sql = match a.kind.as_str() {
            "user" => {
                "SELECT id, username AS slug, display_name AS name, bio, avatar, created_at
                 FROM users WHERE username > ? ORDER BY username LIMIT ?"
            }
            "workspace" => {
                "SELECT id, slug, name, description AS bio, avatar, created_at
                 FROM workspaces WHERE slug > ? ORDER BY slug LIMIT ?"
            }
            _ => return Ok(DirectoryPage::default()),
        };
        let rows = self
            .db
            .prepare(sql)
            .bind(&[a.after.unwrap_or_default().into(), limit.into()])?
            .all()
            .await?
            .results::<Row>()?;
        let next = (rows.len() == limit as usize).then(|| rows.last().map(|row| row.slug.clone())).flatten();
        Ok(DirectoryPage {
            entries: rows
                .into_iter()
                .map(|row| DirectoryEntry {
                    id: row.id,
                    slug: row.slug,
                    name: row.name,
                    bio: row.bio,
                    avatar: row.avatar,
                    created_at: row.created_at,
                })
                .collect(),
            next,
        })
    }

    /// Tells other services that what an account's profile shows changed.
    /// Best effort: the change has happened, so a failure is logged.
    pub async fn announce_user(&self, username: &str, actor: Option<&str>) {
        self.announce(
            "user.updated",
            actor,
            UserUpdated {
                username: username.to_owned(),
            },
        )
        .await;
    }

    /// Tells other services a workspace was made or changed.
    pub async fn announce_workspace(&self, workspace_id: &str, slug: &str, actor: Option<&str>) {
        self.announce(
            "workspace.updated",
            actor,
            WorkspaceUpdated {
                workspace_id: workspace_id.to_owned(),
                slug: slug.to_owned(),
            },
        )
        .await;
    }

    async fn announce<T: Serialize>(&self, kind: &'static str, actor: Option<&str>, data: T) {
        let events = match self.env.service("EVENTS") {
            Ok(events) => events,
            Err(error) => {
                worker::console_error!("{kind} not published: {error}");
                return;
            }
        };
        let publish = Publish {
            events: vec![NewEvent {
                kind,
                source: SOURCE,
                repo_id: None,
                actor: actor.map(str::to_owned),
                data,
            }],
        };
        if let Err(error) = g1t_kit::call::<_, serde_json::Value>(&events, "publish", &publish).await {
            worker::console_error!("{kind} not published: {error}");
        }
    }
}
