//! Container image names and registry paths.
//!
//! An image is `g1t.sh/<workspace>/<name>`, where `<name>` may hold `/`.
//! Each part follows the OCI Distribution rules for path components, and
//! the first is a workspace's slug. The routes are the ones the
//! Distribution 1.1 spec lists, under `/v2/`.

use crate::digest::Digest;

/// The longest name a client may give, workspace included.
const MAX_NAME: usize = 255;
/// The longest tag the spec allows.
const MAX_TAG: usize = 128;

/// An image's name, split into its workspace and the rest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageName {
    pub workspace: String,
    /// Without the workspace: `web/api` for `acme/web/api`.
    pub name: String,
}

impl ImageName {
    /// `workspace/name`, as clients write it.
    pub fn full(&self) -> String {
        format!("{}/{}", self.workspace, self.name)
    }

    /// The repository a package of this name links to on its first push:
    /// the name's first part, in the same workspace.
    pub fn repo_name(&self) -> &str {
        self.name.split('/').next().unwrap_or(&self.name)
    }
}

/// Lowercase letters and digits, joined by single `.` or `_`, a double
/// `__`, or any run of `-`.
pub fn valid_component(part: &str) -> bool {
    let bytes = part.as_bytes();
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    if bytes.is_empty() || !alnum(bytes[0]) || !alnum(bytes[bytes.len() - 1]) {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() {
        if alnum(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && !alnum(bytes[i]) {
            i += 1;
        }
        let run = &part[start..i];
        let dashes = run.bytes().all(|b| b == b'-');
        if !(dashes || run == "." || run == "_" || run == "__") {
            return false;
        }
    }
    true
}

/// A workspace slug's shape: lowercase letters, digits and single hyphens.
fn valid_workspace(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 39
        && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--")
}

/// Reads `workspace/name`, or says what is wrong with it.
pub fn parse_name(full: &str) -> Result<ImageName, String> {
    if full.len() > MAX_NAME {
        return Err(format!("An image name is at most {MAX_NAME} characters."));
    }
    let Some((workspace, name)) = full.split_once('/') else {
        return Err("An image name starts with its workspace: g1t.sh/<workspace>/<name>.".to_owned());
    };
    if !valid_workspace(workspace) {
        return Err(format!("{workspace} is not a workspace's name."));
    }
    if name.split('/').any(|part| !valid_component(part)) {
        return Err(format!(
            "{full} is not a valid image name: lowercase letters and digits, separated by `.`, `_`, `__`, `-` or `/`."
        ));
    }
    Ok(ImageName {
        workspace: workspace.to_owned(),
        name: name.to_owned(),
    })
}

/// A tag's shape: a letter, digit or `_`, then up to 127 of those, `.` and `-`.
pub fn valid_tag(tag: &str) -> bool {
    let bytes = tag.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_TAG
        && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// What a manifest is asked for by.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reference {
    Tag(String),
    Digest(Digest),
}

impl Reference {
    pub fn parse(text: &str) -> Option<Reference> {
        if text.contains(':') {
            Digest::parse(text).map(Reference::Digest)
        } else if valid_tag(text) {
            Some(Reference::Tag(text.to_owned()))
        } else {
            None
        }
    }
}

/// One of the registry's endpoints, with the name it is for still unchecked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    /// `/v2/`: whether the client is signed in.
    Base,
    /// `/v2/token`: a bearer token for the scopes asked for.
    Token,
    Manifest { name: String, reference: String },
    Blob { name: String, digest: String },
    /// `/v2/<name>/blobs/uploads/`: starting an upload.
    Uploads { name: String },
    Upload { name: String, id: String },
    Tags { name: String },
    Referrers { name: String, digest: String },
}

/// Which endpoint a path is, if it is one.
pub fn route(path: &str) -> Option<Route> {
    let rest = path.strip_prefix("/v2")?;
    if rest.is_empty() || rest == "/" {
        return Some(Route::Base);
    }
    let rest = rest.strip_prefix('/')?;
    if rest == "token" {
        return Some(Route::Token);
    }
    // The name may hold any of the words below as a part of its own, so
    // the last place one appears is where the name ends.
    let split = |marker: &str| rest.rfind(marker).map(|at| (&rest[..at], &rest[at + marker.len()..]));
    if let Some((name, tail)) = split("/blobs/uploads") {
        let tail = tail.trim_start_matches('/');
        return Some(if tail.is_empty() {
            Route::Uploads { name: name.to_owned() }
        } else if !tail.contains('/') {
            Route::Upload { name: name.to_owned(), id: tail.to_owned() }
        } else {
            return None;
        });
    }
    let one = |tail: &str| (!tail.is_empty() && !tail.contains('/')).then(|| tail.to_owned());
    if let Some((name, tail)) = split("/manifests/") {
        return Some(Route::Manifest { name: name.to_owned(), reference: one(tail)? });
    }
    if let Some((name, tail)) = split("/blobs/") {
        return Some(Route::Blob { name: name.to_owned(), digest: one(tail)? });
    }
    if let Some((name, tail)) = split("/referrers/") {
        return Some(Route::Referrers { name: name.to_owned(), digest: one(tail)? });
    }
    if let Some(name) = rest.strip_suffix("/tags/list") {
        return Some(Route::Tags { name: name.to_owned() });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn components_follow_the_distribution_rules() {
        for good in ["web", "a", "web-api", "web--api", "web.api", "web_api", "web__api", "v1", "0"] {
            assert!(valid_component(good), "{good}");
        }
        for bad in ["", "Web", "-web", "web-", "web..api", "web___api", "web._api", ".web", "web api", "wéb"] {
            assert!(!valid_component(bad), "{bad}");
        }
    }

    #[test]
    fn a_name_starts_with_its_workspace_and_may_have_more_parts() {
        let name = parse_name("acme/web/api").unwrap();
        assert_eq!(name.workspace, "acme");
        assert_eq!(name.name, "web/api");
        assert_eq!(name.repo_name(), "web");
        assert_eq!(name.full(), "acme/web/api");
        assert!(parse_name("acme").unwrap_err().contains("workspace"));
        assert!(parse_name("-acme/web").is_err());
        assert!(parse_name("acme/Web").is_err());
        assert!(parse_name("acme/web/").is_err());
        assert!(parse_name("acme//web").is_err());
        assert!(parse_name(&format!("acme/{}", "a".repeat(260))).is_err());
    }

    #[test]
    fn tags_and_digests_are_told_apart() {
        assert_eq!(Reference::parse("latest"), Some(Reference::Tag("latest".into())));
        assert_eq!(Reference::parse("v1.2.3-rc_1"), Some(Reference::Tag("v1.2.3-rc_1".into())));
        assert!(Reference::parse(".hidden").is_none());
        assert!(Reference::parse(&"a".repeat(129)).is_none());
        let digest = format!("sha256:{}", "a".repeat(64));
        assert!(matches!(Reference::parse(&digest), Some(Reference::Digest(_))));
        assert!(Reference::parse("sha256:short").is_none());
    }

    #[test]
    fn every_endpoint_is_routed() {
        assert_eq!(route("/v2/"), Some(Route::Base));
        assert_eq!(route("/v2"), Some(Route::Base));
        assert_eq!(route("/v2/token"), Some(Route::Token));
        assert_eq!(
            route("/v2/acme/web/manifests/latest"),
            Some(Route::Manifest { name: "acme/web".into(), reference: "latest".into() })
        );
        assert_eq!(
            route("/v2/acme/web/blobs/sha256:abc"),
            Some(Route::Blob { name: "acme/web".into(), digest: "sha256:abc".into() })
        );
        assert_eq!(route("/v2/acme/web/blobs/uploads/"), Some(Route::Uploads { name: "acme/web".into() }));
        assert_eq!(route("/v2/acme/web/blobs/uploads"), Some(Route::Uploads { name: "acme/web".into() }));
        assert_eq!(
            route("/v2/acme/web/blobs/uploads/upl_1"),
            Some(Route::Upload { name: "acme/web".into(), id: "upl_1".into() })
        );
        assert_eq!(route("/v2/acme/a/b/tags/list"), Some(Route::Tags { name: "acme/a/b".into() }));
        assert_eq!(
            route("/v2/acme/web/referrers/sha256:abc"),
            Some(Route::Referrers { name: "acme/web".into(), digest: "sha256:abc".into() })
        );
        // A name with a part that looks like an endpoint's word.
        assert_eq!(
            route("/v2/acme/manifests/manifests/v1"),
            Some(Route::Manifest { name: "acme/manifests".into(), reference: "v1".into() })
        );
        assert_eq!(route("/v2/acme/web/other"), None);
        assert_eq!(route("/acme/web.git/info/refs"), None);
    }
}
