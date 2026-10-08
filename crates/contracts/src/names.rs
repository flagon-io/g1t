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
    // g1t.sh/invite/<code>: invite links; and the waitlist.
    "invite",
    "invites",
    "waitlist",
    // g1t.sh/v2/: the container registry; `-` paths hold the others.
    "v2",
    // g1t.sh/inbox, and the name it might also go by.
    "inbox",
    "notifications",
];

/// g1t itself, and the name its agent once went by: everything g1t does is
/// shown as `g1t`, so nobody else may be called either. Not routes: staff
/// may point one at a workspace as an alias (identity's `aliases.rs`).
const OWN: &[&str] = &["g1t", "g1t-agent"];

/// Whether `value`, whatever its case, is a name nobody can register or
/// rename a workspace to: a route, or g1t's own.
pub fn is_reserved_name(value: &str) -> bool {
    is_route_name(value) || OWN.iter().any(|own| own.eq_ignore_ascii_case(value.trim()))
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
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
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
    is_valid_namespace(&value).then_some(value)
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
    }

    #[test]
    fn names_near_g1ts_are_anyones() {
        assert!(!is_reserved_name("g1t-agents"));
        assert_eq!(claimable_namespace("G1T-Bot").as_deref(), Some("g1t-bot"));
        assert_eq!(claimable_namespace(" Ana ").as_deref(), Some("ana"));
        assert_eq!(claimable_namespace("an--a"), None);
    }

    #[test]
    fn g1t_can_be_an_alias_but_a_route_cannot() {
        assert_eq!(aliasable_name(" G1T ").as_deref(), Some("g1t"));
        assert_eq!(aliasable_name("acme-corp").as_deref(), Some("acme-corp"));
        for name in ["settings", "api", "login", "Explore", "-acme", "ac--me", "acme_inc", "", "a.b"] {
            assert_eq!(aliasable_name(name), None, "{name}");
        }
        assert_eq!(aliasable_name(&"a".repeat(40)), None);
        // Still nobody's to register.
        assert!(is_reserved_name("g1t") && !is_route_name("g1t"));
    }
}
