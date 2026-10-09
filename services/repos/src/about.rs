//! A repository's About: the answers its Files page shows beside the files
//! (`about`), each part on its own for the API (`languages`,
//! `contributors`, `license`), stars (`star`, `stars`, `stargazers`,
//! `starred`) and releases (`releases`, `release`, `create_release`,
//! `update_release`, `delete_release`). See `g1t_contracts::about`.
//!
//! What comes from files and history is read from `repo_stats` only
//! (stats.rs); each answer that finds it behind the default branch's head
//! says which repository to work out again, and `lib.rs` does so after the
//! answer has gone (`refresh`).

use std::collections::HashMap;

use g1t_contracts::about::*;
use g1t_contracts::accounts::EmailOwner;
use g1t_contracts::events::{NewEvent, ReleaseEvent, ReleaseState, release_actions, release_kind};
use g1t_contracts::identity::{UsernameArgs, UsernamesArgs};
use g1t_contracts::repos::{Repo, is_valid_branch_name};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::now_ms;
use g1t_scan::pack::write_pack;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, Env, Result};

use crate::registry::{can_write, store_key};
use crate::store::{GitRepo, GitStore, Scope};
use crate::{Repos, UNVERIFIED, land, not_found, stats};

/// What an answer from `repo_stats` leaves to do: the repository to work
/// out again, when what is kept is behind its head.
pub(crate) type Refresh = Option<Repo>;

/// Releases a list holds at most.
const MAX_RELEASES: u32 = 100;
/// Stargazers a page holds.
const STARGAZERS_PAGE: u32 = 100;

#[derive(Debug, Deserialize)]
struct ReleaseRow {
    id: String,
    tag_name: String,
    target: String,
    name: Option<String>,
    body: String,
    draft: f64,
    prerelease: f64,
    author: Option<String>,
    created_at: String,
    published_at: Option<String>,
}

impl From<ReleaseRow> for Release {
    fn from(row: ReleaseRow) -> Self {
        Release {
            id: row.id,
            tag_name: row.tag_name,
            target: row.target,
            name: row.name,
            body: row.body,
            draft: row.draft != 0.0,
            prerelease: row.prerelease != 0.0,
            author: row.author,
            created_at: row.created_at,
            published_at: row.published_at,
            latest: false,
        }
    }
}

const RELEASE_COLUMNS: &str = "id, tag_name, target, name, body, draft, prerelease, author, created_at, published_at";

/// The latest release's id: the newest published one that is neither a
/// draft nor a prerelease.
async fn latest_id(db: &D1Database, repo_id: &str) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct Row {
        id: String,
    }
    Ok(db
        .prepare(
            "SELECT id FROM releases WHERE repo_id = ? AND draft = 0 AND prerelease = 0 AND published_at IS NOT NULL
             ORDER BY published_at DESC, created_at DESC LIMIT 1",
        )
        .bind(&[repo_id.into()])?
        .first::<Row>(None)
        .await?
        .map(|row| row.id))
}

fn marked(mut release: Release, latest: Option<&str>) -> Release {
    release.latest = latest == Some(release.id.as_str());
    release
}

/// A release's title: trimmed, empty as none.
fn title(name: Option<&str>) -> Option<String> {
    name.map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned)
}

fn check_release_text(name: Option<&str>, body: Option<&str>) -> std::result::Result<(), String> {
    if name.is_some_and(|name| name.chars().count() > MAX_RELEASE_NAME_CHARS) {
        return Err(format!("A release's title is at most {MAX_RELEASE_NAME_CHARS} characters."));
    }
    if body.is_some_and(|body| body.chars().count() > MAX_RELEASE_BODY_CHARS) {
        return Err(format!("A release's notes are at most {MAX_RELEASE_BODY_CHARS} characters."));
    }
    Ok(())
}

impl<S: GitStore> Repos<S> {
    fn db(&self) -> &D1Database {
        &self.registry.db
    }

