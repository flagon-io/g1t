//! Who may see what. Checked twice, both times when the query runs:
//!
//! 1. In the query itself, against the viewer's access as it is now: a
//!    row is read if its repository is public, as the index last heard,
//!    in a workspace whose private repositories the viewer reads (an
//!    owner, or a member whose base permission gives a role), or one they
//!    were given a role on directly.
//! 2. On the page about to be returned, against the repos service, which
//!    owns visibility: anything it does not say the viewer may read now is
//!    dropped, and the index is corrected. A repository made private a
//!    moment ago, before its event arrived, is never shown to anyone who
//!    cannot read it.
//!
//! Pure, so the rules are tested apart from the index.

use std::collections::{HashMap, HashSet};

use g1t_contracts::Viewer;
use g1t_contracts::access::{self, RepoRef};
use g1t_contracts::repos::Repo;

/// Who is reading, as far as private repositories go.
#[derive(Clone, Debug, Default)]
pub struct Reader {
    /// Workspaces, by slug, whose every repository the reader can read:
    /// those they own, and those whose base permission gives members a
    /// role. A member of a workspace whose base permission is none is not
    /// in this list.
    pub reads_in: Vec<String>,
    /// Repositories the reader was given a role on directly, by id: an
    /// outside collaborator's, or a member's beyond the base permission.
    pub granted: Vec<String>,
}

impl Reader {
    pub fn of(viewer: &Viewer) -> Reader {
        let Some(user) = viewer else {
            return Reader::default();
        };
        Reader {
            reads_in: user
                .workspaces
                .iter()
                .map(|membership| membership.slug.to_lowercase())
                // What membership alone gives, on a private repository no
                // one was given a role on.
                .filter(|slug| access::granted(user, RepoRef { id: "", namespace: slug, private: true }).is_some())
                .collect(),
            granted: user.grants.iter().map(|grant| grant.repo_id.clone()).collect(),
        }
    }

    /// Whether the reader reads every repository in `namespace`.
    pub fn reads_namespace(&self, namespace: &str) -> bool {
        self.reads_in.iter().any(|slug| slug.eq_ignore_ascii_case(namespace))
    }

    /// Whether the reader was given a role on the repository `repo_id`.
    pub fn was_granted(&self, repo_id: &str) -> bool {
        self.granted.iter().any(|id| id == repo_id)
    }

    /// The first check: may the reader see a row of the repository
    /// `repo_id`, in `namespace`, that is `private` or not?
    pub fn may_see(&self, repo_id: &str, namespace: &str, private: bool) -> bool {
        !private || self.reads_namespace(namespace) || self.was_granted(repo_id)
    }

    /// [`Reader::reads_in`] as JSON, for `json_each` in a query. Never
    /// empty SQL: none is `[]`, which matches nothing.
    pub fn namespaces_json(&self) -> String {
        serde_json::to_string(&self.reads_in).unwrap_or_else(|_| "[]".into())
    }

    /// [`Reader::granted`] as JSON, likewise.
    pub fn granted_json(&self) -> String {
        serde_json::to_string(&self.granted).unwrap_or_else(|_| "[]".into())
    }
}

/// The SQL the first check adds to every query, given the repository's
/// table alias. Its two parameters are [`Reader::namespaces_json`] and
/// [`Reader::granted_json`], in that order.
pub fn clause(alias: &str) -> String {
    format!(
        "({alias}.private = 0 OR {alias}.namespace IN (SELECT value FROM json_each(?)) OR {alias}.repo_id IN (SELECT value FROM json_each(?)))"
    )
}

/// A repository as the index holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Indexed {
    pub repo_id: String,
    pub namespace: String,
    pub private: bool,
}

/// What the index should be told about a repository it holds wrongly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Correction {
    pub repo_id: String,
    pub private: bool,
    /// Its current path, when the repos service said.
    pub path: Option<(String, String)>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Verdict {
    /// The repositories whose rows may be returned.
    pub keep: HashSet<String>,
    pub corrections: Vec<Correction>,
}

