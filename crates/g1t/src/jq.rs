//! `--jq`: a jq expression run over a command's JSON, built in so nothing
//! else needs installing.

use jaq_core::load::{Arena, File, Loader};
use jaq_core::{Compiler, Ctx, Vars, data, unwrap_valr};
use jaq_json::Val;
use serde_json::Value;

use crate::error::{Error, Result};

/// jq's `@csv` and `@tsv`, which jaq's libraries leave out.
const PRELUDE: &str = r#"
def @tsv: map(if type == "string" then gsub("\\\\"; "\\\\") | gsub("\t"; "\\t") | gsub("\n"; "\\n") | gsub("\r"; "\\r") elif . == null then "" else tojson end) | join("\t");
def @csv: map(if type == "string" then "\"" + gsub("\""; "\"\"") + "\"" elif . == null then "" else tojson end) | join(",");
"#;

/// The first of a list of jaq's errors, short.
fn first<E: std::fmt::Debug>(errors: &[E]) -> String {
    let text = errors.first().map(|e| format!("{e:?}")).unwrap_or_default();
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    text.chars().take(160).collect()
}

/// Runs `filter` over `input` and returns each output.
pub fn run(filter: &str, input: &Value) -> Result<Vec<Value>> {
    let code = format!("{PRELUDE}{filter}");
    let program = File { code: code.as_str(), path: () };
    let defs = jaq_core::defs().chain(jaq_std::defs()).chain(jaq_json::defs());
    let funs = jaq_core::funs().chain(jaq_std::funs()).chain(jaq_json::funs());
    let loader = Loader::new(defs);
    let arena = Arena::default();
    let modules =
        loader.load(&arena, program).map_err(|errors| Error::usage(format!("--jq `{filter}` does not parse: {}", first(&errors))))?;
    let filter_c = Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(|errors| Error::usage(format!("--jq `{filter}` does not compile: {}", first(&errors))))?;
    let text = serde_json::to_vec(input).expect("json");
    let input = jaq_json::read::parse_single(&text).map_err(|e| Error::failed(format!("--jq: {e:?}")))?;
    let ctx = Ctx::<data::JustLut<Val>>::new(&filter_c.lut, Vars::new([]));
    let mut out = Vec::new();
    for result in filter_c.id.run((ctx, input)).map(unwrap_valr) {
        let val = result.map_err(|e| Error::failed(format!("--jq `{filter}`: {e}")))?;
        let text = val.to_string();
        let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        out.push(value);
    }
    Ok(out)
}

/// One output as a line: strings as they are, the rest as compact JSON.
pub fn line(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(&crate::output::sorted(other)).expect("json"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_run() {
        let input = json!([{ "number": 1, "title": "a" }, { "number": 2, "title": "b" }]);
        let out = run(".[] | select(.number > 1) | .title", &input).unwrap();
        assert_eq!(out, vec![json!("b")]);
        let out = run("map(.number)", &input).unwrap();
        assert_eq!(out, vec![json!([1, 2])]);
        assert_eq!(line(&json!("b")), "b");
        assert_eq!(line(&json!({ "a": 1 })), r#"{"a":1}"#);
        let row = json!(["a\tb", 2, null, "say \"hi\""]);
        assert_eq!(run("@tsv", &row).unwrap(), vec![json!("a\\tb\t2\t\tsay \"hi\"")]);
        assert_eq!(run("@csv", &row).unwrap(), vec![json!("\"a\tb\",2,,\"say \"\"hi\"\"\"")]);
    }

    #[test]
    fn bad_filters_are_usage_errors() {
        let err = run(".[", &json!(1)).unwrap_err();
        assert_eq!(err.kind, crate::error::Kind::Usage);
    }
}
