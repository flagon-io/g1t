//! Work done once for many askers.
//!
//! When a repository's default branch moves, work asks again whether each
//! of its open pull requests (up to 100) still merges cleanly
//! (`divergence`). Every one of those questions starts with the same
//! answer about the target: its history from the new head, and what it
//! changed since a pull request's merge base. That half is worked out once
//! per target head and kept here, in the isolate, for the burst of
//! questions that follows ([`Memo`]); the history itself is kept by commit
//! hash in the object cache (store.rs), so other isolates read it without
//! asking the store. Only each pull request's own side is read per pull
//! request.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::rc::Rc;

use g1t_contracts::repos::Commit;

/// Answers kept for a short while, at most `cap` of them.
pub struct Memo<K, V> {
    entries: HashMap<K, (V, u64)>,
    ttl_ms: u64,
    cap: usize,
}

impl<K: Eq + Hash + Clone, V: Clone> Memo<K, V> {
    pub fn new(ttl_ms: u64, cap: usize) -> Self {
        Memo { entries: HashMap::new(), ttl_ms, cap }
    }

    pub fn get(&self, key: &K, now: u64) -> Option<V> {
        self.entries
            .get(key)
            .filter(|(_, at)| now.saturating_sub(*at) < self.ttl_ms)
            .map(|(value, _)| value.clone())
    }

    pub fn put(&mut self, key: K, value: V, now: u64) {
        let ttl = self.ttl_ms;
        self.entries.retain(|_, (_, at)| now.saturating_sub(*at) < ttl);
        while self.entries.len() >= self.cap {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, (_, at))| *at).map(|(key, _)| key.clone()) else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.entries.insert(key, (value, now));
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// A target branch's side of the question: its history from its head
/// (first parent, newest first), and the same as a set.
pub struct TargetSide {
    pub history: Vec<Commit>,
    pub shared: HashSet<String>,
}

impl TargetSide {
    pub fn new(history: Vec<Commit>) -> Rc<Self> {
        let shared = history.iter().map(|commit| commit.hash.clone()).collect();
        Rc::new(TargetSide { history, shared })
    }
}

/// Where a target's side is kept: the repository, its default branch, and
/// the version of its refs, which moves with the branch. Kept only while
/// the version can be trusted (registry.rs, refs_cache.rs `usable`).
pub type TargetKey = (String, String, u64);
/// What the target changed between two trees: the repository and the trees.
pub type TheirsKey = (String, String, String);

/// How long a target's side is kept: long enough for one burst of
/// questions after a push.
pub const TARGET_TTL_MS: u64 = 60_000;
/// What a target changed between two trees never changes; kept a while.
pub const THEIRS_TTL_MS: u64 = 10 * 60_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_is_kept_for_a_while_and_the_oldest_goes_first() {
        let mut memo: Memo<&str, u32> = Memo::new(1_000, 2);
        memo.put("a", 1, 0);
        assert_eq!(memo.get(&"a", 999), Some(1));
        assert_eq!(memo.get(&"a", 1_000), None);
        memo.put("b", 2, 10);
        memo.put("c", 3, 20);
        // Full: "a" was oldest.
        assert_eq!(memo.get(&"a", 20), None);
        assert_eq!(memo.get(&"b", 20), Some(2));
        assert_eq!(memo.len(), 2);
        // Expired ones go before anything is pushed out.
        memo.put("d", 4, 1_015);
        assert_eq!(memo.get(&"c", 1_015), Some(3));
        assert_eq!(memo.get(&"d", 1_015), Some(4));
    }

    #[test]
    fn a_target_side_is_keyed_by_its_refs_version() {
        let commit = |hash: &str| Commit {
            hash: hash.into(),
            tree_hash: String::new(),
            message: String::new(),
            author: g1t_contracts::repos::Signature { name: String::new(), email: String::new() },
            parents: Vec::new(),
            authored_at: String::new(),
        };
        let side = TargetSide::new(vec![commit("b"), commit("a")]);
        assert!(side.shared.contains("a") && side.shared.contains("b"));
        let mut memo: Memo<TargetKey, Rc<TargetSide>> = Memo::new(TARGET_TTL_MS, 32);
        let key = ("rep_1".to_owned(), "main".to_owned(), 7);
        memo.put(key.clone(), side, 0);
        assert!(memo.get(&key, 10).is_some());
        // The branch moved: the version did too, and the old side is not used.
        assert!(memo.get(&("rep_1".to_owned(), "main".to_owned(), 8), 10).is_none());
    }
}
