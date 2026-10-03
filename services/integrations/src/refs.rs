//! Finding references to outside things in text: `TECH-1234`, a Jira or
//! Linear address, a Sentry issue's address.

/// One reference, as written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reference {
    /// A ticket key, `TECH-1234`, bare or from a Jira or Linear address.
    /// `from` says which system the address was, when there was one.
    Key { key: String, from: Option<Source> },
    /// A Sentry issue, by its numeric id, from its address.
    SentryIssue { id: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Jira,
    Linear,
}

/// Whether `word` is a ticket key: a project of 2 to 10 capital letters or
/// digits starting with a letter, a dash, and a number.
pub fn as_key(word: &str) -> Option<String> {
    let (project, number) = word.split_once('-')?;
    let project_ok = (2..=10).contains(&project.len())
        && project.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && project.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    let number_ok = (1..=7).contains(&number.len()) && number.chars().all(|c| c.is_ascii_digit());
    (project_ok && number_ok).then(|| word.to_owned())
}

/// The project part of a key: `TECH` in `TECH-1234`.
pub fn project(key: &str) -> &str {
    key.split_once('-').map_or(key, |(project, _)| project)
}

fn from_url(url: &str) -> Option<Reference> {
    let path_segments: Vec<&str> = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let host = path_segments.get(1).copied().unwrap_or_default().to_ascii_lowercase();
    let after = |name: &str| {
        path_segments
            .iter()
            .position(|segment| *segment == name)
            .and_then(|at| path_segments.get(at + 1).copied())
    };
    if host == "linear.app" || host.ends_with(".linear.app") {
        let key = as_key(after("issue")?)?;
        return Some(Reference::Key {
            key,
            from: Some(Source::Linear),
        });
    }
    if host == "sentry.io" || host.ends_with(".sentry.io") {
        let id = after("issues")?;
        return id.chars().all(|c| c.is_ascii_digit()).then(|| Reference::SentryIssue { id: id.to_owned() });
    }
    // Jira, wherever it is hosted: `/browse/TECH-1234`.
    let key = as_key(after("browse")?)?;
    Some(Reference::Key {
        key,
        from: Some(Source::Jira),
    })
}

/// Every reference in `text`, in order, each once.
pub fn find(text: &str) -> Vec<Reference> {
    let mut found: Vec<Reference> = Vec::new();
    let mut push = |reference: Reference| {
        let seen = found.iter().any(|existing| match (existing, &reference) {
            (Reference::Key { key: a, .. }, Reference::Key { key: b, .. }) => a == b,
            _ => *existing == reference,
        });
        if !seen {
            found.push(reference);
        }
    };
    for word in text.split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | '[' | ']' | '<' | '>' | '"' | '\'' | '`' | ',' | ';')) {
        let word = word.trim_end_matches(['.', ':', '!', '?']);
        if word.starts_with("https://") || word.starts_with("http://") {
            if let Some(reference) = from_url(word) {
                push(reference);
            }
        } else if let Some(key) = as_key(word) {
            push(Reference::Key { key, from: None });
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(key: &str, from: Option<Source>) -> Reference {
        Reference::Key {
            key: key.to_owned(),
            from,
        }
    }

    #[test]
    fn bare_keys_are_found_once() {
        assert_eq!(
            find("I need to accomplish TECH-1234, see also (OPS-7) and TECH-1234."),
            vec![key("TECH-1234", None), key("OPS-7", None)]
        );
    }

    #[test]
    fn things_that_only_look_like_keys_are_not() {
        assert!(find("UTF-8 is fine, so is A-1, x-12 and SHA-256abc").iter().all(|r| *r == key("UTF-8", None)));
        assert!(find("covid-19 and ISO-8601-2").is_empty());
    }

    #[test]
    fn addresses_say_which_system() {
        assert_eq!(
            find("https://acme.atlassian.net/browse/TECH-12?focusedCommentId=3"),
            vec![key("TECH-12", Some(Source::Jira))]
        );
        assert_eq!(
            find("https://linear.app/acme/issue/ENG-42/fix-the-thing"),
            vec![key("ENG-42", Some(Source::Linear))]
        );
        assert_eq!(
            find("Broke in https://acme.sentry.io/issues/4509812345/?project=1"),
            vec![Reference::SentryIssue {
                id: "4509812345".to_owned()
            }]
        );
        assert_eq!(
            find("https://sentry.io/organizations/acme/issues/77/"),
            vec![Reference::SentryIssue { id: "77".to_owned() }]
        );
    }

    #[test]
    fn the_project_is_the_part_before_the_dash() {
        assert_eq!(project("TECH-1234"), "TECH");
    }
}
