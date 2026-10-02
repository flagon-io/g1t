//! Git over HTTPS: the smart HTTP remote at `/<namespace>/<repo>.git`,
//! proxied to the git store with a short-lived token.

use g1t_contracts::identity::GitCredentialsArgs;
use g1t_contracts::repos::{GitAccess, GitService, RepoPath};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use worker::js_sys::Uint8Array;
use worker::{Fetch, Fetcher, Headers, Method, Request, RequestInit, Response, Result, Url};

const ENDPOINTS: [&str; 3] = ["info/refs", "git-upload-pack", "git-receive-pack"];
const FORWARDED_HEADERS: [&str; 5] = [
    "accept",
    "content-encoding",
    "content-type",
    "git-protocol",
    "user-agent",
];

/// A git request, parsed from its URL.
pub struct GitRequest {
    pub path: RepoPath,
    pub endpoint: &'static str,
    pub service: GitService,
}

/// Parses `/<namespace>/<name>[.git]/<endpoint>`, or returns `None` if the
/// request is not git's.
pub fn parse(url: &Url) -> Option<GitRequest> {
    let path = url.path().strip_prefix('/')?;
    let endpoint = ENDPOINTS
        .into_iter()
        .find(|endpoint| path.ends_with(&format!("/{endpoint}")))?;
    let repo = &path[..path.len() - endpoint.len() - 1];
    let (namespace, name) = repo.split_once('/')?;
    let name = name.strip_suffix(".git").unwrap_or(name);
    if namespace.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    let service = if endpoint == "info/refs" {
        url.query_pairs()
            .find(|(key, _)| key == "service")
            .map(|(_, value)| value.into_owned())?
    } else {
        endpoint.to_owned()
    };
    let service = match service.as_str() {
        "git-upload-pack" => GitService::UploadPack,
        "git-receive-pack" => GitService::ReceivePack,
        _ => return None,
    };
    Some(GitRequest {
        path: RepoPath {
            namespace: namespace.to_owned(),
            name: name.to_owned(),
        },
        endpoint,
        service,
    })
}

/// The user named by an HTTP Basic `Authorization` header, as git sends it.
pub async fn viewer(request: &Request, identity: &Fetcher) -> Result<Viewer> {
    let Some(header) = request.headers().get("authorization")? else {
        return Ok(None);
    };
    let Some((scheme, encoded)) = header.split_once(' ') else {
        return Ok(None);
    };
    if !scheme.eq_ignore_ascii_case("basic") {
        return Ok(None);
    }
    let Some(decoded) = decode_base64(encoded.trim()) else {
        return Ok(None);
    };
    let Some((username, secret)) = decoded.split_once(':') else {
        return Ok(None);
    };
    g1t_kit::call(
        identity,
        "user_for_git_credentials",
        &GitCredentialsArgs {
            username: username.to_owned(),
            secret: secret.to_owned(),
        },
    )
    .await
}

/// Standard base64 to a UTF-8 string, or `None` if either step fails.
fn decode_base64(input: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in input.bytes().filter(|byte| *byte != b'=') {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
        }
    }
    String::from_utf8(bytes).ok()
}

/// The response for a refused git request. Anonymous callers are asked to
/// authenticate, which is what makes git prompt for credentials.
pub fn refuse<T>(outcome: Outcome<T>) -> Result<Response> {
    let Outcome::Fail(failure) = outcome else {
        return Response::error("Not found", 404);
    };
    let mut response = Response::error(failure.message, failure.code.http_status())?;
    if failure.code == FailureCode::Unauthenticated {
        response
            .headers_mut()
            .set("www-authenticate", "Basic realm=\"g1t\"")?;
    }
    Ok(response)
}

const ZERO_ID: &str = "0000000000000000000000000000000000000000";
const HEADS: &str = "refs/heads/";

/// The branches a push asks to move, as `(branch, new commit)`, read from
/// the commands at the start of a receive-pack request. Deletions and refs
/// that are not branches are left out.
fn pushed_branches(body: &[u8]) -> Vec<(String, String)> {
    let mut branches = Vec::new();
    let mut position = 0;
    // Commands are pkt-lines; a flush packet ends them and the pack follows.
    while let Some(length) = body
        .get(position..position + 4)
        .and_then(|hex| std::str::from_utf8(hex).ok())
        .and_then(|hex| usize::from_str_radix(hex, 16).ok())
    {
        if length < 4 || position + length > body.len() {
            break;
        }
        let line = &body[position + 4..position + length];
        position += length;
        // `<old> <new> <ref>`, and on the first command a NUL then capabilities.
        let line = line.split(|byte| *byte == 0).next().unwrap_or_default();
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        let mut parts = line.trim_end().splitn(3, ' ');
        let (Some(_old), Some(new), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if let Some(branch) = name.strip_prefix(HEADS)
            && new != ZERO_ID
        {
            branches.push((branch.to_owned(), new.to_owned()));
        }
    }
    branches
}

/// The git store's answer, and what the request asked it to change.
pub struct Forwarded {
    pub response: Response,
    /// For a push: the branches it asks to move and the commits to move
    /// them to. Whether each moved is for the caller to confirm.
    pub pushed: Vec<(String, String)>,
}

/// Sends the request on to the git store and returns its response as is.
pub async fn forward(
    mut request: Request,
    git: &GitRequest,
    access: &GitAccess,
) -> Result<Forwarded> {
    let headers = Headers::new();
    headers.set("authorization", &format!("Bearer {}", access.token))?;
    for name in FORWARDED_HEADERS {
        if let Some(value) = request.headers().get(name)? {
            headers.set(name, &value)?;
        }
    }
    let query = request
        .url()?
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let mut init = RequestInit::new();
    init.with_method(request.method()).with_headers(headers);
    let mut pushed = Vec::new();
    if request.method() == Method::Post {
        // Pushes are capped at 100 MB by the platform, so buffering is safe.
        let body = request.bytes().await?;
        if git.endpoint == "git-receive-pack" {
            pushed = pushed_branches(&body);
        }
        init.with_body(Some(Uint8Array::from(body.as_slice()).into()));
    }
    let upstream =
        Request::new_with_init(&format!("{}/{}{query}", access.remote, git.endpoint), &init)?;
    Ok(Forwarded {
        response: Fetch::Request(upstream).send().await?,
        pushed,
    })
}

#[cfg(test)]
mod tests {
    use super::{ZERO_ID, pushed_branches};

    fn pkt(payload: &str) -> Vec<u8> {
        format!("{:04x}{payload}", payload.len() + 4).into_bytes()
    }

    #[test]
    fn pushed_branches_are_read_from_the_commands() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        let body = [
            pkt(&format!(
                "{old} {new} refs/heads/main\0 report-status side-band-64k\n"
            )),
            pkt(&format!("{ZERO_ID} {new} refs/heads/feature/x\n")),
            pkt(&format!("{old} {ZERO_ID} refs/heads/gone\n")),
            pkt(&format!("{ZERO_ID} {new} refs/tags/v1\n")),
            b"0000".to_vec(),
            b"PACK\0\0\0\x02\0\0\0\0".to_vec(),
        ]
        .concat();
        assert_eq!(
            pushed_branches(&body),
            [
                ("main".to_owned(), new.to_owned()),
                ("feature/x".to_owned(), new.to_owned()),
            ]
        );
    }

    #[test]
    fn a_fetch_request_names_no_branches() {
        assert!(
            pushed_branches(b"0032want c71546fcd893ef8b0f57388b65e620d759705dda\n0000").is_empty()
        );
    }
}
