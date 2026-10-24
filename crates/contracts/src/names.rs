/// The site's own routes: first path segments that are never a workspace's,
/// so nobody may register them, and no alias can be reached at them.
const ROUTES: &[&str] = &[
    "api",
    "mcp",
    "login",
    "logout",
    "register",
    "new",
    "settings",
    "search",
    "admin",
    "auth",
    // g1t.sh/integrations/github/setup: where GitHub returns after an install.
    "integrations",
    "pulls",
    "issues",
    "oauth",
    "assets",
    "avatars",
    "docs",
    "explore",
    "about",
    "pricing",
    "features",
    "terms",
    "privacy",
    "policies",
    "security",
    "help",
    "support",
    "status",
    "blog",
    "verify",
    "confirm-email",
    "forgot",
    "reset",
    "device",
    "workspaces",
    "u",
    // g1t.sh/invite/<code>: invite links; and the retired waitlist.
    "invite",
    "invites",
    "waitlist",
    // g1t.sh/invitations: the workspace invitations waiting for an answer.
    "invitations",
    // g1t.sh/v2/: the container registry; `-` paths hold the others.
    "v2",
    // g1t.sh/inbox, and the name it might also go by.
    "inbox",
    "notifications",
];

/// g1t itself, the name its agent once went by, and `ghost`, who wrote what
/// a deleted account wrote (`account_deletion::GHOST_USERNAME`): everything
/// g1t does is shown as `g1t`, so nobody else may be called any of these.
/// Not routes: staff may point one at a workspace as an alias (identity's
/// `aliases.rs`).
const OWN: &[&str] = &["g1t", "g1t-agent", "ghost"];

/// The GitHub accounts whose actions workflows use most. A workflow's
/// `uses: actions/setup-node@v4` means GitHub's `actions`, so nobody may
/// register these on g1t and be mistaken for them. They are not reserved
/// as [`is_reserved_name`] is: an account that already has one keeps it,
/// mentions and invitations still find it, and staff can give one, as an
/// alias, to the account that proves it owns the name on GitHub.
const ACTION_OWNERS: &[&str] = &[
    "actions",
    "actions-ecosystem",
    "actions-rs",
    "amannn",
    "anchore",
    "appleboy",
    "aquasecurity",
    "arduino",
    "astral-sh",
    "aws-actions",
    "azure",
    "browser-actions",
    "bufbuild",
    "cachix",
    "changesets",
    "chromaui",
    "cloudflare",
    "codecov",
    "conda-incubator",
    "coursier",
    "crazy-max",
    "cypress-io",
    "dawidd6",
    "denoland",
    "dependabot",
    "dessant",
    "determinatesystems",
    "devcontainers",
    "digitalocean",
    "docker",
    "dorny",
    "dtolnay",
    "endbug",
    "erlef",
    "firebaseextended",
    "fluxcd",
    "getsentry",
    "github",
    "golangci",
    "google-github-actions",
    "googleapis",
    "goreleaser",
    "gradle",
    "gradle-update",
    "hadolint",
    "hashicorp",
    "haskell-actions",
    "hecrj",
    "helm",
    "ilammy",
    "jamesives",
    "jetbrains",
    "julia-actions",
    "kubernetes-sigs",
    "lukka",
    "marocchino",
    "microsoft",
    "mikepenz",
    "mozilla-actions",
    "msys2",
    "mxschmitt",
    "ncipollo",
    "netlify",
    "nick-fields",
    "nwtgck",
    "octokit",
    "ossf",
    "oven-sh",
    "peaceiris",
    "peter-evans",
    "pnpm",
    "pre-commit",
    "pypa",
    "r-lib",
    "release-drafter",
    "renovatebot",
    "reviewdog",
    "rhysd",
    "ruby",
    "rust-lang",
    "sbt",
    "shivammathur",
    "sigstore",
    "slackapi",
    "slsa-framework",
    "snyk",
    "softprops",
    "sonarsource",
    "stefanzweifel",
    "step-security",
    "styfle",
    "subosito",
    "supabase",
    "super-linter",
    "superfly",
    "svenstaro",
    "swatinem",
    "taiki-e",
    "tj-actions",
    "treosh",
    "vercel",
    "webfactory",
];

