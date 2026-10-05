//! Who may see what. Checked twice, both times when the query runs:
//!
//! 1. In the query itself, against the viewer's memberships as they are
//!    now: a row is read if its repository is public, as the index last
//!    heard, or in a workspace the viewer belongs to.
//! 2. On the page about to be returned, against the repos service, which
//!    owns visibility: anything it does not say the viewer may read now is
//!    dropped, and the index is corrected. A repository made private a
//!    moment ago, before its event arrived, is never shown to anyone
//!    outside its workspace.
//!
//! Pure, so the rules are tested apart from the index.

use std::collections::{HashMap, HashSet};

use g1t_contracts::Viewer;
use g1t_contracts::repos::Repo;

/// Who is reading: the workspaces they belong to, by slug.
#[derive(Clone, Debug, Default)]
pub struct Reader {
    pub member_of: Vec<String>,
}

impl Reader {
    pub fn of(viewer: &Viewer) -> Reader {
        Reader {
            member_of: viewer
                .iter()
                .flat_map(|user| &user.workspaces)
                .map(|membership| membership.slug.to_lowercase())
                .collect(),
        }
    }

    pub fn is_member(&self, namespace: &str) -> bool {
        self.member_of.iter().any(|slug| slug.eq_ignore_ascii_case(namespace))
    }

    /// The first check: may the reader see a row of a repository in
    /// `namespace` that is `private` or not?
    pub fn may_see(&self, namespace: &str, private: bool) -> bool {
        !private || self.is_member(namespace)
    }

    /// The reader's workspaces as JSON, for `json_each` in a query. Never
    /// empty SQL: no workspaces is `[]`, which matches nothing.
    pub fn members_json(&self) -> String {
        serde_json::to_string(&self.member_of).unwrap_or_else(|_| "[]".into())
    }
}

/// The SQL the first check adds to every query, given the repository's
/// table alias. Its one parameter is [`Reader::members_json`].
pub fn clause(alias: &str) -> String {
    format!("({alias}.private = 0 OR {alias}.namespace IN (SELECT value FROM json_each(?)))")
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
/// asked: then nothing private is kept, and nothing public of a workspace
/// the reader is not in either, since it may have just gone private.
pub fn check(reader: &Reader, indexed: &[Indexed], readable: Option<&[Repo]>) -> Verdict {
    let mut verdict = Verdict::default();
    let Some(readable) = readable else {
        for row in indexed {
            if reader.is_member(&row.namespace) {
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
                if reader.may_see(&repo.namespace, repo.is_private) {
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
    use g1t_contracts::{Membership, User};

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
        }
    }

    #[test]
    fn anyone_sees_public_rows() {
        assert!(Reader::of(&None).may_see("acme", false));
        assert!(Reader::of(&viewer(&["other"])).may_see("acme", false));
    }

    #[test]
    fn private_rows_are_for_members_only() {
        assert!(!Reader::of(&None).may_see("acme", true));
        assert!(!Reader::of(&viewer(&["other"])).may_see("acme", true));
        assert!(Reader::of(&viewer(&["acme"])).may_see("acme", true));
        assert!(Reader::of(&viewer(&["acme"])).may_see("ACME", true));
    }

    #[test]
    fn the_query_clause_binds_memberships() {
        assert_eq!(clause("r"), "(r.private = 0 OR r.namespace IN (SELECT value FROM json_each(?)))");
        assert_eq!(Reader::of(&None).members_json(), "[]");
        assert_eq!(Reader::of(&viewer(&["Acme", "beta"])).members_json(), r#"["acme","beta"]"#);
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
        assert_eq!(verdict.corrections[0].private, true);
    }

    #[test]
    fn a_repository_made_public_is_shown_and_corrected() {
        // The first check let a member's row through; the repos service
        // says it is public now, so the index is told.
        let reader = Reader::of(&viewer(&["acme"]));
        let verdict = check(&reader, &[row("rep_2", "acme", true)], Some(&[repo("rep_2", "acme", false)]));
        assert!(verdict.keep.contains("rep_2"));
        assert_eq!(verdict.corrections[0].private, false);
        // Once corrected, an outsider's first check lets it through too.
        assert!(Reader::of(&None).may_see("acme", false));
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
