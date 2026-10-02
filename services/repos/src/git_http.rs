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

/// Sends the request on to the git store and returns its response as is.
pub async fn forward(
    mut request: Request,
    git: &GitRequest,
    access: &GitAccess,
) -> Result<Response> {
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
    if request.method() == Method::Post {
        // Pushes are capped at 100 MB by the platform, so buffering is safe.
        let body = request.bytes().await?;
        init.with_body(Some(Uint8Array::from(body.as_slice()).into()));
    }
    let upstream =
        Request::new_with_init(&format!("{}/{}{query}", access.remote, git.endpoint), &init)?;
    Fetch::Request(upstream).send().await
}
