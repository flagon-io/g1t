//! REST versions use a header, leaving GitHub-compatible URLs unprefixed.
pub const HEADER: &str = "x-g1t-api-version";
pub const CURRENT: &str = "1";

pub fn supported(value: Option<&str>) -> bool {
    value.is_none_or(|value| value.trim() == CURRENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn omitted_versions_keep_working_and_unknown_versions_are_not_silently_accepted() {
        assert!(supported(None));
        assert!(supported(Some("1")));
        assert!(supported(Some(" 1 ")));
        for value in ["", "2", "latest", "1, 2"] { assert!(!supported(Some(value))); }
    }
}
