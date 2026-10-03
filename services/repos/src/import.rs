//! Importing a repository from another git host.
//!
//! g1t fetches the default branch the way a git client would, over smart
//! HTTP, and pushes the pack it receives into a new repository unchanged.
//! Only public repositories reachable over https can be imported, and only
//! their default branch.

use futures_util::StreamExt;
use worker::js_sys::Uint8Array;
use worker::{Fetch, Headers, Method, Request, RequestInit, Result, Url};

use crate::land::{read_pkt_lines, unpack_sideband};

/// The largest pack that is imported. A Worker holds the pack in memory
/// twice while relaying it.
const MAX_PACK_BYTES: usize = 40 * 1024 * 1024;
const HEADS: &str = "refs/heads/";
/// Some hosts only speak the smart protocol to something that says it is git.
const USER_AGENT: &str = "git/2.45.0 (g1t import)";

/// What the other host says its default branch is and where it points.
#[derive(Debug, PartialEq, Eq)]
pub struct Remote {
    pub branch: String,
    pub head: String,
}

/// The address to import from, tidied, or `None` if it is not one g1t will
/// fetch: it must be https, with no credentials in it.
pub fn clean_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url.trim()).ok()?;
    let plain = parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.host_str().is_some()
        && parsed.query().is_none();
    if !plain {
        return None;
    }
    let host = parsed.host_str()?;
    let path = parsed.path().trim_end_matches('/');
    (path.len() > 1).then(|| format!("https://{host}{path}"))
}

/// The default branch and its head, from a ref advertisement.
fn parse_remote(bytes: &[u8]) -> Option<Remote> {
    let (lines, _) = read_pkt_lines(bytes);
    let mut head = None;
    let mut branch = None;
    let mut branches = Vec::new();
    for line in lines {
        let mut parts = line.splitn(2, |byte| *byte == 0);
        let reference = std::str::from_utf8(parts.next()?).ok()?.trim_end();
        // The first ref carries the capabilities, one of which names the
        // branch HEAD points to.
        if let Some(capabilities) = parts
            .next()
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
        {
            branch = capabilities
                .split(' ')
                .find_map(|capability| capability.trim().strip_prefix("symref=HEAD:refs/heads/"))
                .map(str::to_owned);
        }
        let Some((hash, name)) = reference.split_once(' ') else {
            continue;
        };
        if name == "HEAD" {
            head = Some(hash.to_owned());
        } else if let Some(name) = name.strip_prefix(HEADS) {
            branches.push((name.to_owned(), hash.to_owned()));
        }
    }
    // Without a symref, the branch HEAD agrees with; failing that, main.
    let branch = branch.or_else(|| {
        let head = head.as_deref()?;
        branches
            .iter()
            .find(|(_, hash)| hash == head)
            .map(|(name, _)| name.clone())
    })?;
    let head = branches
        .iter()
        .find(|(name, _)| *name == branch)
        .map(|(_, hash)| hash.clone())
        .or(head)?;
    Some(Remote { branch, head })
}

fn request(method: Method, url: &str, body: Option<Vec<u8>>) -> Result<Request> {
    let headers = Headers::new();
    headers.set("user-agent", USER_AGENT)?;
    if body.is_some() {
        headers.set("content-type", "application/x-git-upload-pack-request")?;
        headers.set("accept", "application/x-git-upload-pack-result")?;
    }
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(Uint8Array::from(body.as_slice()).into()));
    }
    Request::new_with_init(url, &init)
}

/// Asks the other host what it has. `Err` in the inner result is a reason
/// to show the person importing.
pub async fn discover(url: &str) -> Result<std::result::Result<Remote, String>> {
    let request = request(
        Method::Get,
        &format!("{url}/info/refs?service=git-upload-pack"),
        None,
    )?;
    let mut response = match Fetch::Request(request).send().await {
        Ok(response) => response,
        Err(_) => return Ok(Err("That address could not be reached.".to_owned())),
    };
    if response.status_code() != 200 {
        return Ok(Err(
            "No public git repository was found at that address. Private repositories cannot be imported."
                .to_owned(),
        ));
    }
    let bytes = response.bytes().await?;
    Ok(parse_remote(&bytes).ok_or_else(|| "That repository is empty.".to_owned()))
}

/// Fetches a pack holding everything reachable from `head`.
pub async fn fetch(url: &str, head: &str) -> Result<std::result::Result<Vec<u8>, String>> {
    let mut body = format!("{:04x}want {head} side-band-64k\n", head.len() + 24).into_bytes();
    body.extend_from_slice(b"00000009done\n");
    let request = request(Method::Post, &format!("{url}/git-upload-pack"), Some(body))?;
    let mut response = Fetch::Request(request).send().await?;
    if response.status_code() != 200 {
        return Ok(Err(
            "The other host refused to send the repository.".to_owned()
        ));
    }
    // Read in pieces, so a repository that is too large is noticed before
    // it has all been held in memory.
    let mut received = Vec::new();
    let mut stream = response.stream()?;
    while let Some(chunk) = stream.next().await {
        received.extend_from_slice(&chunk?);
        if received.len() > MAX_PACK_BYTES {
            return Ok(Err(format!(
                "That repository is larger than {} MB, the most that can be imported. Push it with git instead.",
                MAX_PACK_BYTES / 1024 / 1024
            )));
        }
    }
    Ok(unpack_sideband(&received)
        .map_err(|_| "The other host did not send a usable pack.".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(payload: &str) -> Vec<u8> {
        format!("{:04x}{payload}", payload.len() + 4).into_bytes()
    }

    #[test]
    fn only_plain_https_addresses_are_fetched() {
        assert_eq!(
            clean_url(" https://github.com/syntaqx/hello/ ").as_deref(),
            Some("https://github.com/syntaqx/hello")
        );
        assert_eq!(
            clean_url("https://github.com/syntaqx/hello.git").as_deref(),
            Some("https://github.com/syntaqx/hello.git")
        );
        for bad in [
            "http://github.com/a/b",
            "git@github.com:a/b.git",
            "https://user:secret@github.com/a/b",
            "https://github.com",
            "https://github.com/a/b?x=1",
            "not a url",
        ] {
            assert_eq!(clean_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_default_branch_comes_from_the_symref() {
        let trunk = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let other = "4807077b296e6edbf410d55e72749d3e1170c291";
        let advertisement = [
            pkt("# service=git-upload-pack\n"),
            b"0000".to_vec(),
            pkt(&format!(
                "{trunk} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/trunk agent=git/x\n"
            )),
            pkt(&format!("{other} refs/heads/feature\n")),
            pkt(&format!("{trunk} refs/heads/trunk\n")),
            b"0000".to_vec(),
        ]
        .concat();
        assert_eq!(
            parse_remote(&advertisement),
            Some(Remote {
                branch: "trunk".to_owned(),
                head: trunk.to_owned()
            })
        );
    }

    #[test]
    fn without_a_symref_the_branch_head_points_to_is_used() {
        let main = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let advertisement = [
            pkt("# service=git-upload-pack\n"),
            b"0000".to_vec(),
            pkt(&format!("{main} HEAD\0side-band-64k\n")),
            pkt(&format!("{main} refs/heads/main\n")),
            b"0000".to_vec(),
        ]
        .concat();
        assert_eq!(parse_remote(&advertisement).unwrap().branch, "main");
        let empty = [pkt("# service=git-upload-pack\n"), b"00000000".to_vec()].concat();
        assert_eq!(parse_remote(&empty), None);
    }
}
