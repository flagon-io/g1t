//! Image addresses: `g1t.sh/<workspace>/<name>[:<tag>]`.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    /// The registry, `g1t.sh` or a host of your own (`localhost:8790`).
    pub host: String,
    /// The image's name in the registry, `<workspace>/<name>`.
    pub name: String,
    pub tag: String,
}

impl Reference {
    /// Reads an address that names its registry. `None` when the first part
    /// is not a host (a local name like `web:1.0`).
    pub fn parse(text: &str) -> Result<Option<Reference>, String> {
        let text = text.trim();
        if text.contains('@') {
            return Err(format!("`{text}`: push to a tag, not a digest."));
        }
        let Some((host, rest)) = text.split_once('/') else {
            return Ok(None);
        };
        if !(host.contains('.') || host.contains(':') || host == "localhost") {
            return Ok(None);
        }
        // A colon after the last slash starts the tag.
        let (name, tag) = match rest.rsplit_once(':') {
            Some((name, tag)) if !tag.contains('/') => (name, tag),
            _ => (rest, "latest"),
        };
        if name.is_empty() || tag.is_empty() {
            return Err(format!(
                "`{text}` is not an image address, like g1t.sh/<workspace>/<name>:<tag>."
            ));
        }
        if !name.contains('/') && host == "g1t.sh" {
            return Err(format!(
                "`{text}`: images on g1t.sh start with a workspace, like g1t.sh/<workspace>/<name>:<tag>."
            ));
        }
        let valid = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-/".contains(c);
        if !name.chars().all(valid) {
            return Err(format!(
                "`{name}`: image names are lowercase letters and digits, separated by `.`, `_`, `-` or `/`."
            ));
        }
        let valid_tag = |c: char| c.is_ascii_alphanumeric() || "._-".contains(c);
        if tag.len() > 128 || !tag.chars().all(valid_tag) {
            return Err(format!(
                "`{tag}` is not a tag: letters, digits, `.`, `_` and `-`, at most 128."
            ));
        }
        Ok(Some(Reference {
            host: host.to_owned(),
            name: name.to_owned(),
            tag: tag.to_owned(),
        }))
    }

    /// Where the registry answers: plain HTTP on this machine, HTTPS elsewhere.
    pub fn base_url(&self) -> String {
        let local = self.host.starts_with("localhost") || self.host.starts_with("127.0.0.1");
        format!("{}://{}", if local { "http" } else { "https" }, self.host)
    }
}

impl std::fmt::Display for Reference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}:{}", self.host, self.name, self.tag)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Reference {
        Reference::parse(text).unwrap().unwrap()
    }

    #[test]
    fn addresses_split_into_host_name_and_tag() {
        let r = parse("g1t.sh/acme/web:1.4.0");
        assert_eq!(
            (r.host.as_str(), r.name.as_str(), r.tag.as_str()),
            ("g1t.sh", "acme/web", "1.4.0")
        );
        assert_eq!(r.base_url(), "https://g1t.sh");
        assert_eq!(r.to_string(), "g1t.sh/acme/web:1.4.0");
    }

    #[test]
    fn the_tag_defaults_to_latest() {
        assert_eq!(parse("g1t.sh/acme/tools/web").tag, "latest");
    }

    #[test]
    fn a_host_with_a_port_is_not_a_tag() {
        let r = parse("localhost:8790/acme/web");
        assert_eq!(
            (r.host.as_str(), r.name.as_str(), r.tag.as_str()),
            ("localhost:8790", "acme/web", "latest")
        );
        assert_eq!(r.base_url(), "http://localhost:8790");
    }

    #[test]
    fn local_names_have_no_registry() {
        assert_eq!(Reference::parse("web:1.0"), Ok(None));
        assert_eq!(Reference::parse("library/alpine:3.20"), Ok(None));
    }

    #[test]
    fn bad_addresses_are_refused() {
        assert!(Reference::parse("g1t.sh/web:1").is_err());
        assert!(Reference::parse("g1t.sh/Acme/Web:1").is_err());
        assert!(Reference::parse("g1t.sh/acme/web@sha256:00").is_err());
        assert!(Reference::parse("g1t.sh/acme/web:bad tag").is_err());
    }
}
