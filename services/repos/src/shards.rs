//! Which git store namespace a repository lives in.
//!
//! Cloudflare limits each Artifacts namespace to 2,000 control-plane
//! requests per 10 seconds, and fixes its jurisdiction (US or EU) when it
//! is made. So repositories can live in several namespaces, each reached
//! through its own binding (`ARTIFACTS`, `ARTIFACTS_1`, ..., `ARTIFACTS_EU`),
//! named in the `ARTIFACTS_NAMESPACES` variable:
//!
//! ```json
//! { "ARTIFACTS": "g1t", "ARTIFACTS_1": "g1t-us-1", "ARTIFACTS_EU": "g1t-eu" }
//! ```
//!
//! A repository's namespace is part of its store key in the registry's
//! `store` column: `g1t-us-1/acme--rocket`. A key with no namespace
//! (`acme--rocket`, every repository made before this) is in the namespace
//! bound to `ARTIFACTS`. A pull request's working copy is always in its
//! repository's namespace, since Artifacts forks within a namespace.
//!
//! New repositories go where `ARTIFACTS_NEW_REPOS` says (a comma-separated
//! list of namespaces, spread by repository id), and to
//! `ARTIFACTS_EU_NAMESPACE` for a workspace that keeps its data in the EU
//! (not offered yet). Without either, everything stays in `ARTIFACTS`'s.

/// The binding every installation has.
pub const DEFAULT_BINDING: &str = "ARTIFACTS";
/// Its namespace, unless `ARTIFACTS_NAMESPACES` says otherwise.
pub const DEFAULT_NAMESPACE: &str = "g1t";

/// Each binding and the namespace it reaches, the default first.
pub fn bindings(config: Option<&str>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = config
        .and_then(|text| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(text).ok())
        .map(|map| {
            map.into_iter()
                .filter_map(|(binding, namespace)| Some((binding, namespace.as_str()?.trim().to_owned())))
                .filter(|(_, namespace)| valid_namespace(namespace))
                .collect()
        })
        .unwrap_or_default();
    if !out.iter().any(|(binding, _)| binding == DEFAULT_BINDING) {
        out.push((DEFAULT_BINDING.to_owned(), DEFAULT_NAMESPACE.to_owned()));
    }
    out.sort_by_key(|(binding, _)| (binding != DEFAULT_BINDING, binding.clone()));
    out
}

/// Cloudflare's rule for names: 2 to 63 letters, digits, `.`, `_`, `-`,
/// starting with a letter or digit.
pub fn valid_namespace(name: &str) -> bool {
    (2..=63).contains(&name.len())
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A store key's namespace (`None`: the default one) and its name there.
pub fn split(key: &str) -> (Option<&str>, &str) {
    match key.split_once('/') {
        Some((namespace, name)) => (Some(namespace), name),
        None => (None, key),
    }
}

/// The store key for `name` in `namespace`; the default one is left out,
/// so keys made before sharding read the same.
pub fn compose(namespace: Option<&str>, name: &str, default: &str) -> String {
    match namespace {
        Some(namespace) if namespace != default => format!("{namespace}/{name}"),
        _ => name.to_owned(),
    }
}

/// Where a workspace keeps its data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Residency {
    Anywhere,
    Eu,
}

/// Where new repositories go.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Placement {
    /// Namespaces that take new repositories; empty for the default.
    pub new_repos: Vec<String>,
    pub eu: Option<String>,
}

impl Placement {
    pub fn from_vars(new_repos: Option<&str>, eu: Option<&str>) -> Self {
        Placement {
            new_repos: new_repos
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|name| valid_namespace(name))
                .map(str::to_owned)
                .collect(),
            eu: eu.map(str::trim).filter(|name| valid_namespace(name)).map(str::to_owned),
        }
    }

    /// The namespace for a new repository with this id, among those bound
    /// (`bound`); `None` for the default. A namespace that is named but not
    /// bound is passed over, so a half-made configuration cannot strand a
    /// repository.
    pub fn place(&self, repo_id: &str, residency: Residency, bound: &[String]) -> Option<String> {
        if residency == Residency::Eu {
            return self.eu.clone().filter(|eu| bound.contains(eu));
        }
        let usable: Vec<&String> = self.new_repos.iter().filter(|name| bound.contains(name)).collect();
        if usable.is_empty() {
            return None;
        }
        Some(usable[(fnv(repo_id) % usable.len() as u64) as usize].clone())
    }
}

/// FNV-1a, to spread ids over namespaces the same way every time.
fn fnv(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_binding_is_always_there_and_first() {
        assert_eq!(bindings(None), vec![("ARTIFACTS".to_owned(), "g1t".to_owned())]);
        let configured = bindings(Some(r#"{"ARTIFACTS_EU":"g1t-eu","ARTIFACTS_1":"g1t-us-1","ARTIFACTS":"g1t","ARTIFACTS_2":"bad name!"}"#));
        assert_eq!(
            configured,
            vec![
                ("ARTIFACTS".to_owned(), "g1t".to_owned()),
                ("ARTIFACTS_1".to_owned(), "g1t-us-1".to_owned()),
                ("ARTIFACTS_EU".to_owned(), "g1t-eu".to_owned()),
            ]
        );
        assert_eq!(bindings(Some("not json")), bindings(None));
    }

    #[test]
    fn keys_name_their_namespace_unless_it_is_the_default() {
        assert_eq!(split("acme--rocket"), (None, "acme--rocket"));
        assert_eq!(split("g1t-us-1/acme--rocket"), (Some("g1t-us-1"), "acme--rocket"));
        assert_eq!(compose(None, "acme--rocket", "g1t"), "acme--rocket");
        assert_eq!(compose(Some("g1t"), "acme--rocket", "g1t"), "acme--rocket");
        assert_eq!(compose(Some("g1t-us-1"), "pulls--pul_1", "g1t"), "g1t-us-1/pulls--pul_1");
    }

    #[test]
    fn new_repositories_spread_over_the_bound_namespaces() {
        let bound = vec!["g1t".to_owned(), "g1t-us-1".to_owned(), "g1t-us-2".to_owned(), "g1t-eu".to_owned()];
        // Nothing configured: everything stays where it was.
        assert_eq!(Placement::default().place("rep_1", Residency::Anywhere, &bound), None);
        let placement = Placement::from_vars(Some("g1t-us-1, g1t-us-2,g1t-us-3"), Some("g1t-eu"));
        let mut seen = std::collections::HashMap::new();
        for n in 0..1000 {
            let id = format!("rep_{n:05}");
            let placed = placement.place(&id, Residency::Anywhere, &bound).unwrap();
            // The same id always lands in the same place.
            assert_eq!(placement.place(&id, Residency::Anywhere, &bound).unwrap(), placed);
            *seen.entry(placed).or_insert(0) += 1;
        }
        // g1t-us-3 is named but not bound, so it takes nothing.
        assert_eq!(seen.len(), 2);
        assert!(seen.values().all(|count| *count > 400));
        assert_eq!(placement.place("rep_1", Residency::Eu, &bound).as_deref(), Some("g1t-eu"));
        // EU asked for but not bound: nowhere, so the caller can refuse.
        assert_eq!(placement.place("rep_1", Residency::Eu, &bound[..3]), None);
        assert!(valid_namespace("g1t") && !valid_namespace("-g1t") && !valid_namespace("x"));
    }
}