/// The second check. `readable` is what the repos service says, for this
/// viewer, of the page's repositories (`readable` leaves out what they may
/// not read, and repositories that are gone). `None` when it could not be
/// asked: then only what the reader's own access reaches is kept (a
/// workspace whose repositories they all read, or a repository they were
/// given a role on), and nothing else public either, since it may have
/// just gone private.
pub fn check(reader: &Reader, indexed: &[Indexed], readable: Option<&[Repo]>) -> Verdict {
    let mut verdict = Verdict::default();
    let Some(readable) = readable else {
        for row in indexed {
            if reader.reads_namespace(&row.namespace) || reader.was_granted(&row.repo_id) {
                verdict.keep.insert(row.repo_id.clone());
            }
        }
        return verdict;
    };
    let now: HashMap<&str, &Repo> = readable.iter().map(|repo| (repo.id.as_str(), repo)).collect();
    let mut seen = HashSet::new();
    for row in indexed {
        if !seen.insert(row.repo_id.as_str()) {
            continue;
        }
        match now.get(row.repo_id.as_str()) {
            Some(repo) => {
                // Readable now, and the first check agrees with what is true now.
                if reader.may_see(&repo.id, &repo.namespace, repo.is_private) {
                    verdict.keep.insert(row.repo_id.clone());
                }
                if repo.is_private != row.private || !repo.namespace.eq_ignore_ascii_case(&row.namespace) {
                    verdict.corrections.push(Correction {
                        repo_id: row.repo_id.clone(),
                        private: repo.is_private,
                        path: Some((repo.namespace.to_lowercase(), repo.name.to_lowercase())),
                    });
                }
            }
            // Not readable: private now (or gone). The index learns at once,
            // so counts stop including it before its event arrives.
            None if !row.private => verdict.corrections.push(Correction {
                repo_id: row.repo_id.clone(),
                private: true,
                path: None,
            }),
            None => {}
        }
    }
    verdict
}

#[cfg(test)]
mod tests {
    use g1t_contracts::access::{BasePermission, RepoGrant, RepoRole};
    use g1t_contracts::{Membership, Role, User};

    use super::*;

    fn viewer(workspaces: &[&str]) -> Viewer {
        Some(User {
            id: "usr_1".into(),
            username: "ana".into(),
            workspaces: workspaces.iter().map(|slug| Membership::member(*slug)).collect(),
            ..User::default()
        })
    }

    fn row(id: &str, namespace: &str, private: bool) -> Indexed {
        Indexed {
            repo_id: id.into(),
            namespace: namespace.into(),
            private,
        }
    }

    fn repo(id: &str, namespace: &str, private: bool) -> Repo {
        Repo {
            id: id.into(),
            namespace: namespace.into(),
            name: "web".into(),
            description: None,
            is_private: private,
            owner_id: "usr_0".into(),
            default_branch: "main".into(),
            fork_of: None,
            protected: false,
            created_at: String::new(),
            topics: Vec::new(),
            website: None,
            archived_at: None,
        }
    }

    #[test]
    fn anyone_sees_public_rows() {
        assert!(Reader::of(&None).may_see("rep_1", "acme", false));
        assert!(Reader::of(&viewer(&["other"])).may_see("rep_1", "acme", false));
    }

    #[test]
    fn private_rows_are_for_members_only() {
        assert!(!Reader::of(&None).may_see("rep_1", "acme", true));
        assert!(!Reader::of(&viewer(&["other"])).may_see("rep_1", "acme", true));
        assert!(Reader::of(&viewer(&["acme"])).may_see("rep_1", "acme", true));
        assert!(Reader::of(&viewer(&["acme"])).may_see("rep_1", "ACME", true));
    }

    /// A member of acme whose base permission is `base`, given `grants`
    /// (repository id, role) there.
    fn member_with(base: BasePermission, grants: &[(&str, RepoRole)]) -> Viewer {
        Some(User {
            id: "usr_1".into(),
            username: "ana".into(),
            workspaces: vec![Membership { base_permission: Some(base), ..Membership::member("acme") }],
            grants: grants
                .iter()
                .map(|(id, role)| RepoGrant { repo_id: (*id).into(), workspace: "acme".into(), role: *role, team: None })
                .collect(),
            ..User::default()
        })
    }