/// Whether `value`, whatever its case, is a name nobody can register or
/// rename a workspace to: a route, or g1t's own.
pub fn is_reserved_name(value: &str) -> bool {
    is_route_name(value) || OWN.iter().any(|own| own.eq_ignore_ascii_case(value.trim()))
}

/// Whether `value`, whatever its case, names one of the GitHub accounts
/// whose actions workflows use most: see [`ACTION_OWNERS`].
pub fn is_action_owner_name(value: &str) -> bool {
    ACTION_OWNERS.iter().any(|owner| owner.eq_ignore_ascii_case(value.trim()))
}

/// Whether a person or workspace may take `value` as its name now, by
/// signing up, creating a workspace or renaming one: a valid namespace
/// that no well-known GitHub action owner goes by.
pub fn is_claimable_name(value: &str) -> bool {
    is_valid_namespace(value) && !is_action_owner_name(value)
}

/// Whether `value`, whatever its case, is one of the site's own routes.
pub fn is_route_name(value: &str) -> bool {
    let value = value.trim();
    ROUTES.iter().any(|route| route.eq_ignore_ascii_case(value))
}

/// Whether `value` has a namespace's shape: letters, digits and single
/// hyphens, not starting or ending with a hyphen, at most 39 characters.
/// Reserved names have it too; see [`is_valid_namespace`].
pub fn is_namespace_shaped(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 39
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
}

/// A workspace alias as staff typed it, trimmed and lowercased, if it can
/// be one: shaped like a namespace and not one of the site's routes, which
/// would always answer first. Reserved names such as `g1t` can be; whether
/// a person or workspace already has it is identity's to check.
pub fn aliasable_name(value: &str) -> Option<String> {
    let value = value.trim().to_lowercase();
    (is_namespace_shaped(&value) && !is_route_name(&value)).then_some(value)
}

/// A username or workspace slug as someone typed it, trimmed and
/// lowercased, if it can be registered: what signing up, signing up with
/// GitHub and creating a workspace each take. None when it is malformed or
/// reserved.
pub fn claimable_namespace(value: &str) -> Option<String> {
    let value = value.trim().to_lowercase();
    is_claimable_name(&value).then_some(value)
}

/// A username as someone typed it, if it can be registered: the name
/// everything finds them by (`canonical`, lowercased: URLs, lookups,
/// mentions, git) and the name as they wrote it (`display`, trimmed, its
/// case kept). Letters of either case, digits and single hyphens, not
/// starting or ending with a hyphen, 1 to 39 characters, never reserved
/// in any case. ASCII only, so no other letter lowercases into one.
pub fn claimable_username(value: &str) -> Option<Username> {
    let display = value.trim();
    if !display.is_ascii() {
        return None;
    }
    let canonical = display.to_ascii_lowercase();
    is_claimable_name(&canonical).then(|| Username { canonical, display: display.to_owned() })
}

/// A username in its two forms: see [`claimable_username`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Username {
    /// Lowercased: what it is stored, found, linked and mentioned by.
    pub canonical: String,
    /// As its owner chose to write it: what it is shown as.
    pub display: String,
}

impl Username {
    /// The display form, when it differs from the canonical one: what is
    /// kept beside it (`users.display_username`); none means the same.
    pub fn display_if_cased(&self) -> Option<&str> {
        (self.display != self.canonical).then_some(self.display.as_str())
    }
}

/// Namespaces follow GitHub's rules: letters, digits and single hyphens,
/// not starting or ending with a hyphen, at most 39 characters.
pub fn is_valid_namespace(value: &str) -> bool {
    is_namespace_shaped(value) && !is_reserved_name(value)
}