    /// The default branch's head, or None for an empty repository.
    async fn head_of(&self, repo: &Repo) -> Result<Option<String>> {
        let git = self.read_git(repo).await?;
        Ok(git.log(&repo.default_branch, 1).await?.into_iter().next().map(|commit| commit.hash))
    }

    /// What is kept, the head now, and whether to work it out again.
    async fn kept_for(&self, repo: &Repo) -> Result<(stats::Kept, Option<String>, Refresh)> {
        let (kept, head) = futures_util::future::try_join(stats::kept(self.db(), &repo.id), self.head_of(repo)).await?;
        let refresh = (stats::has_about(repo) && kept.wants_run(head.as_deref(), now_ms())).then(|| repo.clone());
        Ok((kept, head, refresh))
    }

    /// How many starred it, and whether the viewer did.
    async fn star_count(&self, repo_id: &str, viewer: &Viewer) -> Result<Stars> {
        #[derive(Deserialize)]
        struct Row {
            stars: f64,
            starred: f64,
        }
        let user = viewer.as_ref().map(|user| user.id.as_str()).unwrap_or("");
        let row = self
            .db()
            .prepare(
                "SELECT (SELECT COUNT(*) FROM repo_stars WHERE repo_id = ?1) AS stars,
                        EXISTS (SELECT 1 FROM repo_stars WHERE repo_id = ?1 AND user_id = ?2) AS starred",
            )
            .bind(&[repo_id.into(), user.into()])?
            .first::<Row>(None)
            .await?;
        Ok(row.map_or_else(Stars::default, |row| Stars { stars: row.stars as u64, starred: row.starred != 0.0 }))
    }

    /// The releases the viewer may see, newest first: drafts only for those
    /// who can push.
    async fn visible_releases(&self, repo: &Repo, viewer: &Viewer, limit: u32) -> Result<Vec<Release>> {
        let drafts = can_write(repo, viewer);
        let sql = format!(
            "SELECT {RELEASE_COLUMNS} FROM releases WHERE repo_id = ?1 {} ORDER BY COALESCE(published_at, created_at) DESC, created_at DESC LIMIT ?2",
            if drafts { "" } else { "AND draft = 0" }
        );
        let rows = self
            .db()
            .prepare(sql)
            .bind(&[repo.id.as_str().into(), JsValue::from_f64(f64::from(limit))])?
            .all()
            .await?
            .results::<ReleaseRow>()?;
        let latest = latest_id(self.db(), &repo.id).await?;
        Ok(rows.into_iter().map(|row| marked(row.into(), latest.as_deref())).collect())
    }

