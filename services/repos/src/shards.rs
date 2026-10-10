//! Which git store namespace a repository lives in.
//!
//! Cloudflare limits each Artifacts namespace to 2,000 control-plane
//! requests per 10 seconds, and fixes its jurisdiction (US or EU) when it
//! is made. So repositories can live in several namespaces, each reached
//! through its own binding (`GITSTORE`, `GITSTORE_1`, ..., `GITSTORE_EU`),
//! named in the `GITSTORE_NAMESPACES` variable:
//!
//! ```json
//! { "GITSTORE": "g1t", "GITSTORE_1": "g1t-us-1", "GITSTORE_EU": "g1t-eu" }
//! ```
//!
//! A repository's namespace is part of its store key in the registry's
//! `store` column: `g1t-us-1/acme--rocket`. A key with no namespace
//! (`acme--rocket`, every repository made before this) is in the namespace
//! bound to `GITSTORE`. A pull request's working copy is always in its
//! repository's namespace, since Artifacts forks within a namespace.
//!
//! New repositories go where `GITSTORE_NEW_REPOS` says (a comma-separated
//! list of namespaces): the emptier healthy ones, spread by repository id
//! ([`Placement::choose`], from namespaces.rs's loads). A workspace that
//! keeps its data in the EU (identity's `data_residency`, offered once
//! `GITSTORE_EU_NAMESPACE` names a bound namespace) gets that namespace,
//! or nothing. `GITSTORE_NAMESPACE_LIMITS` caps how many repositories a
//! namespace takes. Without any of these, everything stays in
//! `GITSTORE`'s, and nothing extra is read. An existing repository moves
//! between namespaces only when an operator asks (moves.rs).

/// The binding every installation has.
pub const DEFAULT_BINDING: &str = "GITSTORE";
/// Its namespace, unless `GITSTORE_NAMESPACES` says otherwise.
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

/// Cloudflare's control-plane limit for one namespace, per minute: 2,000
/// requests per 10 seconds.
pub const CONTROL_PLANE_PER_MINUTE: u64 = 12_000;
/// Past this share of the limit in its busiest recent minute, a namespace
/// is hot and takes no new repositories while another can.
pub const HOT_SHARE: f64 = 0.7;
/// New repositories go to the namespaces holding no more than this many
/// above the emptiest, or this share above it, spread among them by id,
/// so a burst between counts does not all land in one place.
const SLACK_REPOS: u64 = 100;
const SLACK_SHARE: f64 = 0.05;

/// The most each namespace should hold, from `GITSTORE_NAMESPACE_LIMITS`
/// (JSON, `{"g1t": {"max_repos": 50000}}`); a namespace not named has no
/// limit but the control-plane one.
pub fn limits(config: Option<&str>) -> std::collections::HashMap<String, u64> {
    config
        .and_then(|text| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(text).ok())
        .map(|map| {
            map.into_iter()
                .filter_map(|(namespace, limit)| Some((namespace, limit.get("max_repos")?.as_u64()?)))
                .collect()
        })
        .unwrap_or_default()
}

/// How a namespace stands, for placing a repository in it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Load {
    pub namespace: String,
    /// Bound to a binding here.
    pub bound: bool,
    /// Takes writes now: not while served from a read-only fallback.
    pub writable: bool,
    /// Repositories and working copies in it (not deleted).
    pub repos: u64,
    /// Its busiest minute of calls lately (meters.rs `store_health`).
    pub peak_per_minute: u64,
    /// Failing now: its breaker open here, or a quarter of its recent
    /// calls failing.
    pub failing: bool,
    /// `GITSTORE_NAMESPACE_LIMITS`'s `max_repos` for it.
    pub max_repos: Option<u64>,
}

impl Load {
    /// Whether it can take a repository at all.
    fn usable(&self) -> bool {
        self.bound && self.writable
    }

    /// Whether it should, when another could.
    fn healthy(&self) -> bool {
        self.usable()
            && !self.failing
            && self.max_repos.is_none_or(|max| self.repos < max)
            && (self.peak_per_minute as f64) < CONTROL_PLANE_PER_MINUTE as f64 * HOT_SHARE
    }
}

/// Why a repository could not be placed.
#[derive(Debug, PartialEq, Eq)]
pub enum Unplaced {
    /// The workspace keeps its data in the EU, and there is no EU
    /// namespace to take it now.
    NoEu,
}