    #[test]
    fn members_without_a_base_permission_see_only_what_they_were_given() {
        let reader = Reader::of(&member_with(BasePermission::None, &[("rep_2", RepoRole::Read)]));
        assert!(!reader.may_see("rep_1", "acme", true));
        assert!(reader.may_see("rep_2", "acme", true));
        assert!(reader.may_see("rep_1", "acme", false));
        assert_eq!(reader.namespaces_json(), "[]");
        assert_eq!(reader.granted_json(), r#"["rep_2"]"#);
        // Read as a base is enough for every repository.
        let reader = Reader::of(&member_with(BasePermission::Read, &[]));
        assert!(reader.may_see("rep_1", "acme", true));
        // An owner reads everything, whatever the base.
        let owner = Some(User {
            workspaces: vec![Membership {
                role: Role::Owner,
                base_permission: Some(BasePermission::None),
                ..Membership::member("acme")
            }],
            ..User::default()
        });
        assert!(Reader::of(&owner).may_see("rep_1", "acme", true));
    }

    #[test]
    fn outside_collaborators_see_their_repositories_and_no_others() {
        let outsider = Some(User {
            id: "usr_2".into(),
            username: "bo".into(),
            grants: vec![RepoGrant { repo_id: "rep_1".into(), workspace: "acme".into(), role: RepoRole::Triage, team: None }],
            ..User::default()
        });
        let reader = Reader::of(&outsider);
        assert!(reader.may_see("rep_1", "acme", true));
        assert!(!reader.may_see("rep_2", "acme", true));
        // Kept by the second check when the repos service agrees, and
        // without it, since the grant is theirs.
        let rows = [row("rep_1", "acme", true), row("rep_2", "acme", true)];
        let verdict = check(&reader, &rows, Some(&[repo("rep_1", "acme", true)]));
        assert_eq!(verdict.keep, HashSet::from(["rep_1".to_owned()]));
        let verdict = check(&reader, &rows, Some(&[repo("rep_1", "acme", true), repo("rep_2", "acme", true)]));
        assert_eq!(verdict.keep, HashSet::from(["rep_1".to_owned()]));
        let verdict = check(&reader, &rows, None);
        assert_eq!(verdict.keep, HashSet::from(["rep_1".to_owned()]));
    }

    #[test]
    fn the_query_clause_binds_workspaces_and_grants() {
        assert_eq!(
            clause("r"),
            "(r.private = 0 OR r.namespace IN (SELECT value FROM json_each(?)) OR r.repo_id IN (SELECT value FROM json_each(?)))"
        );
        assert_eq!(Reader::of(&None).namespaces_json(), "[]");
        assert_eq!(Reader::of(&None).granted_json(), "[]");
        // Identity gives slugs in lowercase, as access::granted expects.
        assert_eq!(Reader::of(&viewer(&["acme", "beta"])).namespaces_json(), r#"["acme","beta"]"#);
    }

    #[test]
    fn a_repository_made_private_disappears_before_its_event() {
        // The index still says public; the repos service no longer lets
        // this outsider read it.
        let reader = Reader::of(&viewer(&["other"]));
        let verdict = check(&reader, &[row("rep_1", "acme", false)], Some(&[]));
        assert!(verdict.keep.is_empty());
        assert_eq!(
            verdict.corrections,
            vec![Correction { repo_id: "rep_1".into(), private: true, path: None }]
        );
        // Signed out, the same.
        let verdict = check(&Reader::of(&None), &[row("rep_1", "acme", false)], Some(&[]));
        assert!(verdict.keep.is_empty());
    }

    #[test]
    fn members_still_see_a_repository_made_private() {
        let reader = Reader::of(&viewer(&["acme"]));
        let verdict = check(&reader, &[row("rep_1", "acme", false)], Some(&[repo("rep_1", "acme", true)]));
        assert!(verdict.keep.contains("rep_1"));
        assert!(verdict.corrections[0].private);
    }

    #[test]
    fn a_repository_made_public_is_shown_and_corrected() {
        // The first check let a member's row through; the repos service
        // says it is public now, so the index is told.
        let reader = Reader::of(&viewer(&["acme"]));
        let verdict = check(&reader, &[row("rep_2", "acme", true)], Some(&[repo("rep_2", "acme", false)]));
        assert!(verdict.keep.contains("rep_2"));
        assert!(!verdict.corrections[0].private);
        // Once corrected, an outsider's first check lets it through too.
        assert!(Reader::of(&None).may_see("rep_2", "acme", false));
    }

    #[test]
    fn private_rows_never_reach_outsiders_whatever_the_index_says() {
        // Even if a private row slipped through the first check, and the
        // repos service somehow answered with it, the reader is no member.
        let reader = Reader::of(&viewer(&["other"]));
        let verdict = check(&reader, &[row("rep_3", "acme", false)], Some(&[repo("rep_3", "acme", true)]));
        assert!(verdict.keep.is_empty());
    }

    #[test]
    fn without_the_repos_service_only_members_rows_are_kept() {
        let reader = Reader::of(&viewer(&["acme"]));
        let verdict = check(&reader, &[row("rep_1", "acme", true), row("rep_2", "public-co", false)], None);
        assert_eq!(verdict.keep, HashSet::from(["rep_1".to_owned()]));
        assert!(verdict.corrections.is_empty());
    }

    #[test]
    fn a_moved_repository_is_corrected() {
        let reader = Reader::of(&None);
        let mut moved = repo("rep_4", "newname", false);
        moved.name = "Web".into();
        let verdict = check(&reader, &[row("rep_4", "oldname", false)], Some(&[moved]));
        assert!(verdict.keep.contains("rep_4"));
        assert_eq!(verdict.corrections[0].path, Some(("newname".into(), "web".into())));
    }
}
