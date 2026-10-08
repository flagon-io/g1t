//! What people are told when rules refuse a change: `remote:` lines for
//! git, and one sentence for the API and the merge box.

use g1t_contracts::rules::Violation;

use crate::outcome::{Judged, blocking};

/// The `ng` reason git prints beside a refused ref: short, one line.
pub fn ng_reason(judged: &[Judged]) -> String {
    match blocking(judged).first() {
        Some(violation) => format!("declined by ruleset \"{}\" ({})", violation.ruleset_name, violation.rule),
        None => "declined by rules".to_owned(),
    }
}

/// The lines git prints as `remote:` for a push the rules refuse: each
/// broken rule with its ruleset, and how to meet it. `rules_url` is where
/// the branch's rules are shown.
pub fn remote_lines(git_ref: &str, judged: &[Judged], rules_url: &str) -> Vec<String> {
    let violations = blocking(judged);
    let mut lines = vec![
        String::new(),
        format!("error: rules for {git_ref} declined this push:"),
    ];
    let mut last_remedy = String::new();
    for violation in &violations {
        lines.push(format!("- {} [ruleset \"{}\", {}]", violation.message, violation.ruleset_name, violation.rule));
        if !violation.remedy.is_empty() && violation.remedy != last_remedy {
            lines.push(format!("  {}", violation.remedy));
            last_remedy = violation.remedy.clone();
        }
    }
    lines.push(format!("See the rules that hold for it: {rules_url}"));
    lines.push(String::new());
    lines
}

/// One sentence for a refused merge: the first problem, and how many more.
pub fn summary(violations: &[&Violation]) -> Option<String> {
    let first = violations.first()?;
    let more = violations.len() - 1;
    let tail = match more {
        0 => String::new(),
        1 => " One more rule is not met.".to_owned(),
        more => format!(" {more} more rules are not met."),
    };
    Some(format!("{}{tail}", first.message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::rules::{Enforcement, Level};

    fn judged(violations: &[(&str, &str, &str)]) -> Judged {
        Judged {
            id: "rs_1".into(),
            name: "Protect main".into(),
            level: Level::Repository,
            enforcement: Enforcement::Active,
            bypass: None,
            git_ref: "refs/heads/main".into(),
            violations: violations
                .iter()
                .map(|(rule, message, remedy)| Violation {
                    rule: (*rule).into(),
                    ruleset_id: "rs_1".into(),
                    ruleset_name: "Protect main".into(),
                    enforcement: Enforcement::Active,
                    message: (*message).into(),
                    remedy: (*remedy).into(),
                })
                .collect(),
            merging: false,
        }
    }

    #[test]
    fn git_is_told_which_ruleset_and_rule_and_what_to_do() {
        let refused = [judged(&[
            ("pull_request", "Changes to main must be made through a pull request.", "Push a branch and open a pull request."),
            ("non_fast_forward", "Force pushes to main are blocked.", "Pull, then push without --force."),
        ])];
        assert_eq!(ng_reason(&refused), "declined by ruleset \"Protect main\" (pull_request)");
        let lines = remote_lines("refs/heads/main", &refused, "https://g1t.sh/acme/web/settings/rules?branch=main");
        assert_eq!(
            lines,
            vec![
                "",
                "error: rules for refs/heads/main declined this push:",
                "- Changes to main must be made through a pull request. [ruleset \"Protect main\", pull_request]",
                "  Push a branch and open a pull request.",
                "- Force pushes to main are blocked. [ruleset \"Protect main\", non_fast_forward]",
                "  Pull, then push without --force.",
                "See the rules that hold for it: https://g1t.sh/acme/web/settings/rules?branch=main",
                "",
            ]
        );
    }

    #[test]
    fn a_merge_refusal_is_one_sentence() {
        let refused = judged(&[("pull_request", "It needs 2 approving reviews; it has 0.", ""), ("merge_window", "Merging is frozen.", "")]);
        assert_eq!(summary(&blocking(&[refused]).to_vec()).as_deref(), Some("It needs 2 approving reviews; it has 0. One more rule is not met."));
        assert_eq!(summary(&[]), None);
    }
}