impl Unplaced {
    pub fn message(&self) -> &'static str {
        match self {
            Unplaced::NoEu => {
                "This workspace keeps its data in the EU, and EU storage cannot take new repositories right now. Try again later, or ask support."
            }
        }
    }
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

    /// Whether loads are worth reading: more than one namespace could take
    /// the repository. With one or none, `choose` needs none.
    pub fn needs_loads(&self, bound: &[String]) -> bool {
        self.new_repos.iter().filter(|name| bound.contains(name)).count() > 1
    }

    /// Whether an EU namespace is there to take repositories.
    pub fn eu_available(&self, bound: &[String], writable: impl Fn(&str) -> bool) -> bool {
        self.eu.as_deref().is_some_and(|eu| bound.iter().any(|name| name == eu) && writable(eu))
    }

    /// The namespace for a new repository with this id, from how each
    /// stands (`loads`); `Ok(None)` for the default.
    ///
    /// - EU residency: the EU namespace, if it is bound and takes writes;
    ///   otherwise refused, never placed elsewhere.
    /// - Anywhere: among the namespaces named in `GITSTORE_NEW_REPOS` that
    ///   are healthy (bound, writable, not failing, under their limit and
    ///   not hot), those within the slack of the emptiest, spread by id. If
    ///   none is healthy, the usable ones the same way; if none is usable,
    ///   the default. A namespace with no load given is passed over, as one
    ///   not bound is.
    pub fn choose(&self, repo_id: &str, residency: Residency, loads: &[Load]) -> Result<Option<String>, Unplaced> {
        let load_of = |name: &str| loads.iter().find(|load| load.namespace == name);
        if residency == Residency::Eu {
            return match self.eu.as_deref().and_then(load_of) {
                Some(load) if load.usable() => Ok(Some(load.namespace.clone())),
                _ => Err(Unplaced::NoEu),
            };
        }
        let named: Vec<&Load> = self.new_repos.iter().filter_map(|name| load_of(name)).collect();
        let healthy: Vec<&Load> = named.iter().copied().filter(|load| load.healthy()).collect();
        let pool = if healthy.is_empty() { named.into_iter().filter(|load| load.usable()).collect() } else { healthy };
        let Some(emptiest) = pool.iter().map(|load| load.repos).min() else {
            return Ok(None);
        };
        let ceiling = emptiest.saturating_add(SLACK_REPOS.max((emptiest as f64 * SLACK_SHARE) as u64));
        let eligible: Vec<&Load> = pool.into_iter().filter(|load| load.repos <= ceiling).collect();
        Ok(Some(eligible[(fnv(repo_id) % eligible.len() as u64) as usize].namespace.clone()))
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
        assert_eq!(bindings(None), vec![("GITSTORE".to_owned(), "g1t".to_owned())]);
        let configured = bindings(Some(r#"{"GITSTORE_EU":"g1t-eu","GITSTORE_1":"g1t-us-1","GITSTORE":"g1t","GITSTORE_2":"bad name!"}"#));
        assert_eq!(
            configured,
            vec![
                ("GITSTORE".to_owned(), "g1t".to_owned()),
                ("GITSTORE_1".to_owned(), "g1t-us-1".to_owned()),
                ("GITSTORE_EU".to_owned(), "g1t-eu".to_owned()),
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
        // A load for each bound namespace, all empty.
        let bound: Vec<Load> = ["g1t", "g1t-us-1", "g1t-us-2", "g1t-eu"].map(|name| load(name, 0)).to_vec();
        // Nothing configured: everything stays where it was.
        assert_eq!(Placement::default().choose("rep_1", Residency::Anywhere, &bound), Ok(None));
        let placement = Placement::from_vars(Some("g1t-us-1, g1t-us-2,g1t-us-3"), Some("g1t-eu"));
        let mut seen = std::collections::HashMap::new();
        for n in 0..1000 {
            let id = format!("rep_{n:05}");
            let placed = placement.choose(&id, Residency::Anywhere, &bound).unwrap().unwrap();
            // The same id always lands in the same place.
            assert_eq!(placement.choose(&id, Residency::Anywhere, &bound).unwrap().unwrap(), placed);
            *seen.entry(placed).or_insert(0) += 1;
        }
        // g1t-us-3 is named but not bound, so it takes nothing.
        assert_eq!(seen.len(), 2);
        assert!(seen.values().all(|count| *count > 400));
        assert_eq!(placement.choose("rep_1", Residency::Eu, &bound), Ok(Some("g1t-eu".to_owned())));
        // EU asked for but not bound: nowhere, so the caller refuses.
        assert_eq!(placement.choose("rep_1", Residency::Eu, &bound[..3]), Err(Unplaced::NoEu));
        assert!(valid_namespace("g1t") && !valid_namespace("-g1t") && !valid_namespace("x"));
    }

    fn load(namespace: &str, repos: u64) -> Load {
        Load { namespace: namespace.to_owned(), bound: true, writable: true, repos, ..Load::default() }
    }

    fn spread(placement: &Placement, loads: &[Load]) -> std::collections::HashMap<String, u32> {
        let mut seen = std::collections::HashMap::new();
        for n in 0..1000 {
            let placed = placement.choose(&format!("rep_{n:05}"), Residency::Anywhere, loads).unwrap().unwrap_or_default();
            *seen.entry(placed).or_insert(0) += 1;
        }
        seen
    }

    #[test]
    fn new_repositories_go_to_the_emptier_healthy_namespaces() {
        let placement = Placement::from_vars(Some("g1t,g1t-us-1,g1t-us-2"), Some("g1t-eu"));
        // Nothing configured: the default, whatever the loads.
        assert_eq!(Placement::default().choose("rep_1", Residency::Anywhere, &[load("g1t", 0)]), Ok(None));
        // Close in size: spread over all three.
        let even = spread(&placement, &[load("g1t", 5_000), load("g1t-us-1", 5_050), load("g1t-us-2", 5_100)]);
        assert_eq!(even.len(), 3);
        assert!(even.values().all(|count| *count > 250));
        // One far emptier: it takes them all until it catches up.
        let filling = spread(&placement, &[load("g1t", 9_000), load("g1t-us-1", 200), load("g1t-us-2", 9_000)]);
        assert_eq!(filling.get("g1t-us-1"), Some(&1000));
        // Failing, hot, full or read-only: passed over while another can.
        let mut failing = load("g1t-us-1", 0);
        failing.failing = true;
        let mut hot = load("g1t-us-2", 0);
        hot.peak_per_minute = 9_000;
        let healthy = spread(&placement, &[load("g1t", 9_000), failing.clone(), hot.clone()]);
        assert_eq!(healthy.get("g1t"), Some(&1000));
        let mut full = load("g1t", 10);
        full.max_repos = Some(10);
        let mut read_only = load("g1t-us-1", 0);
        read_only.writable = false;
        let left = spread(&placement, &[full.clone(), read_only.clone(), load("g1t-us-2", 50)]);
        assert_eq!(left.get("g1t-us-2"), Some(&1000));
        // Nothing healthy: still somewhere usable, never a read-only one.
        let worst = spread(&placement, &[full, read_only.clone(), hot]);
        assert!(!worst.contains_key("g1t-us-1"));
        // Nothing usable at all: the default, as before sharding.
        assert_eq!(placement.choose("rep_1", Residency::Anywhere, &[read_only]), Ok(None));
        // Not bound: no load given, never chosen.
        assert_eq!(spread(&placement, &[load("g1t", 10)]).get("g1t"), Some(&1000));
    }

    #[test]
    fn eu_residency_goes_to_the_eu_namespace_or_nowhere() {
        let placement = Placement::from_vars(Some("g1t"), Some("g1t-eu"));
        let mut eu = load("g1t-eu", 0);
        assert_eq!(placement.choose("rep_1", Residency::Eu, &[load("g1t", 0), eu.clone()]), Ok(Some("g1t-eu".to_owned())));
        // Failing is the store's to say when asked; read-only or unbound refuses.
        eu.failing = true;
        assert_eq!(placement.choose("rep_1", Residency::Eu, &[eu.clone()]), Ok(Some("g1t-eu".to_owned())));
        eu.writable = false;
        assert_eq!(placement.choose("rep_1", Residency::Eu, &[eu]), Err(Unplaced::NoEu));
        assert_eq!(placement.choose("rep_1", Residency::Eu, &[load("g1t", 0)]), Err(Unplaced::NoEu));
        assert_eq!(Placement::default().choose("rep_1", Residency::Eu, &[]), Err(Unplaced::NoEu));
        let bound = vec!["g1t".to_owned(), "g1t-eu".to_owned()];
        assert!(placement.eu_available(&bound, |_| true));
        assert!(!placement.eu_available(&bound, |name| name != "g1t-eu"));
        assert!(!placement.eu_available(&bound[..1], |_| true));
        assert!(!Placement::default().eu_available(&bound, |_| true));
    }

    #[test]
    fn loads_are_read_only_when_there_is_a_choice() {
        let bound = vec!["g1t".to_owned(), "g1t-us-1".to_owned()];
        assert!(!Placement::default().needs_loads(&bound));
        assert!(!Placement::from_vars(Some("g1t-us-1"), None).needs_loads(&bound));
        assert!(!Placement::from_vars(Some("g1t-us-1,g1t-us-9"), None).needs_loads(&bound));
        assert!(Placement::from_vars(Some("g1t,g1t-us-1"), None).needs_loads(&bound));
        assert_eq!(limits(Some(r#"{"g1t":{"max_repos":50000},"x":{}}"#)).get("g1t"), Some(&50_000));
        assert!(limits(Some("nope")).is_empty() && limits(None).is_empty());
    }
}