pub fn is_valid_repo_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && !value.starts_with('.')
        && !value.ends_with(".git")
        // `/<workspace>/-/…` holds the workspace's own pages.
        && value != "-"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g1ts_own_names_are_reserved_in_any_case() {
        for name in ["g1t", "G1T", "g1t-agent", "G1T-Agent", " g1t "] {
            assert!(is_reserved_name(name), "{name}");
            assert_eq!(claimable_namespace(name), None, "{name}");
        }
        assert!(!is_valid_namespace("g1t"));
        assert!(!is_valid_namespace("g1t-agent"));
        assert!(!is_valid_namespace("ghost"));
        assert_eq!(claimable_namespace(" Ghost "), None);
    }

    #[test]
    fn github_action_owners_cannot_be_claimed_but_stay_findable() {
        for name in ["actions", "Actions", " docker ", "aws-actions", "Swatinem"] {
            assert!(is_action_owner_name(name), "{name}");
            assert_eq!(claimable_namespace(name), None, "{name}");
            assert_eq!(claimable_username(name), None, "{name}");
        }
        // An account that has one already is still a valid name to find,
        // mention and invite, can be given one as an alias, and is not
        // protected the way g1t's own names are.
        assert!(is_valid_namespace("actions"));
        assert!(!is_reserved_name("actions"));
        assert_eq!(aliasable_name("Actions").as_deref(), Some("actions"));
        assert!(!is_action_owner_name("actions-team"));
        for owner in ACTION_OWNERS {
            assert!(is_namespace_shaped(owner) && *owner == owner.to_ascii_lowercase(), "{owner}");
        }
    }

    #[test]
    fn names_near_g1ts_are_anyones() {
        assert!(!is_reserved_name("g1t-agents"));
        assert_eq!(claimable_namespace("G1T-Bot").as_deref(), Some("g1t-bot"));
        assert_eq!(claimable_namespace(" Ana ").as_deref(), Some("ana"));
        assert_eq!(claimable_namespace("an--a"), None);
    }

    #[test]
    fn usernames_keep_their_case_and_are_found_without_it() {
        let name = claimable_username(" Octo-Cat ").unwrap();
        assert_eq!(name.canonical, "octo-cat");
        assert_eq!(name.display, "Octo-Cat");
        assert_eq!(name.display_if_cased(), Some("Octo-Cat"));
        let plain = claimable_username("ana").unwrap();
        assert_eq!(plain.display_if_cased(), None);
        assert_eq!(claimable_username("A").unwrap().canonical, "a");
        assert_eq!(claimable_username(&"Z".repeat(39)).unwrap().display.len(), 39);
    }

    #[test]
    fn usernames_follow_the_common_rules_in_any_case() {
        let long = "a".repeat(40);
        for bad in ["", " ", "-Ana", "Ana-", "An--a", "An_a", "Ana.B", "Ana B", long.as_str()] {
            assert_eq!(claimable_username(bad), None, "{bad:?}");
        }
        // Reserved whatever the case: routes and g1t's own.
        for reserved in ["G1T", "G1t-Agent", "Ghost", "Settings", "API", "U"] {
            assert_eq!(claimable_username(reserved), None, "{reserved}");
        }
        // A letter that lowercases into ASCII is not one: the Kelvin sign is not K.
        assert_eq!(claimable_username("\u{212A}elvin"), None);
        assert_eq!(claimable_username("Ana\u{0301}"), None);
    }

    #[test]
    fn g1t_can_be_an_alias_but_a_route_cannot() {
        assert_eq!(aliasable_name(" G1T ").as_deref(), Some("g1t"));
        assert_eq!(aliasable_name("acme-corp").as_deref(), Some("acme-corp"));
        for name in ["settings", "api", "login", "Explore", "Features", "-acme", "ac--me", "acme_inc", "", "a.b"] {
            assert_eq!(aliasable_name(name), None, "{name}");
        }
        assert_eq!(aliasable_name(&"a".repeat(40)), None);
        // Still nobody's to register.
        assert!(is_reserved_name("g1t") && !is_route_name("g1t"));
    }
}
