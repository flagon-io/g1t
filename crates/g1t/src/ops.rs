//! Every operation of the g1t API, as the CLI knows it.
//!
//! The table in `ops_table.rs` is generated from the API's own description,
//! `apps/docs/src/data/openapi.json`, which apps/api keeps current. A test
//! fails when the two differ; regenerate with
//!
//! ```sh
//! G1T_WRITE_OPS=1 cargo test -p g1t ops_table
//! ```
//!
//! Commands never spell out a path: they name the operation, and
//! [`Client::call`](crate::client::Client::call) finds its method and path
//! here. So a path that changes in the API changes in the CLI when the table
//! is regenerated, and an operation that goes away fails the test that
//! checks every command's operations exist ([`crate::mapping`]).

pub use crate::ops_table::OPERATIONS;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum In {
    Path,
    Query,
}

#[derive(Debug)]
pub struct Param {
    pub name: &'static str,
    pub location: In,
    /// string, integer, number, boolean or array.
    pub kind: &'static str,
    pub required: bool,
    /// The values it takes, when they are a fixed few.
    pub values: &'static [&'static str],
}

#[derive(Debug)]
pub struct Field {
    pub name: &'static str,
    pub kind: &'static str,
    pub required: bool,
    pub values: &'static [&'static str],
}

#[derive(Debug)]
pub struct Operation {
    pub id: &'static str,
    pub method: &'static str,
    pub path: &'static str,
    pub tag: &'static str,
    pub summary: &'static str,
    /// The token scope it needs, when it needs one.
    pub scope: Option<&'static str>,
    pub params: &'static [Param],
    pub body: &'static [Field],
}

impl Operation {
    pub fn path_params(&self) -> impl Iterator<Item = &Param> {
        self.params.iter().filter(|p| p.location == In::Path)
    }

    pub fn query_params(&self) -> impl Iterator<Item = &Param> {
        self.params.iter().filter(|p| p.location == In::Query)
    }
}

pub fn find(id: &str) -> Option<&'static Operation> {
    OPERATIONS.iter().find(|op| op.id == id)
}

/// The operation, which must exist: commands name only operations the
/// mapping test has checked.
pub fn get(id: &str) -> &'static Operation {
    find(id).unwrap_or_else(|| panic!("no operation {id}: regenerate crates/g1t/src/ops_table.rs"))
}

#[cfg(test)]
pub mod generate {
    //! Writes `ops_table.rs` from the OpenAPI document.

    use serde_json::Value;
    use std::fmt::Write as _;

