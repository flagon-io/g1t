//! YAML read with where each value is, so that a problem in the dependency
//! update file can name its line. Only what a configuration file needs:
//! mappings, sequences and scalars, with anchors and aliases resolved.

use std::collections::HashMap;

use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// A value and where it starts: 1-based line and column.
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub value: Value,
    pub line: u32,
    pub column: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    /// Text. `quoted` when it was written in quotes or as a block, which
    /// keeps `"2"` text where a plain `2` is a number.
    Text { text: String, quoted: bool },
    Seq(Vec<Node>),
    /// In the order written. Keys are text; a duplicate is an error.
    Map(Vec<(Node, Node)>),
}

impl Node {
    pub fn kind(&self) -> &'static str {
        match self.value {
            Value::Null => "empty",
            Value::Bool(_) => "true or false",
            Value::Int(_) | Value::Float(_) => "a number",
            Value::Text { .. } => "text",
            Value::Seq(_) => "a list",
            Value::Map(_) => "a mapping",
        }
    }

    /// The text of a scalar, however it was written: `2`, `true`, `"x"`.
    pub fn scalar(&self) -> Option<String> {
        Some(match &self.value {
            Value::Text { text, .. } => text.clone(),
            Value::Int(n) => n.to_string(),
            Value::Float(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => return None,
        })
    }

    pub fn as_map(&self) -> Option<&[(Node, Node)]> {
        match &self.value {
            Value::Map(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Node> {
        self.as_map()?
            .iter()
            .find(|(name, _)| matches!(&name.value, Value::Text { text, .. } if text == key))
            .map(|(_, value)| value)
    }

    /// As JSON, for showing what was read.
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::Value as Json;
        match &self.value {
            Value::Null => Json::Null,
            Value::Bool(b) => Json::Bool(*b),
            Value::Int(n) => Json::from(*n),
            Value::Float(n) => serde_json::Number::from_f64(*n).map_or(Json::Null, Json::Number),
            Value::Text { text, .. } => Json::String(text.clone()),
            Value::Seq(items) => Json::Array(items.iter().map(Node::to_json).collect()),
            Value::Map(entries) => Json::Object(
                entries.iter().map(|(key, value)| (key.scalar().unwrap_or_default(), value.to_json())).collect(),
            ),
        }
    }
}

/// What went wrong reading the YAML itself.
#[derive(Debug, PartialEq)]
pub struct YamlError {
    pub line: u32,
    pub column: u32,
    pub message: String,
}

/// YAML 1.2's core schema, as Dependabot reads it: `true`, `false`,
/// `null`, `~`, integers and floats are themselves in a plain scalar.
fn plain(text: String) -> Value {
    match text.as_str() {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    let digits = text.strip_prefix(['-', '+']).unwrap_or(&text);
    if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
        && let Ok(n) = text.parse::<i64>()
    {
        return Value::Int(n);
    }
    if text.chars().any(|c| c.is_ascii_digit())
        && text.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))
        && let Ok(n) = text.parse::<f64>()
    {
        return Value::Float(n);
    }
    Value::Text { text, quoted: false }
}

enum Open {
    Seq(Vec<Node>, Marker, usize),
    Map(Vec<(Node, Node)>, Option<Node>, Marker, usize),
}

#[derive(Default)]
struct Builder {
    stack: Vec<Open>,
    anchors: HashMap<usize, Node>,
    root: Option<Node>,
    documents: u32,
    error: Option<YamlError>,
}

fn at(mark: Marker) -> (u32, u32) {
    (mark.line() as u32, mark.col() as u32 + 1)
}

impl Builder {
    fn push(&mut self, node: Node, anchor: usize) {
        if anchor > 0 {
            self.anchors.insert(anchor, node.clone());
        }
        match self.stack.last_mut() {
            Some(Open::Seq(items, _, _)) => items.push(node),
            Some(Open::Map(entries, key, _, _)) => match key.take() {
                None => {
                    let duplicate = entries.iter().any(|(existing, _)| existing.scalar().is_some() && existing.scalar() == node.scalar());
                    if duplicate && self.error.is_none() {
                        self.error = Some(YamlError {
                            line: node.line,
                            column: node.column,
                            message: format!("`{}` is given twice.", node.scalar().unwrap_or_default()),
                        });
                    }
                    *key = Some(node);
                }
                Some(name) => entries.push((name, node)),
            },
            None => {
                if self.root.is_none() {
                    self.root = Some(node);
                }
            }
        }
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, event: Event, mark: Marker) {
        let (line, column) = at(mark);
        match event {
            Event::DocumentStart => self.documents += 1,
            Event::Scalar(text, style, anchor, _) => {
                let value = if style == TScalarStyle::Plain { plain(text) } else { Value::Text { text, quoted: true } };
                self.push(Node { value, line, column }, anchor);
            }
            Event::Alias(anchor) => {
                let node = self.anchors.get(&anchor).cloned().unwrap_or(Node { value: Value::Null, line, column });
                self.push(Node { line, column, ..node }, 0);
            }
            Event::SequenceStart(anchor, _) => self.stack.push(Open::Seq(Vec::new(), mark, anchor)),
            Event::MappingStart(anchor, _) => self.stack.push(Open::Map(Vec::new(), None, mark, anchor)),
            Event::SequenceEnd | Event::MappingEnd => {
                let (value, mark, anchor) = match self.stack.pop() {
                    Some(Open::Seq(items, mark, anchor)) => (Value::Seq(items), mark, anchor),
                    Some(Open::Map(entries, _, mark, anchor)) => (Value::Map(merged(entries)), mark, anchor),
                    None => return,
                };
                let (line, column) = at(mark);
                self.push(Node { value, line, column }, anchor);
            }
            _ => {}
        }
    }
}

/// YAML's merge key, `<<: *defaults`, which configuration files use to
/// share settings between entries: the merged mapping's keys come first
/// unless the mapping sets them itself.
fn merged(entries: Vec<(Node, Node)>) -> Vec<(Node, Node)> {
    if !entries.iter().any(|(key, _)| key.scalar().as_deref() == Some("<<")) {
        return entries;
    }
    let mut own = Vec::new();
    let mut inherited = Vec::new();
    for (key, value) in entries {
        if key.scalar().as_deref() != Some("<<") {
            own.push((key, value));
            continue;
        }
        let sources = match value.value {
            Value::Seq(items) => items,
            _ => vec![value],
        };
        for source in sources {
            if let Value::Map(found) = source.value {
                inherited.extend(found);
            }
        }
    }
    inherited.retain(|(key, _)| !own.iter().any(|(mine, _)| mine.scalar() == key.scalar()));
    inherited.extend(own);
    inherited
}

/// The single document in `source`, or where it stops being YAML. An empty
/// file is `Null`.
pub fn parse(source: &str) -> Result<Node, YamlError> {
    let mut builder = Builder::default();
    let mut parser = Parser::new_from_str(source);
    if let Err(error) = parser.load(&mut builder, true) {
        let (line, column) = at(*error.marker());
        return Err(YamlError { line, column, message: format!("This is not valid YAML: {}.", error.info()) });
    }
    if let Some(error) = builder.error {
        return Err(error);
    }
    if builder.documents > 1 {
        return Err(YamlError { line: 0, column: 0, message: "The file holds more than one YAML document; it must hold one.".to_owned() });
    }
    Ok(builder.root.unwrap_or(Node { value: Value::Null, line: 1, column: 1 }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_keep_their_lines() {
        let root = parse("version: 2\nupdates:\n  - package-ecosystem: \"npm\"\n    directory: /\n    labels: [a, b]\n").unwrap();
        assert_eq!(root.get("version").unwrap().value, Value::Int(2));
        let entry = &match &root.get("updates").unwrap().value {
            Value::Seq(items) => items.clone(),
            _ => panic!(),
        }[0];
        let ecosystem = entry.get("package-ecosystem").unwrap();
        assert_eq!((ecosystem.line, ecosystem.column), (3, 24));
        assert_eq!(ecosystem.value, Value::Text { text: "npm".into(), quoted: true });
        assert_eq!(entry.get("directory").unwrap().line, 4);
        assert_eq!(entry.get("labels").unwrap().to_json(), serde_json::json!(["a", "b"]));
    }

    #[test]
    fn scalars_are_typed_as_yaml_does() {
        let root = parse("a: 2\nb: \"2\"\nc: true\nd: ~\ne: 1.5\nf: 03:00\ng: v1\n").unwrap();
        assert_eq!(root.get("a").unwrap().value, Value::Int(2));
        assert_eq!(root.get("b").unwrap().value, Value::Text { text: "2".into(), quoted: true });
        assert_eq!(root.get("c").unwrap().value, Value::Bool(true));
        assert_eq!(root.get("d").unwrap().value, Value::Null);
        assert_eq!(root.get("e").unwrap().value, Value::Float(1.5));
        assert_eq!(root.get("f").unwrap().scalar().as_deref(), Some("03:00"));
        assert_eq!(root.get("g").unwrap().scalar().as_deref(), Some("v1"));
    }

    #[test]
    fn anchors_and_merge_keys_are_resolved() {
        let source = "defaults: &d\n  interval: weekly\n  day: monday\nschedule:\n  <<: *d\n  day: friday\nalias: *d\n";
        let root = parse(source).unwrap();
        let schedule = root.get("schedule").unwrap();
        assert_eq!(schedule.get("interval").unwrap().scalar().as_deref(), Some("weekly"));
        assert_eq!(schedule.get("day").unwrap().scalar().as_deref(), Some("friday"));
        assert_eq!(root.get("alias").unwrap().get("day").unwrap().scalar().as_deref(), Some("monday"));
    }

    #[test]
    fn broken_yaml_and_duplicates_say_where() {
        let error = parse("version: 2\nupdates: [\n").unwrap_err();
        assert!(error.message.starts_with("This is not valid YAML"), "{error:?}");
        assert!(error.line >= 2);
        let twice = parse("version: 2\nversion: 3\n").unwrap_err();
        assert_eq!((twice.line, twice.message.as_str()), (2, "`version` is given twice."));
        assert_eq!(parse("").unwrap().value, Value::Null);
        assert!(parse("a: 1\n---\nb: 2\n").is_err());
    }
}
