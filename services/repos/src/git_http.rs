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

/// `url` with its first path segment, the workspace, replaced by `slug`.
pub fn with_namespace(url: &Url, slug: &str) -> Option<String> {
    let rest = url.path().strip_prefix('/')?.split_once('/')?.1;
    let mut moved = url.clone();
    moved.set_path(&format!("/{slug}/{rest}"));
    Some(moved.to_string())
}

/// Where a git request for a renamed workspace's old address should go
/// now, if its first segment is an old slug that still redirects.
pub async fn renamed(url: &Url, identity: &Fetcher) -> Result<Option<String>> {
    let Some(old) = url.path().strip_prefix('/').and_then(|path| path.split('/').next()) else {
        return Ok(None);
    };
    let current: Option<String> = g1t_kit::call(
        identity,
        "resolve_slug",
        &g1t_contracts::identity::SlugArgs {
            slug: old.to_owned(),
        },
    )
    .await?;
    Ok(current.and_then(|slug| with_namespace(url, &slug)))
}

/// A permanent redirect: 301 for git's first request for refs, which it
/// follows and then uses the new address for the rest; 308 for the
/// others, so a POST stays a POST.
pub fn moved(location: &str, get: bool) -> Result<Response> {
    let mut response = Response::empty()?.with_status(if get { 301 } else { 308 });
    response.headers_mut().set("location", location)?;
    Ok(response)
}

const ZERO_ID: &str = "0000000000000000000000000000000000000000";
const HEADS: &str = "refs/heads/";
const TAGS: &str = "refs/tags/";

/// One ref a push asks to change.
struct Command {
    old: String,
    new: String,
    name: String,
}

/// The commands at the start of a receive-pack request, and the
/// capabilities the client sent with the first of them.
fn commands(body: &[u8]) -> (Vec<Command>, String) {
    let mut commands = Vec::new();
    let mut capabilities = String::new();
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
        let mut halves = line.splitn(2, |byte| *byte == 0);
        let command = halves.next().unwrap_or_default();
        if let Some(rest) = halves.next() {
            capabilities = String::from_utf8_lossy(rest).trim().to_owned();
        }
        let Ok(command) = std::str::from_utf8(command) else {
            continue;
        };
        let mut parts = command.trim_end().splitn(3, ' ');
        if let (Some(old), Some(new), Some(name)) = (parts.next(), parts.next(), parts.next()) {
            commands.push(Command {
                old: old.to_owned(),
                new: new.to_owned(),
                name: name.to_owned(),
            });
        }
    }
    (commands, capabilities)
}

fn pkt_line(payload: &[u8]) -> Vec<u8> {
    let mut line = format!("{:04x}", payload.len() + 4).into_bytes();
    line.extend_from_slice(payload);
    line
}

/// What git is told when a push would change a protected branch: every ref
/// in it is declined, with the reason against the protected one, so that
/// git prints it beside the branch. `None` if the push leaves the branch
/// alone, or creates it in a repository that does not have it yet.
fn refusal(body: &[u8], protected: &str) -> Option<Vec<u8>> {
    let (commands, capabilities) = commands(body);
    let reference = format!("{HEADS}{protected}");
    if !commands
        .iter()
        .any(|command| command.name == reference && command.old != ZERO_ID)
    {
        return None;
    }
    let mut report = pkt_line(b"unpack ok\n");
    for command in &commands {
        let reason = if command.name == reference {
            format!("{protected} is protected: push a branch and open a pull request")
        } else {
            format!("not pushed, because the same push would change {protected}")
        };
        report.extend(pkt_line(
            format!("ng {} {reason}\n", command.name).as_bytes(),
        ));
    }
    report.extend_from_slice(b"0000");
    // With side-band the report travels inside channel 1.
    let sideband = capabilities
        .split(' ')
        .any(|capability| capability.starts_with("side-band"));
    Some(if sideband {
        let mut framed = vec![1u8];
        framed.extend(report);
        let mut body = pkt_line(&framed);
        body.extend_from_slice(b"0000");
        body
    } else {
        report
    })
}

/// A branch or tag a push asks to move.
#[derive(Debug, PartialEq, Eq)]
pub struct Pushed {
    /// The full ref: `refs/heads/main`, `refs/tags/v1`.
    pub git_ref: String,
    /// Where it pointed before; `None` for a new ref.
    pub before: Option<String>,
    pub after: String,
}

impl Pushed {
    pub fn branch(&self) -> Option<&str> {
        self.git_ref.strip_prefix(HEADS)
    }
}

/// The branches and tags a push asks to move, read from the commands at the
/// start of a receive-pack request. Deletions and other refs are left out.
fn pushed_branches(body: &[u8]) -> Vec<Pushed> {
    commands(body)
        .0
        .into_iter()
        .filter(|command| command.new != ZERO_ID)
        .filter(|command| command.name.starts_with(HEADS) || command.name.starts_with(TAGS))
        .map(|Command { old, new, name }| Pushed {
            git_ref: name,
            before: (old != ZERO_ID).then_some(old),
            after: new,
        })
        .collect()
}

