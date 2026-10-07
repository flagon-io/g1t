/// Routes and reserved words that may not be registered as usernames.
const RESERVED: &[&str] = &[
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
    // g1t itself, and the name its agent once went by: everything g1t
    // does is shown as `g1t`, so nobody else may be called either.
    "g1t",
    "g1t-agent",
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

/// Whether `value`, whatever its case, is a name nobody can register or
/// rename a workspace to: a route, or g1t's own.
pub fn is_reserved_name(value: &str) -> bool {
    let value = value.trim();
    RESERVED.iter().any(|reserved| reserved.eq_ignore_ascii_case(value))
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
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 39
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && !is_reserved_name(value)
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
}
