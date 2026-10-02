//! The repos service: repository metadata, contents, forks, landing, and
//! git over HTTPS.
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::repos` for the methods and their arguments. Any other
//! request is treated as git's smart HTTP protocol.

mod git_http;
mod land;
mod registry;
mod store;

use g1t_contracts::events::{GitPush, NewEvent, RepoCreated, RepoForked};
use g1t_contracts::repos::*;
use g1t_contracts::{
    FailureCode, Outcome, User, Viewer, is_valid_namespace, is_valid_repo_name, new_id,
};
use g1t_kit::{args, js, now_ms, reply, rpc_method};
use std::collections::{HashMap, HashSet};

use serde::Serialize;
use worker::wasm_bindgen::JsValue;
use worker::{Context, Env, Request, Response, Result, event};

use registry::{Registry, can_read, can_write, store_key};
use store::{ArtifactsStore, GitRepo, GitStore, Scope};

/// Namespace that holds every attempt's fork: `attempts/<attempt id>`.
const ATTEMPTS_NAMESPACE: &str = "attempts";
const MAX_TEXT_BYTES: usize = 512 * 1024;
/// How far back an attempt may have forked and still be landed.
const MAX_ANCESTRY: u32 = 1000;
const SOURCE: &str = "repos";
const UNVERIFIED: &str = "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.";

fn not_found<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Repository not found.")
}

/// Decoded text, or `None` when the file is too large or looks binary.
fn text_of(bytes: Vec<u8>) -> Option<String> {
    if bytes.len() > MAX_TEXT_BYTES || bytes.contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn is_readme(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "readme" | "readme.md" | "readme.markdown" | "readme.txt"
    )
}

/// Whether `ancestor` is reachable from the newest commit in `history`.
///
/// `history` is the first-parent chain, which is all the store lists; a fork
/// that merged the target branch in has the target's head on a second
/// parent, so the walk follows every parent.
async fn descends_from<R: GitRepo>(repo: &R, history: &[Commit], ancestor: &str) -> Result<bool> {
    let known: HashMap<&str, &[String]> = history
        .iter()
        .map(|commit| (commit.hash.as_str(), commit.parents.as_slice()))
        .collect();
    let mut seen = HashSet::new();
    let mut queue: Vec<String> = history
        .first()
        .map(|c| c.hash.clone())
        .into_iter()
        .collect();
    while let Some(hash) = queue.pop() {
        if hash == ancestor {
            return Ok(true);
        }
        if !seen.insert(hash.clone()) || seen.len() > MAX_ANCESTRY as usize {
            continue;
        }
        match known.get(hash.as_str()) {
            Some(parents) => queue.extend(parents.iter().cloned()),
            None => queue.extend(repo.parents(&hash).await?.unwrap_or_default()),
        }
    }
    Ok(false)
}

struct Repos<S: GitStore> {
    registry: Registry,
    store: S,
    /// The events service, an RPC stub.
    events: JsValue,
}

impl<S: GitStore> Repos<S> {
    async fn publish<T: Serialize>(&self, event: NewEvent<T>) -> Result<()> {
        js::call(&self.events, "publish", &[js::to_js(&[event])?]).await?;
        Ok(())
    }

    /// Resolves a repo the viewer may read; private repos look missing.
    async fn readable(&self, path: &RepoPath, viewer: &Viewer) -> Result<Option<Repo>> {
        Ok(self
            .registry
            .by_path(path)
            .await?
            .filter(|repo| can_read(repo, viewer)))
    }

    async fn get(&self, a: GetArgs) -> Result<Outcome<Repo>> {
        Ok(self
            .readable(&a.path, &a.viewer)
            .await?
            .map_or_else(not_found, Outcome::Ok))
    }

    async fn get_by_id(&self, a: GetByIdArgs) -> Result<Outcome<Repo>> {
        Ok(self
            .registry
            .by_id(&a.id)
            .await?
            .filter(|repo| can_read(repo, &a.viewer))
            .map_or_else(not_found, Outcome::Ok))
    }

    async fn create(&self, a: CreateArgs) -> Result<Outcome<Repo>> {
        if !a.owner.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let name = a.name.trim().to_lowercase();
        if !is_valid_repo_name(&name) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Use letters, digits, dots, hyphens and underscores only.",
            ));
        }
        if !is_valid_namespace(&a.owner.username) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "This account cannot own repositories.",
            ));
        }
        let path = RepoPath {
            namespace: a.owner.username.clone(),
            name,
        };
        if self.registry.by_path(&path).await?.is_some() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "You already have a repository with that name.",
            ));
        }
        let now = now_ms();
        let repo = Repo {
            id: new_id("rep", now),
            namespace: path.namespace,
            name: path.name,
            description: a
                .description
                .map(|text| text.trim().to_owned())
                .filter(|text| !text.is_empty()),
            is_private: a.is_private,
            owner_id: a.owner.id.clone(),
            default_branch: "main".to_owned(),
            fork_of: None,
            created_at: now,
        };
        self.store
            .create(
                &store_key(&repo),
                repo.description.as_deref(),
                &repo.default_branch,
            )
            .await?;
        self.registry.insert(&repo).await?;
        self.publish(NewEvent {
            kind: "repo.created",
            source: SOURCE,
            repo_id: Some(repo.id.clone()),
            actor: Some(a.owner.id),
            data: RepoCreated {
                repo_id: repo.id.clone(),
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
                is_private: repo.is_private,
            },
        })
        .await?;
        Ok(Outcome::Ok(repo))
    }

    async fn tree(&self, a: TreeArgs) -> Result<Outcome<TreeView>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let git = self.store.open(&store_key(&repo)).await?;
        let git_ref = a
            .git_ref
            .clone()
            .unwrap_or_else(|| repo.default_branch.clone());

        let Some(head) = git.log(&git_ref, 1).await?.into_iter().next() else {
            // An unknown ref is an error; a repo with no commits is just empty.
            if a.git_ref.is_some() {
                return Ok(Outcome::fail(
                    FailureCode::NotFound,
                    "No such branch, tag or commit.",
                ));
            }
            return Ok(Outcome::Ok(TreeView {
                repo,
                git_ref,
                path: a.tree_path,
                head: None,
                entries: Vec::new(),
                readme: None,
            }));
        };

        let no_directory = || Outcome::fail(FailureCode::NotFound, "No such directory.");
        let mut entries = git.read_tree(&head.tree_hash).await?;
        for segment in a.tree_path.split('/').filter(|segment| !segment.is_empty()) {
            let next = entries.as_ref().and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry.name == segment && entry.kind == EntryKind::Tree)
            });
            let Some(next) = next else {
                return Ok(no_directory());
            };
            entries = git.read_tree(&next.hash).await?;
        }
        let Some(mut entries) = entries else {
            return Ok(no_directory());
        };
        // Directories first, then by name.
        entries.sort_by(|a, b| {
            (b.kind == EntryKind::Tree)
                .cmp(&(a.kind == EntryKind::Tree))
                .then_with(|| a.name.cmp(&b.name))
        });

        let readme_entry = entries
            .iter()
            .find(|entry| entry.kind == EntryKind::Blob && is_readme(&entry.name));
        let readme = match readme_entry {
            Some(entry) => git.read_blob(&entry.hash).await?.map(|bytes| Readme {
                name: entry.name.clone(),
                text: text_of(bytes),
            }),
            None => None,
        };
        Ok(Outcome::Ok(TreeView {
            repo,
            git_ref,
            path: a.tree_path,
            head: Some(head),
            entries,
            readme,
        }))
    }

    async fn blob(&self, a: BlobArgs) -> Result<Outcome<BlobView>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let bytes = if a.file_path.is_empty() {
            None
        } else {
            let git = self.store.open(&store_key(&repo)).await?;
            git.read_file(&a.git_ref, &a.file_path).await?
        };
        let Some(bytes) = bytes else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such file."));
        };
        Ok(Outcome::Ok(BlobView {
            repo,
            git_ref: a.git_ref,
            path: a.file_path,
            size: bytes.len() as u64,
            text: text_of(bytes),
        }))
    }

    async fn log(&self, a: LogArgs) -> Result<Outcome<Vec<Commit>>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let git = self.store.open(&store_key(&repo)).await?;
        let git_ref = a.git_ref.unwrap_or_else(|| repo.default_branch.clone());
        Ok(Outcome::Ok(git.log(&git_ref, a.limit).await?))
    }

    async fn fork_for_attempt(&self, a: ForkArgs) -> Result<Outcome<Repo>> {
        let viewer = Some(a.actor.clone());
        let Some(source) = self
            .registry
            .by_id(&a.source_id)
            .await?
            .filter(|repo| can_read(repo, &viewer))
        else {
            return Ok(not_found());
        };
        let now = now_ms();
        let fork = Repo {
            id: new_id("rep", now),
            namespace: ATTEMPTS_NAMESPACE.to_owned(),
            name: a.attempt_id.clone(),
            description: None,
            // A fork is exactly as visible as the repo it came from.
            is_private: source.is_private,
            owner_id: a.actor.id.clone(),
            default_branch: source.default_branch.clone(),
            fork_of: Some(source.id.clone()),
            created_at: now,
        };
        self.store
            .open(&store_key(&source))
            .await?
            .fork(&store_key(&fork))
            .await?;
        self.registry.insert(&fork).await?;
        self.publish(NewEvent {
            kind: "repo.forked",
            source: SOURCE,
            repo_id: Some(source.id.clone()),
            actor: Some(a.actor.id),
            data: RepoForked {
                repo_id: fork.id.clone(),
                source_repo_id: source.id,
                attempt_id: a.attempt_id,
            },
        })
        .await?;
        Ok(Outcome::Ok(fork))
    }

    async fn git_access(&self, a: GitAccessArgs) -> Result<Outcome<GitAccess>> {
        let write = a.service == GitService::ReceivePack;
        // Anonymous callers are asked to authenticate whether or not the repo
        // exists, so private repos cannot be told apart from missing ones.
        let denied = || match &a.viewer {
            Some(_) => not_found(),
            None => Outcome::fail(FailureCode::Unauthenticated, "Authentication required."),
        };
        if let (true, Some(user)) = (write, &a.viewer)
            && !user.verified
        {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }

        let repo = match self.registry.by_path(&a.path).await? {
            Some(repo) => {
                let allowed = if write {
                    can_write(&repo, &a.viewer)
                } else {
                    can_read(&repo, &a.viewer)
                };
                if !allowed {
                    return Ok(denied());
                }
                repo
            }
            None => {
                // Push to create, in the pusher's own namespace only.
                let owner = a
                    .viewer
                    .as_ref()
                    .filter(|user| write && user.username == a.path.namespace.to_lowercase());
                let Some(owner) = owner else {
                    return Ok(denied());
                };
                let created = self
                    .create(CreateArgs {
                        owner: owner.clone(),
                        name: a.path.name.clone(),
                        description: None,
                        is_private: false,
                    })
                    .await?;
                match created {
                    Outcome::Ok(repo) => repo,
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                }
            }
        };
        let git = self.store.open(&store_key(&repo)).await?;
        let scope = if write { Scope::Write } else { Scope::Read };
        Ok(Outcome::Ok(git.access(scope).await?))
    }

    async fn land(&self, a: LandArgs) -> Result<Outcome<Landed>> {
        let actor: Viewer = Some(a.actor.clone());
        let Some(fork) = self.registry.by_id(&a.fork_id).await? else {
            return Ok(not_found());
        };
        let target = match &fork.fork_of {
            Some(id) => self.registry.by_id(id).await?,
            None => None,
        };
        let Some(target) = target.filter(|repo| can_read(repo, &actor)) else {
            return Ok(not_found());
        };
        if !can_write(&target, &actor) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only the repository's owner can land an attempt.",
            ));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }

        let branch = &target.default_branch;
        let fork_git = self.store.open(&store_key(&fork)).await?;
        let target_git = self.store.open(&store_key(&target)).await?;
        let history = fork_git.log(branch, MAX_ANCESTRY).await?;
        let Some(new) = history.first().map(|commit| commit.hash.clone()) else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This attempt has no commits to land.",
            ));
        };
        let old = target_git
            .log(branch, 1)
            .await?
            .into_iter()
            .next()
            .map(|commit| commit.hash);

        if old.as_deref() == Some(new.as_str()) {
            return Ok(Outcome::Ok(Landed { commit: new }));
        }
        // Moving the branch to a commit that does not descend from its
        // current head would discard whatever landed in between.
        if let Some(old) = &old
            && !descends_from(&fork_git, &history, old).await?
        {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!(
                    "{branch} has moved since this attempt started. Pull {branch} into the attempt's fork, push, and land again."
                ),
            ));
        }

        let source_access = fork_git.access(Scope::Read).await?;
        let target_access = target_git.access(Scope::Write).await?;
        let pushed =
            land::fast_forward(&source_access, &target_access, branch, old.as_deref(), &new)
                .await?;
        if let Err(reason) = pushed {
            // Most often another attempt landed between the check and the push.
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{branch} could not be updated: {reason}"),
            ));
        }
        self.publish_push(&target, &new, Some(a.actor.id)).await?;
        Ok(Outcome::Ok(Landed { commit: new }))
    }

    async fn publish_push(&self, repo: &Repo, after: &str, actor: Option<String>) -> Result<()> {
        self.publish(NewEvent {
            kind: "git.push",
            source: SOURCE,
            repo_id: Some(repo.id.clone()),
            actor,
            data: GitPush {
                repo_id: repo.id.clone(),
                git_ref: format!("refs/heads/{}", repo.default_branch),
                after: after.to_owned(),
            },
        })
        .await
    }

    /// Git over HTTPS.
    async fn git_http(&self, request: Request, env: &Env) -> Result<Response> {
        let Some(git) = git_http::parse(&request.url()?) else {
            return Response::error("Not found", 404);
        };
        let viewer = git_http::viewer(&request, &env.service("IDENTITY")?).await?;
        let access = self
            .git_access(GitAccessArgs {
                path: git.path.clone(),
                viewer: viewer.clone(),
                service: git.service,
            })
            .await?;
        let access = match access {
            Outcome::Ok(access) => access,
            refused => return git_http::refuse(refused),
        };
        let response = git_http::forward(request, &git, &access).await?;

        // Artifacts' own push notifications are per repository, which does
        // not fit a repo per attempt, so the front end reports pushes itself.
        let pushed = git.endpoint == "git-receive-pack" && response.status_code() == 200;
        if pushed && let Some(repo) = self.registry.by_path(&git.path).await? {
            let head = self
                .store
                .open(&store_key(&repo))
                .await?
                .log(&repo.default_branch, 1)
                .await?;
            if let Some(head) = head.first() {
                self.publish_push(&repo, &head.hash, viewer.map(|user: User| user.id))
                    .await?;
            }
        }
        Ok(response)
    }
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let repos = Repos {
        registry: Registry { db: env.d1("DB")? },
        store: ArtifactsStore::new(&env)?,
        events: js::binding(&env, "EVENTS")?,
    };
    let Some(method) = rpc_method(&request) else {
        return repos.git_http(request, &env).await;
    };
    let body: serde_json::Value = request.json().await?;

    match method.as_str() {
        "get" => reply(&repos.get(args(body)?).await?),
        "get_by_id" => reply(&repos.get_by_id(args(body)?).await?),
        "list" => {
            let a: ListArgs = args(body)?;
            reply(
                &repos
                    .registry
                    .list(&a.viewer, a.query.as_deref(), a.namespace.as_deref())
                    .await?,
            )
        }
        "create" => reply(&repos.create(args(body)?).await?),
        "tree" => reply(&repos.tree(args(body)?).await?),
        "blob" => reply(&repos.blob(args(body)?).await?),
        "log" => reply(&repos.log(args(body)?).await?),
        "fork_for_attempt" => reply(&repos.fork_for_attempt(args(body)?).await?),
        "git_access" => reply(&repos.git_access(args(body)?).await?),
        "land" => reply(&repos.land(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}
