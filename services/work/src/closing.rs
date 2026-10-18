//! The work items a pull request closes and is part of, as its title and
//! description say: read through items/ (`items::named`, refs.rs), and
//! landed when it merges (`items::land`, landing.rs).

use g1t_contracts::repos::Repo;
use g1t_contracts::User;
use g1t_contracts::work::*;
use worker::Result;

use crate::Work;
use crate::items::{self, NamedItems};
use crate::rows::ValueRow;

impl Work {
    /// The work items a pull request closes and is part of as its title and
    /// description say now: none closed where it does not merge into the
    /// default branch, where the repository does not close work items that
    /// way, or where it is kept open (`keep_open`), when its own work item
    /// is only something it is part of. Only what each of `who` (who merges
    /// it, and whoever it is for) may close, or see, counts.
    pub(crate) async fn items_to_close(
        &self,
        pull: &Pull,
        repo: &Repo,
        settings: &RepoSettings,
        keep_open: bool,
        who: &[&User],
    ) -> Result<NamedItems> {
        let own = self.pull_item_id(&pull.id).await?;
        let text = format!("{}\n{}", pull.title, pull.body.as_deref().unwrap_or_default());
        let mut named = items::named(self, repo, own.as_deref(), &text, who).await?;
        if keep_open || !settings.auto_close_items || !pull.targets_default(&repo.default_branch) {
            let closed = std::mem::take(&mut named.closes);
            let mut parts = if keep_open { closed } else { Vec::new() };
            parts.extend(named.parts);
            named.parts = parts;
        }
        Ok(named)
    }

    /// Whoever a pull request is for, as identity knows them: its author,
    /// or the person g1t's agent opened it for. None when not known.
    pub(crate) async fn pull_owner(&self, pull: &Pull) -> Result<Option<User>> {
        let id = pull.owner().id.clone();
        g1t_kit::call(&self.identity, "user_by_id", &g1t_contracts::identity::UserIdArgs { id }).await
    }

    /// The id of a pull request's own work item, if it has one.
    pub(crate) async fn pull_item_id(&self, pull_id: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .prepare("SELECT item_id AS value FROM pulls WHERE id = ? AND item_id IS NOT NULL")
            .bind(&[pull_id.into()])?
            .first::<ValueRow>(None)
            .await?
            .map(|row| row.value))
    }
}
