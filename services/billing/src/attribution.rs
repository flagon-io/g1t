//! Whose work a usage line is: the agent that did it, by handle, and the
//! person who asked, by username. Both are written on the run
//! (`start_run`) and copied onto every ledger line it makes, and on an
//! agent's sandbox time (`record_sandbox`), so Spend's "by agent" and "by
//! person" are read from the one ledger that is charged
//! (`report::attribution`), never from a second count.

/// A handle or username as the ledger stores it: lowercase, without a
/// leading `@`; none when empty.
pub(crate) fn handle(given: Option<&str>) -> Option<String> {
    let name = given?.trim().trim_start_matches('@').to_lowercase();
    (!name.is_empty()).then_some(name)
}

/// The agent a run is attributed to: the one the caller names; else the
/// one a run billed under `<workspace>/@<handle>` names (the agents
/// service's replies and sessions; no repository has an `@` in its name);
/// else g1t's own agent at work on a repository, which all shows as @g1t.
pub(crate) fn agent_of(given: Option<&str>, repo_name: &str) -> Option<String> {
    handle(given).or_else(|| repo_name.strip_prefix('@').and_then(|h| handle(Some(h)))).or_else(|| Some("g1t".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_is_the_agent_named_or_the_one_it_is_billed_under_or_g1t() {
        assert_eq!(agent_of(Some("Mike"), "@mike").as_deref(), Some("mike"));
        assert_eq!(agent_of(None, "@margo").as_deref(), Some("margo"));
        assert_eq!(agent_of(Some(" "), "@margo").as_deref(), Some("margo"));
        assert_eq!(agent_of(None, "g1t").as_deref(), Some("g1t"));
        assert_eq!(agent_of(Some("@g1t"), "api").as_deref(), Some("g1t"));
    }

    #[test]
    fn who_asked_is_a_username_or_no_one() {
        assert_eq!(handle(Some("@Chase")).as_deref(), Some("chase"));
        assert_eq!(handle(Some("")), None);
        assert_eq!(handle(None), None);
    }
}
