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
    "pulls",
    "issues",
    "oauth",
    "assets",
    "avatars",
    "docs",
    "explore",
    "g1t",
    "about",
    "pricing",
    "terms",
    "privacy",
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
];

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
        && !RESERVED.contains(&value)
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