/// The git store's answer, and what the request asked it to change.
pub struct Forwarded {
    pub response: Response,
    /// For a push: the branches and tags it asks to move, and the commits
    /// to move them to. Whether each moved is for the caller to confirm.
    pub pushed: Vec<Pushed>,
}

/// What became of a git request.
pub enum Push {
    Forwarded(Forwarded),
    /// A push to a protected branch, answered here without reaching the store.
    Refused(Response),
}

/// Sends the request on to the git store and returns its response as is,
/// unless it is a push that would change the `protected` branch.
pub async fn forward(
    mut request: Request,
    git: &GitRequest,
    access: &GitAccess,
    protected: Option<&str>,
) -> Result<Push> {
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
            if let Some(report) = protected.and_then(|branch| refusal(&body, branch)) {
                let headers = Headers::new();
                headers.set("content-type", "application/x-git-receive-pack-result")?;
                headers.set("cache-control", "no-cache")?;
                return Ok(Push::Refused(
                    Response::from_bytes(report)?.with_headers(headers),
                ));
            }
            pushed = pushed_branches(&body);
        }
        init.with_body(Some(Uint8Array::from(body.as_slice()).into()));
    }
    let upstream =
        Request::new_with_init(&format!("{}/{}{query}", access.remote, git.endpoint), &init)?;
    Ok(Push::Forwarded(Forwarded {
        response: Fetch::Request(upstream).send().await?,
        pushed,
    }))
}

#[cfg(test)]
mod tests {
    use super::{Pushed, ZERO_ID, pushed_branches, refusal, with_namespace};

    #[test]
    fn a_renamed_workspace_keeps_the_rest_of_the_address() {
        let url = worker::Url::parse(
            "https://g1t.sh/acme/rocket.git/info/refs?service=git-upload-pack",
        )
        .unwrap();
        assert_eq!(
            with_namespace(&url, "acme-inc").as_deref(),
            Some("https://g1t.sh/acme-inc/rocket.git/info/refs?service=git-upload-pack")
        );
        let bare = worker::Url::parse("https://g1t.sh/acme").unwrap();
        assert_eq!(with_namespace(&bare, "acme-inc"), None);
    }

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
                Pushed {
                    git_ref: "refs/heads/main".to_owned(),
                    before: Some(old.to_owned()),
                    after: new.to_owned()
                },
                Pushed {
                    git_ref: "refs/heads/feature/x".to_owned(),
                    before: None,
                    after: new.to_owned()
                },
                Pushed {
                    git_ref: "refs/tags/v1".to_owned(),
                    before: None,
                    after: new.to_owned()
                },
            ]
        );
    }

    #[test]
    fn a_push_to_a_protected_branch_is_declined_with_the_reason() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        let body = [
            pkt(&format!("{old} {new} refs/heads/main\0 report-status\n")),
            pkt(&format!("{ZERO_ID} {new} refs/heads/feature\n")),
            b"0000".to_vec(),
        ]
        .concat();
        let report = String::from_utf8(refusal(&body, "main").unwrap()).unwrap();
        assert!(report.starts_with("000eunpack ok\n"));
        assert!(report.contains("ng refs/heads/main main is protected"));
        assert!(report.contains("ng refs/heads/feature not pushed"));
        assert!(report.ends_with("0000"));
    }

    #[test]
    fn the_report_is_framed_for_a_client_that_asked_for_side_band() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let body = [
            pkt(&format!(
                "{old} {ZERO_ID} refs/heads/main\0 report-status side-band-64k\n"
            )),
            b"0000".to_vec(),
        ]
        .concat();
        let report = refusal(&body, "main").unwrap();
        // A length, then channel 1, then the report itself.
        assert_eq!(report[4], 1);
        assert_eq!(&report[5..18], b"000eunpack ok");
        assert!(report.ends_with(b"00000000"));
    }

    #[test]
    fn other_branches_and_a_first_push_are_let_through() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        let feature = [
            pkt(&format!("{old} {new} refs/heads/feature\0 report-status\n")),
            b"0000".to_vec(),
        ]
        .concat();
        assert!(refusal(&feature, "main").is_none());
        // An empty repository has to be able to receive its first commits.
        let first = [
            pkt(&format!(
                "{ZERO_ID} {new} refs/heads/main\0 report-status\n"
            )),
            b"0000".to_vec(),
        ]
        .concat();
        assert!(refusal(&first, "main").is_none());
    }

    #[test]
    fn a_fetch_request_names_no_branches() {
        assert!(
            pushed_branches(b"0032want c71546fcd893ef8b0f57388b65e620d759705dda\n0000").is_empty()
        );
    }
}
