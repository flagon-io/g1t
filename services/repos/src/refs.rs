//! Listing a repository's branches.
//!
//! The Artifacts binding reads commits, trees and blobs but does not list
//! refs, so this asks the way a git client does: the ref advertisement of
//! the smart HTTP protocol.

use g1t_contracts::repos::{Branch, GitAccess};
use worker::{Error, Fetch, Headers, Method, Request, RequestInit, Result};

use crate::land::read_pkt_lines;

const HEADS: &str = "refs/heads/";

/// The branches in a ref advertisement, in the order advertised.
fn parse_advertisement(bytes: &[u8]) -> Vec<Branch> {
    let (lines, _) = read_pkt_lines(bytes);
    lines
        .into_iter()
        .filter_map(|line| {
            // `<hash> <ref>`, and on the first ref a NUL then capabilities.
            let line = line.split(|byte| *byte == 0).next()?;
            let line = std::str::from_utf8(line).ok()?.trim_end();
            let (hash, name) = line.split_once(' ')?;
            Some(Branch {
                name: name.strip_prefix(HEADS)?.to_owned(),
                hash: hash.to_owned(),
            })
        })
        .collect()
}

pub async fn branches(access: &GitAccess) -> Result<Vec<Branch>> {
    let headers = Headers::new();
    headers.set("authorization", &format!("Bearer {}", access.token))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(headers);
    let request = Request::new_with_init(
        &format!("{}/info/refs?service=git-upload-pack", access.remote),
        &init,
    )?;
    let mut response = Fetch::Request(request).send().await?;
    let bytes = response.bytes().await?;
    if response.status_code() != 200 {
        return Err(Error::RustError(format!(
            "listing refs returned {}",
            response.status_code()
        )));
    }
    Ok(parse_advertisement(&bytes))
}

#[cfg(test)]
mod tests {
    use super::parse_advertisement;

    fn pkt(payload: &str) -> Vec<u8> {
        format!("{:04x}{payload}", payload.len() + 4).into_bytes()
    }

    #[test]
    fn branches_are_read_from_an_advertisement() {
        let main = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let shout = "4807077b296e6edbf410d55e72749d3e1170c291";
        let advertisement = [
            pkt("# service=git-upload-pack\n"),
            b"0000".to_vec(),
            pkt(&format!(
                "{main} HEAD\0side-band-64k symref=HEAD:refs/heads/main\n"
            )),
            pkt(&format!("{main} refs/heads/main\n")),
            pkt(&format!("{shout} refs/heads/shout\n")),
            pkt(&format!("{shout} refs/tags/v1.0.0\n")),
            b"0000".to_vec(),
        ]
        .concat();
        let branches = parse_advertisement(&advertisement);
        let names: Vec<&str> = branches.iter().map(|branch| branch.name.as_str()).collect();
        assert_eq!(names, ["main", "shout"]);
        assert_eq!(branches[1].hash, shout);
    }

    #[test]
    fn an_empty_repository_has_no_branches() {
        let advertisement = [pkt("# service=git-upload-pack\n"), b"00000000".to_vec()].concat();
        assert!(parse_advertisement(&advertisement).is_empty());
    }
}
