//! Pattern rules: whether a commit message, an email address, or a branch
//! or tag name is as a rule asks.
//!
//! Regular expressions run on the `regex` crate's engine, which takes time
//! in proportion to the text and never backtracks, so no pattern can make a
//! push slow. Look-around and back-references are not supported, and a
//! pattern that would compile to more than [`SIZE_LIMIT`] is refused.

use g1t_contracts::rules::{PatternOperator, PatternRule};
use regex::{Regex, RegexBuilder};

/// The most memory one compiled pattern may take.
pub const SIZE_LIMIT: usize = 1 << 20;
/// The most of a text a pattern is tested on.
pub const MAX_TEXT: usize = 64 * 1024;

/// A pattern rule, ready to test texts.
pub struct Compiled {
    rule: PatternRule,
    regex: Option<Regex>,
}

/// Compiles a rule's pattern, or says why it cannot be.
pub fn compile(rule: &PatternRule) -> Result<Compiled, String> {
    let regex = match rule.operator {
        PatternOperator::Regex => Some(
            RegexBuilder::new(&rule.pattern)
                .size_limit(SIZE_LIMIT)
                .dfa_size_limit(SIZE_LIMIT)
                .build()
                .map_err(|error| match error {
                    regex::Error::CompiledTooBig(_) => "The regular expression is too large.".to_owned(),
                    other => format!("The regular expression is not valid: {}", first_line(&other.to_string())),
                })?,
        ),
        _ => None,
    };
    Ok(Compiled { rule: rule.clone(), regex })
}

fn first_line(text: &str) -> String {
    text.lines().last().unwrap_or(text).trim().trim_start_matches("error: ").to_owned()
}

impl Compiled {
    /// Whether `text` is as the rule asks: it matches, or with `negate`
    /// does not.
    pub fn allows(&self, text: &str) -> bool {
        let text = cut(text);
        let pattern = self.rule.pattern.as_str();
        let found = match self.rule.operator {
            PatternOperator::StartsWith => text.starts_with(pattern),
            PatternOperator::EndsWith => text.ends_with(pattern),
            PatternOperator::Contains => text.contains(pattern),
            PatternOperator::Regex => self.regex.as_ref().is_some_and(|regex| regex.is_match(text)),
        };
        found != self.rule.negate
    }

    /// What the rule asks, in words: `start with "feat: "`, `match /^v\d/`.
    pub fn wants(&self) -> String {
        describe(&self.rule)
    }
}

/// What a pattern rule asks, in words.
pub fn describe(rule: &PatternRule) -> String {
    let not = if rule.negate { "not " } else { "" };
    let pattern = &rule.pattern;
    let what = match rule.operator {
        PatternOperator::StartsWith => format!("{not}start with \"{pattern}\""),
        PatternOperator::EndsWith => format!("{not}end with \"{pattern}\""),
        PatternOperator::Contains => format!("{not}contain \"{pattern}\""),
        PatternOperator::Regex => format!("{not}match /{pattern}/"),
    };
    if rule.name.trim().is_empty() {
        what
    } else {
        format!("{what} ({})", rule.name.trim())
    }
}

/// At most [`MAX_TEXT`] bytes of `text`, cut on a character boundary.
fn cut(text: &str) -> &str {
    if text.len() <= MAX_TEXT {
        return text;
    }
    let mut end = MAX_TEXT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(operator: PatternOperator, pattern: &str, negate: bool) -> PatternRule {
        PatternRule { name: String::new(), operator, pattern: pattern.to_owned(), negate }
    }

    #[test]
    fn each_operator_compares_as_it_says() {
        let starts = compile(&rule(PatternOperator::StartsWith, "feat", false)).unwrap();
        assert!(starts.allows("feat: add rules"));
        assert!(!starts.allows("fix: rules"));
        let ends = compile(&rule(PatternOperator::EndsWith, "@acme.com", false)).unwrap();
        assert!(ends.allows("ada@acme.com"));
        assert!(!ends.allows("ada@example.com"));
        let contains = compile(&rule(PatternOperator::Contains, "WIP", true)).unwrap();
        assert!(contains.allows("Finish rules"));
        assert!(!contains.allows("WIP: rules"));
        let regex = compile(&rule(PatternOperator::Regex, r"^(feat|fix)(\(.+\))?: ", false)).unwrap();
        assert!(regex.allows("fix(api): snake case"));
        assert!(!regex.allows("Update things"));
    }

    #[test]
    fn a_bad_or_huge_expression_is_refused() {
        assert!(compile(&rule(PatternOperator::Regex, "(unclosed", false)).is_err());
        // Back-references need backtracking, which the engine never does.
        assert!(compile(&rule(PatternOperator::Regex, r"(a)\1", false)).is_err());
        let huge = compile(&rule(PatternOperator::Regex, r"\w{1000}\w{1000}\w{1000}", false));
        assert_eq!(huge.err().as_deref(), Some("The regular expression is too large."));
    }

    #[test]
    fn a_pathological_pattern_stays_linear() {
        let compiled = compile(&rule(PatternOperator::Regex, "(a+)+$", false)).unwrap();
        let text = format!("{}!", "a".repeat(50_000));
        assert!(!compiled.allows(&text));
    }

    #[test]
    fn rules_are_described_in_words() {
        assert_eq!(describe(&rule(PatternOperator::StartsWith, "feat", false)), "start with \"feat\"");
        assert_eq!(describe(&rule(PatternOperator::Regex, "^v", true)), "not match /^v/");
        let named = PatternRule { name: "Conventional commits".into(), ..rule(PatternOperator::Contains, ":", false) };
        assert_eq!(describe(&named), "contain \":\" (Conventional commits)");
    }
}