    pub fn openapi() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/docs/src/data/openapi.json"
        );
        let text = std::fs::read_to_string(path).expect("apps/docs/src/data/openapi.json");
        serde_json::from_str(&text).expect("openapi.json parses")
    }

    fn kind(schema: &Value) -> String {
        match &schema["type"] {
            Value::String(s) => s.clone(),
            Value::Array(list) => list
                .iter()
                .filter_map(Value::as_str)
                .find(|t| *t != "null")
                .unwrap_or("string")
                .to_owned(),
            _ if schema.get("oneOf").is_some() || schema.get("anyOf").is_some() => {
                "string".to_owned()
            }
            _ => "object".to_owned(),
        }
    }

    fn values(schema: &Value) -> Vec<String> {
        schema["enum"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn quoted(list: &[String]) -> String {
        let inner: Vec<String> = list.iter().map(|v| format!("{v:?}")).collect();
        format!("&[{}]", inner.join(", "))
    }

    pub fn table(doc: &Value) -> String {
        struct Row {
            tag: String,
            id: String,
            text: String,
        }
        let mut rows = Vec::new();
        for (path, item) in doc["paths"].as_object().expect("paths") {
            for (method, op) in item.as_object().expect("path item") {
                if !["get", "post", "put", "patch", "delete"].contains(&method.as_str()) {
                    continue;
                }
                let id = op["operationId"].as_str().expect("operationId").to_owned();
                let tag = op["tags"][0].as_str().unwrap_or("Other").to_owned();
                let summary = op["summary"].as_str().unwrap_or("").to_owned();
                let scope = match op["x-scope"].as_str() {
                    Some(s) => format!("Some({s:?})"),
                    None => "None".to_owned(),
                };
                let mut text = String::new();
                writeln!(text, "    Operation {{").unwrap();
                writeln!(text, "        id: {id:?},").unwrap();
                writeln!(text, "        method: {:?},", method.to_uppercase()).unwrap();
                writeln!(text, "        path: {path:?},").unwrap();
                writeln!(text, "        tag: {tag:?},").unwrap();
                writeln!(text, "        summary: {summary:?},").unwrap();
                writeln!(text, "        scope: {scope},").unwrap();
                let params: Vec<&Value> = op["parameters"]
                    .as_array()
                    .map(|l| l.iter().collect())
                    .unwrap_or_default();
                if params.is_empty() {
                    writeln!(text, "        params: &[],").unwrap();
                } else {
                    writeln!(text, "        params: &[").unwrap();
                    for p in params {
                        let location = match p["in"].as_str() {
                            Some("path") => "In::Path",
                            Some("query") => "In::Query",
                            _ => continue,
                        };
                        writeln!(
                            text,
                            "            Param {{ name: {:?}, location: {location}, kind: {:?}, required: {}, values: {} }},",
                            p["name"].as_str().unwrap_or(""),
                            kind(&p["schema"]),
                            p["required"].as_bool().unwrap_or(false),
                            quoted(&values(&p["schema"])),
                        )
                        .unwrap();
                    }
                    writeln!(text, "        ],").unwrap();
                }
                let schema = &op["requestBody"]["content"]["application/json"]["schema"];
                let required: Vec<&str> = schema["required"]
                    .as_array()
                    .map(|l| l.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                match schema["properties"].as_object() {
                    Some(props) if !props.is_empty() => {
                        writeln!(text, "        body: &[").unwrap();
                        for (name, field) in props {
                            writeln!(
                                text,
                                "            Field {{ name: {name:?}, kind: {:?}, required: {}, values: {} }},",
                                kind(field),
                                required.contains(&name.as_str()),
                                quoted(&values(field)),
                            )
                            .unwrap();
                        }
                        writeln!(text, "        ],").unwrap();
                    }
                    _ => writeln!(text, "        body: &[],").unwrap(),
                }
                writeln!(text, "    }},").unwrap();
                rows.push(Row { tag, id, text });
            }
        }
        rows.sort_by(|a, b| (&a.tag, &a.id).cmp(&(&b.tag, &b.id)));
        let mut out = String::from(
            "// @generated from apps/docs/src/data/openapi.json by crates/g1t/src/ops.rs.\n\
             // Do not edit: run `G1T_WRITE_OPS=1 cargo test -p g1t ops_table`.\n\n\
             use crate::ops::{Field, In, Operation, Param};\n\n\
             #[rustfmt::skip]\n\
             pub static OPERATIONS: &[Operation] = &[\n",
        );
        for row in rows {
            out.push_str(&row.text);
        }
        out.push_str("];\n");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ops_table_is_current() {
        let doc = generate::openapi();
        let want = generate::table(&doc);
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/ops_table.rs");
        if std::env::var_os("G1T_WRITE_OPS").is_some() {
            std::fs::write(path, &want).unwrap();
            return;
        }
        let have = std::fs::read_to_string(path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert!(
            have == want,
            "crates/g1t/src/ops_table.rs is out of date with apps/docs/src/data/openapi.json: run G1T_WRITE_OPS=1 cargo test -p g1t ops_table"
        );
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for op in OPERATIONS {
            assert!(seen.insert(op.id), "{} twice", op.id);
        }
    }

    #[test]
    fn every_path_parameter_is_in_the_path() {
        for op in OPERATIONS {
            for p in op.path_params() {
                assert!(
                    op.path.contains(&format!("{{{}}}", p.name)),
                    "{}: {}",
                    op.id,
                    p.name
                );
            }
        }
    }
}