    /// `about`: everything the Files page's About shows, in one answer.
    pub(crate) async fn about(&self, a: RepoViewArgs) -> Result<(Outcome<RepoAbout>, Refresh)> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok((not_found(), None));
        };
        let releases_count = async {
            #[derive(Deserialize)]
            struct Row {
                count: f64,
            }
            let sql = if can_write(&repo, &a.viewer) {
                "SELECT COUNT(*) AS count FROM releases WHERE repo_id = ?"
            } else {
                "SELECT COUNT(*) AS count FROM releases WHERE repo_id = ? AND draft = 0"
            };
            Ok::<_, worker::Error>(self.db().prepare(sql).bind(&[repo.id.as_str().into()])?.first::<Row>(None).await?.map_or(0, |row| row.count as u64))
        };
        let latest = async {
            let Some(id) = latest_id(self.db(), &repo.id).await? else { return Ok::<_, worker::Error>(None) };
            let row = self
                .db()
                .prepare(format!("SELECT {RELEASE_COLUMNS} FROM releases WHERE id = ?"))
                .bind(&[id.as_str().into()])?
                .first::<ReleaseRow>(None)
                .await?;
            Ok(row.map(|row| Release { latest: true, ..row.into() }))
        };
        let ((kept, head, refresh), stars, releases, latest_release) =
            futures_util::future::try_join4(self.kept_for(&repo), self.star_count(&repo.id, &a.viewer), releases_count, latest).await?;
        Ok((
            Outcome::Ok(RepoAbout {
                freshness: kept.freshness(head),
                license: kept.license(),
                security_policy: kept.security_policy.clone(),
                languages: kept.languages(),
                contributors: kept.contributors_total as u32,
                top_contributors: kept.top_contributors(),
                stars: stars.stars,
                starred: stars.starred,
                releases,
                latest_release,
            }),
            refresh,
        ))
    }

    /// `languages`.
    pub(crate) async fn languages(&self, a: RepoViewArgs) -> Result<(Outcome<Languages>, Refresh)> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok((not_found(), None));
        };
        let (kept, head, refresh) = self.kept_for(&repo).await?;
        Ok((Outcome::Ok(stats::languages_of(&kept, head)), refresh))
    }

    /// `license`.
    pub(crate) async fn license(&self, a: RepoViewArgs) -> Result<(Outcome<Option<License>>, Refresh)> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok((not_found(), None));
        };
        let (kept, _, refresh) = self.kept_for(&repo).await?;
        Ok((Outcome::Ok(kept.license()), refresh))
    }

    /// `contributors`.
    pub(crate) async fn contributors(&self, a: RepoViewArgs) -> Result<(Outcome<Contributors>, Refresh)> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok((not_found(), None));
        };
        let (kept, head, refresh) = self.kept_for(&repo).await?;
        let mut answer = stats::contributors(self.db(), &repo.id, head.clone()).await?;
        answer.freshness = kept.freshness(head);
        Ok((Outcome::Ok(answer), refresh))
    }

    /// Works out `repo`'s About again, if no one else is. In the
    /// background: a failure is logged and the lease let go early.
    pub(crate) async fn refresh(&self, repo: &Repo) {
        let db = self.db();
        match stats::claim(db, &repo.id, now_ms()).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                worker::console_error!("the About of {} was not worked out: {error}", repo.id);
                return;
            }
        }
        let worked = async {
            let git = self.store.open(&store_key(repo)).await?;
            let Some(head) = git.log(&repo.default_branch, 1).await?.into_iter().next() else {
                return Ok(None);
            };
            stats::work_out(&git, &head.hash, &head.tree_hash, self.identity.as_ref()).await.map(Some)
        };
        match worked.await {
            Ok(Some(worked)) => {
                if let Err(error) = stats::keep(db, &repo.id, &worked).await {
                    worker::console_error!("the About of {} was worked out but not kept: {error}", repo.id);
                    stats::release(db, &repo.id).await;
                }
            }
            Ok(None) => stats::release(db, &repo.id).await,
            Err(error) => {
                worker::console_error!("the About of {} was not worked out: {error}", repo.id);
                stats::release(db, &repo.id).await;
            }
        }
    }

    /// `stars`.
    pub(crate) async fn stars(&self, a: RepoViewArgs) -> Result<Outcome<Stars>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        Ok(Outcome::Ok(self.star_count(&repo.id, &a.viewer).await?))
    }

    /// `star`: anyone signed in who can read the repository stars it.
    pub(crate) async fn star(&self, a: StarArgs) -> Result<Outcome<Stars>> {
        let viewer = Some(a.actor.clone());
        let Some(repo) = self.readable(&a.path, &viewer).await? else {
            return Ok(not_found());
        };
        if repo.fork_of.is_some() {
            return Ok(not_found());
        }
        if a.actor.kind != g1t_contracts::PrincipalKind::User {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only people star repositories."));
        }
        if a.starred {
            self.db()
                .prepare("INSERT OR IGNORE INTO repo_stars (repo_id, user_id, created_at) VALUES (?, ?, ?)")
                .bind(&[repo.id.as_str().into(), a.actor.id.as_str().into(), rfc3339(now_ms()).into()])?
                .run()
                .await?;
        } else {
            self.db()
                .prepare("DELETE FROM repo_stars WHERE repo_id = ? AND user_id = ?")
                .bind(&[repo.id.as_str().into(), a.actor.id.as_str().into()])?
                .run()
                .await?;
        }
        Ok(Outcome::Ok(self.star_count(&repo.id, &viewer).await?))
    }

    /// The accounts behind user ids, by id.
    async fn accounts(&self, ids: Vec<String>) -> HashMap<String, EmailOwner> {
        let Some(identity) = &self.identity else { return HashMap::new() };
        if ids.is_empty() {
            return HashMap::new();
        }
        g1t_kit::call(identity, "accounts", &UsernamesArgs { ids }).await.unwrap_or_else(|error| {
            worker::console_error!("stargazers' accounts not read: {error}");
            HashMap::new()
        })
    }

    /// `stargazers`.
    pub(crate) async fn stargazers(&self, a: StargazersArgs) -> Result<Outcome<Vec<Stargazer>>> {
        #[derive(Deserialize)]
        struct Row {
            user_id: String,
            created_at: String,
        }
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let page = a.page.unwrap_or(1).max(1);
        let rows = self
            .db()
            .prepare("SELECT user_id, created_at FROM repo_stars WHERE repo_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
            .bind(&[
                repo.id.as_str().into(),
                JsValue::from_f64(f64::from(STARGAZERS_PAGE)),
                JsValue::from_f64(f64::from((page - 1) * STARGAZERS_PAGE)),
            ])?
            .all()
            .await?
            .results::<Row>()?;
        let accounts = self.accounts(rows.iter().map(|row| row.user_id.clone()).collect()).await;
        Ok(Outcome::Ok(
            rows.into_iter()
                .filter_map(|row| {
                    let account = accounts.get(&row.user_id)?;
                    Some(Stargazer { username: account.username.clone(), avatar: account.avatar.clone(), starred_at: row.created_at })
                })
                .collect(),
        ))
    }

    /// `starred`: by username, what the viewer may see of it.
    pub(crate) async fn starred(&self, a: StarredArgs) -> Result<Vec<StarredRepo>> {
        #[derive(Deserialize)]
        struct Row {
            repo_id: String,
            created_at: String,
            stars: f64,
        }
        let Some(identity) = &self.identity else { return Ok(Vec::new()) };
        let person: Viewer = g1t_kit::call(identity, "user_by_username", &UsernameArgs { username: a.username.clone() }).await?;
        let Some(person) = person else { return Ok(Vec::new()) };
        let rows = self
            .db()
            .prepare(
                "SELECT s.repo_id, s.created_at, (SELECT COUNT(*) FROM repo_stars t WHERE t.repo_id = s.repo_id) AS stars
                 FROM repo_stars s WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 100",
            )
            .bind(&[person.id.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        let ids: Vec<String> = rows.iter().map(|row| row.repo_id.clone()).collect();
        let readable: HashMap<String, Repo> = self.registry.readable(&ids, &a.viewer).await?.into_iter().map(|repo| (repo.id.clone(), repo)).collect();
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let repo = readable.get(&row.repo_id)?.clone();
                Some(StarredRepo { repo, starred_at: row.created_at, stars: row.stars as u64 })
            })
            .collect())
    }

    /// `releases`.
    pub(crate) async fn releases(&self, a: RepoViewArgs) -> Result<Outcome<Vec<Release>>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        Ok(Outcome::Ok(self.visible_releases(&repo, &a.viewer, MAX_RELEASES).await?))
    }

    /// One release row of a repository, by id or tag.
    async fn release_row(&self, repo_id: &str, id: Option<&str>, tag: Option<&str>) -> Result<Option<Release>> {
        let (column, value) = match (id, tag) {
            (Some(id), _) => ("id", id),
            (None, Some(tag)) => ("tag_name", tag),
            (None, None) => return Ok(None),
        };
        Ok(self
            .db()
            .prepare(format!("SELECT {RELEASE_COLUMNS} FROM releases WHERE repo_id = ? AND {column} = ?"))
            .bind(&[repo_id.into(), value.into()])?
            .first::<ReleaseRow>(None)
            .await?
            .map(Release::from))
    }

    /// `release`.
    pub(crate) async fn release(&self, a: ReleaseArgs) -> Result<Outcome<Release>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let latest = latest_id(self.db(), &repo.id).await?;
        let id = if a.latest { latest.clone() } else { a.id.clone() };
        let found = self.release_row(&repo.id, id.as_deref(), if a.latest { None } else { a.tag.as_deref() }).await?;
        Ok(match found {
            Some(release) if !release.draft || can_write(&repo, &a.viewer) => Outcome::Ok(marked(release, latest.as_deref())),
            _ => Outcome::fail(FailureCode::NotFound, "No such release."),
        })
    }

    /// The repository, if the actor may make and change its releases.
    async fn writable_for_releases(&self, path: &g1t_contracts::repos::RepoPath, actor: &User) -> Result<std::result::Result<Repo, Outcome<()>>> {
        let viewer = Some(actor.clone());
        let Some(repo) = self.readable(path, &viewer).await? else {
            return Ok(Err(not_found()));
        };
        if !can_write(&repo, &viewer) {
            return Ok(Err(Outcome::fail(
                FailureCode::Forbidden,
                g1t_contracts::access::needs(g1t_contracts::access::Capability::Push, &format!("{}/{}", repo.namespace, repo.name)),
            )));
        }
        if !actor.verified {
            return Ok(Err(Outcome::fail(FailureCode::Forbidden, UNVERIFIED)));
        }
        if let Some((code, message)) = crate::lifecycle::read_only_refusal(&repo) {
            return Ok(Err(Outcome::fail(code, message)));
        }
        Ok(Ok(repo))
    }

    /// `create_release`.
    pub(crate) async fn create_release(&self, a: CreateReleaseArgs) -> Result<Outcome<Release>> {
        let repo = match self.writable_for_releases(&a.path, &a.actor).await? {
            Ok(repo) => repo,
            Err(refused) => return Ok(refused.retype()),
        };
        let tag = a.tag_name.trim().trim_start_matches("refs/tags/").to_owned();
        if !is_valid_branch_name(&tag) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("{tag:?} cannot be a tag's name.")));
        }
        if let Err(message) = check_release_text(a.name.as_deref(), a.body.as_deref()) {
            return Ok(Outcome::fail(FailureCode::Invalid, message));
        }
        if self.release_row(&repo.id, None, Some(&tag)).await?.is_some() {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{tag} already has a release: change that one instead.")));
        }
        let git = self.store.open(&store_key(&repo)).await?;
        let access = git.access(Scope::Read).await?;
        let refs = crate::refs::heads_and_tags(crate::refs::all(&access).await?);
        let existing = refs.iter().find(|(name, _)| *name == format!("refs/tags/{tag}")).map(|(_, hash)| hash.clone());
        let target = match existing {
            Some(hash) => match git.log(&hash, 1).await?.into_iter().next() {
                Some(commit) => commit.hash,
                None => hash,
            },
            None => {
                // A new tag, made at the target.
                let from = a.target.as_deref().map(str::trim).filter(|target| !target.is_empty()).unwrap_or(&repo.default_branch);
                let Some(commit) = git.log(from, 1).await?.into_iter().next() else {
                    return Ok(Outcome::fail(FailureCode::NotFound, format!("{from} is not a branch or commit of this repository.")));
                };
                let git_ref = format!("refs/tags/{tag}");
                let change = g1t_rules::push::RefChange {
                    git_ref: git_ref.clone(),
                    old: None,
                    new: Some(commit.hash.clone()),
                    fast_forward: None,
                    commits: Vec::new(),
                    complete: true,
                };
                if let crate::rules::Ruled::Refused { message } =
                    self.check_changes(&repo, &a.actor, g1t_contracts::rules::Action::CreateRef, vec![change]).await?
                {
                    return Ok(Outcome::fail(FailureCode::Forbidden, message));
                }
                let write = git.access(Scope::Write).await?;
                // The commit is there already: the pack is empty.
                if let Err(reason) = land::push_ref(&write, &git_ref, None, &commit.hash, Some(write_pack(&[]))).await? {
                    return Ok(Outcome::fail(FailureCode::Conflict, format!("The tag {tag} could not be made: {reason}")));
                }
                self.refs_moved(&repo.id).await;
                self.publish_push(&repo, &git_ref, None, &commit.hash, Some(&a.actor)).await?;
                commit.hash
            }
        };
        let now = rfc3339(now_ms());
        let id = new_id("rel", now_ms());
        let published: JsValue = if a.draft { JsValue::NULL } else { now.as_str().into() };
        self.db()
            .prepare(
                "INSERT INTO releases (id, repo_id, tag_name, target, name, body, draft, prerelease, author_id, author, created_at, published_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?11)",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                tag.as_str().into(),
                target.as_str().into(),
                title(a.name.as_deref()).map_or(JsValue::NULL, |name| name.into()),
                a.body.unwrap_or_default().into(),
                JsValue::from_f64(if a.draft { 1.0 } else { 0.0 }),
                JsValue::from_f64(if a.prerelease { 1.0 } else { 0.0 }),
                a.actor.id.as_str().into(),
                a.actor.username.as_str().into(),
                now.as_str().into(),
                published,
            ])?
            .run()
            .await?;
        let made = self.release(ReleaseArgs { path: a.path, viewer: Some(a.actor.clone()), id: Some(id), tag: None, latest: false }).await?;
        if let Outcome::Ok(release) = &made {
            self.publish_release(&repo, &a.actor, None, Some(release)).await;
        }
        Ok(made)
    }

    /// `update_release`.
    pub(crate) async fn update_release(&self, a: UpdateReleaseArgs) -> Result<Outcome<Release>> {
        let repo = match self.writable_for_releases(&a.path, &a.actor).await? {
            Ok(repo) => repo,
            Err(refused) => return Ok(refused.retype()),
        };
        let Some(release) = self.release_row(&repo.id, Some(&a.id), None).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such release."));
        };
        if let Err(message) = check_release_text(a.name.as_deref(), a.body.as_deref()) {
            return Ok(Outcome::fail(FailureCode::Invalid, message));
        }
        let now = rfc3339(now_ms());
        let name = match &a.name {
            Some(name) => title(Some(name)),
            None => release.name.clone(),
        };
        let draft = a.draft.unwrap_or(release.draft);
        // Published the first time it stops being a draft; a release made a
        // draft again keeps no date.
        let published_at = if draft { None } else { release.published_at.clone().or(Some(now.clone())) };
        self.db()
            .prepare("UPDATE releases SET name = ?2, body = ?3, draft = ?4, prerelease = ?5, published_at = ?6, updated_at = ?7 WHERE id = ?1")
            .bind(&[
                release.id.as_str().into(),
                name.map_or(JsValue::NULL, |name| name.into()),
                a.body.unwrap_or_else(|| release.body.clone()).into(),
                JsValue::from_f64(if draft { 1.0 } else { 0.0 }),
                JsValue::from_f64(if a.prerelease.unwrap_or(release.prerelease) { 1.0 } else { 0.0 }),
                published_at.map_or(JsValue::NULL, |at| at.into()),
                now.into(),
            ])?
            .run()
            .await?;
        let changed = self.release(ReleaseArgs { path: a.path, viewer: Some(a.actor.clone()), id: Some(release.id.clone()), tag: None, latest: false }).await?;
        if let Outcome::Ok(after) = &changed {
            self.publish_release(&repo, &a.actor, Some(&release), Some(after)).await;
        }
        Ok(changed)
    }

    /// `delete_release`: the tag stays.
    pub(crate) async fn delete_release(&self, a: DeleteReleaseArgs) -> Result<Outcome<bool>> {
        let repo = match self.writable_for_releases(&a.path, &a.actor).await? {
            Ok(repo) => repo,
            Err(refused) => return Ok(refused.retype()),
        };
        let before = self.release_row(&repo.id, Some(&a.id), None).await?;
        let deleted = self
            .db()
            .prepare("DELETE FROM releases WHERE repo_id = ? AND id = ? RETURNING id")
            .bind(&[repo.id.as_str().into(), a.id.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        Ok(match deleted {
            Some(_) => {
                if let Some(before) = &before {
                    self.publish_release(&repo, &a.actor, Some(before), None).await;
                }
                Outcome::Ok(true)
            }
            None => Outcome::fail(FailureCode::NotFound, "No such release."),
        })
    }

    /// Publishes a release's change as the release activities it amounts
    /// to (`release_actions`), one `release.*` event each, for workflows
    /// and webhooks. What a workflow job's token did is marked as its, so it
    /// starts no workflows. A failure is logged: the change itself happened.
    async fn publish_release(&self, repo: &Repo, actor: &User, before: Option<&Release>, after: Option<&Release>) {
        let state = |release: &Release| ReleaseState { draft: release.draft, prerelease: release.prerelease };
        let Some(release) = after.or(before) else { return };
        let changes = match (before, after) {
            (Some(before), Some(after)) => {
                let mut changes = serde_json::Map::new();
                if before.name != after.name {
                    changes.insert("name".into(), serde_json::json!({ "from": before.name }));
                }
                if before.body != after.body {
                    changes.insert("body".into(), serde_json::json!({ "from": before.body }));
                }
                (!changes.is_empty()).then_some(serde_json::Value::Object(changes))
            }
            _ => None,
        };
        for action in release_actions(before.map(state), after.map(state)) {
            let Some(kind) = release_kind(action) else { continue };
            let data = ReleaseEvent {
                release_id: release.id.clone(),
                repo_id: repo.id.clone(),
                tag_name: release.tag_name.clone(),
                release: release.clone(),
                changes: if action == "edited" { changes.clone() } else { None },
            };
            let published = self
                .publish(NewEvent {
                    kind,
                    source: crate::SOURCE,
                    repo_id: Some(repo.id.clone()),
                    actor: Some(actor.id.clone()),
                    data: g1t_contracts::events::marked(data, Some(actor)),
                })
                .await;
            if let Err(error) = published {
                worker::console_error!("{kind} for {} not published: {error}", release.id);
            }
        }
    }
}

/// A refusal of one type, as another: it carries no value.
trait Retype {
    fn retype<T>(self) -> Outcome<T>;
}

impl Retype for Outcome<()> {
    fn retype<T>(self) -> Outcome<T> {
        match self {
            Outcome::Fail(failure) => Outcome::Fail(failure),
            Outcome::Ok(()) => Outcome::fail(FailureCode::Invalid, "Nothing to do."),
        }
    }
}

/// Works out `repo`'s About after the answer has gone, when an answer
/// found it behind.
pub(crate) fn refresh_later(env: &Env, ctx: &worker::Context, refresh: Refresh) {
    let Some(repo) = refresh else { return };
    let env = env.clone();
    ctx.wait_until(async move {
        match crate::service(&env) {
            Ok(repos) => repos.refresh(&repo).await,
            Err(error) => worker::console_error!("the About of {} was not worked out: {error}", repo.id),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_titles_are_tidied_and_text_is_bounded() {
        assert_eq!(title(Some("  v1.0  ")).as_deref(), Some("v1.0"));
        assert_eq!(title(Some("   ")), None);
        assert_eq!(title(None), None);
        assert!(check_release_text(Some("ok"), Some("notes")).is_ok());
        assert!(check_release_text(Some(&"x".repeat(MAX_RELEASE_NAME_CHARS + 1)), None).is_err());
        assert!(check_release_text(None, Some(&"x".repeat(MAX_RELEASE_BODY_CHARS + 1))).is_err());
    }

    #[test]
    fn only_the_latest_is_marked() {
        let release = Release {
            id: "rel_1".into(),
            tag_name: "v1".into(),
            target: "c".into(),
            name: None,
            body: String::new(),
            draft: false,
            prerelease: false,
            author: None,
            created_at: String::new(),
            published_at: None,
            latest: false,
        };
        assert!(marked(release.clone(), Some("rel_1")).latest);
        assert!(!marked(release, Some("rel_2")).latest);
    }
}
