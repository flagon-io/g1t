//! Just enough YAML for a gem's `metadata.gz`: the `Gem::Specification`
//! RubyGems writes with Psych. Block mappings and sequences (including a
//! sequence at its key's indent, and `- - ">="` nested ones), plain and
//! quoted scalars wrapped over lines, `|` and `>` block scalars, and empty
//! flow collections. Tags (`!ruby/object:Gem::Version`) are dropped: the
//! value is read as the plain mapping or scalar under them.

use serde_json::{Map, Value};

#[derive(Clone, Debug)]
struct Line {
    indent: usize,
    text: String,
}

/// Reads a document into JSON values: mappings as objects, sequences as
/// arrays, scalars as strings, and empty values as null.
pub fn parse(text: &str) -> Result<Value, String> {
    let mut lines = Vec::new();
    for raw in text.lines() {
        let trimmed = raw.trim_end();
        let indent = trimmed.len() - trimmed.trim_start().len();
        let content = trimmed.trim_start();
        if content.starts_with('#') || content == "..." {
            continue;
        }
        if indent == 0 && content.starts_with("---") {
            let after = strip_tag(content[3..].trim());
            if !after.is_empty() {
                lines.push(Line { indent: 0, text: after.to_owned() });
            }
            continue;
        }
        lines.push(Line { indent, text: content.to_owned() });
    }
    let mut parser = Parser { lines, at: 0 };
    parser.skip_blank();
    if parser.at >= parser.lines.len() {
        return Ok(Value::Null);
    }
    let indent = parser.lines[parser.at].indent;
    parser.node(indent)
}

/// The text after a leading tag: `!ruby/object:Gem::Version` alone is empty.
fn strip_tag(text: &str) -> &str {
    if text.starts_with('!') {
        text.split_once(' ').map_or("", |(_, rest)| rest.trim_start())
    } else {
        text
    }
}

/// Where a mapping key ends: the `:` followed by a space or the end of the
/// line, outside quotes.
fn key_end(text: &str) -> Option<usize> {
    if text.starts_with('"') || text.starts_with('\'') {
        let quote = text.as_bytes()[0] as char;
        let close = text[1..].find(quote)? + 1;
        return text[close + 1..].starts_with(':').then_some(close + 1).filter(|at| {
            let after = &text[at + 1..];
            after.is_empty() || after.starts_with(' ')
        });
    }
    if text.starts_with('-') && (text.len() == 1 || text.as_bytes()[1] == b' ') {
        return None;
    }
    let bytes = text.as_bytes();
    (0..bytes.len()).find(|&i| bytes[i] == b':' && (i + 1 == bytes.len() || bytes[i + 1] == b' '))
}

fn unquote_key(key: &str) -> String {
    let key = key.trim();
    match scalar(key) {
        Value::String(s) => s,
        _ => key.to_owned(),
    }
}

/// A scalar as written on one line (continuations already joined).
fn scalar(text: &str) -> Value {
    let text = strip_tag(text.trim());
    if text.is_empty() || text == "~" || text == "null" {
        return Value::Null;
    }
    if text == "[]" {
        return Value::Array(Vec::new());
    }
    if text == "{}" {
        return Value::Object(Map::new());
    }
    if let Some(inner) = text.strip_prefix('[').and_then(|t| t.strip_suffix(']')) {
        return Value::Array(inner.split(',').map(|item| scalar(item.trim())).collect());
    }
    if let Some(inner) = text.strip_prefix('\'').and_then(|t| t.strip_suffix('\'')) {
        return Value::String(inner.replace("''", "'"));
    }
    if let Some(inner) = text.strip_prefix('"').and_then(|t| t.strip_suffix('"')) {
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('/') => out.push('/'),
                Some('0') => out.push('\0'),
                Some(' ') => out.push(' '),
                Some('x') => {
                    let hex: String = chars.by_ref().take(2).collect();
                    out.extend(u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32));
                }
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    out.extend(u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32));
                }
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        }
        return Value::String(out);
    }
    Value::String(text.to_owned())
}

struct Parser {
    lines: Vec<Line>,
    at: usize,
}

impl Parser {
    fn skip_blank(&mut self) {
        while self.at < self.lines.len() && self.lines[self.at].text.is_empty() {
            self.at += 1;
        }
    }

    fn peek(&mut self) -> Option<&Line> {
        self.skip_blank();
        self.lines.get(self.at)
    }

    /// The node starting at the current line, which is at `indent`.
    fn node(&mut self, indent: usize) -> Result<Value, String> {
        let Some(line) = self.peek().cloned() else {
            return Ok(Value::Null);
        };
        if line.text == "-" || line.text.starts_with("- ") {
            return self.sequence(line.indent);
        }
        if key_end(&line.text).is_some() {
            return self.mapping(line.indent);
        }
        self.at += 1;
        let text = self.continued(line.text.clone(), indent.saturating_sub(1));
        Ok(scalar(&text))
    }

    /// A scalar with the lines that continue it: deeper than `parent`, and
    /// not themselves a key or an item.
    fn continued(&mut self, mut text: String, parent: usize) -> String {
        let open_quote = |t: &str| {
            let t = t.trim();
            (t.starts_with('"') && (t.len() == 1 || !t.ends_with('"') || t.ends_with("\\\"")))
                || (t.starts_with('\'') && (t.len() == 1 || !t.ends_with('\'')))
        };
        loop {
            let quoted = open_quote(&text);
            let Some(next) = self.lines.get(self.at) else { break };
            if next.text.is_empty() {
                if quoted {
                    text.push('\n');
                    self.at += 1;
                    continue;
                }
                break;
            }
            if next.indent <= parent || (!quoted && (key_end(&next.text).is_some() || next.text.starts_with("- "))) {
                break;
            }
            text.push(' ');
            text.push_str(&next.text);
            self.at += 1;
        }
        text
    }

    fn sequence(&mut self, indent: usize) -> Result<Value, String> {
        let mut items = Vec::new();
        while let Some(line) = self.peek().cloned() {
            if line.indent != indent || !(line.text == "-" || line.text.starts_with("- ")) {
                break;
            }
            let rest = line.text[1..].trim_start();
            let rest = strip_tag(rest).to_owned();
            if rest.is_empty() {
                self.at += 1;
                match self.peek().cloned() {
                    Some(next) if next.indent > indent => items.push(self.node(next.indent)?),
                    _ => items.push(Value::Null),
                }
                continue;
            }
            // The item's content stands in for a line at its own column.
            let column = indent + (line.text.len() - rest.len());
            self.lines[self.at] = Line { indent: column, text: rest };
            items.push(self.node(column)?);
        }
        Ok(Value::Array(items))
    }

    fn mapping(&mut self, indent: usize) -> Result<Value, String> {
        let mut map = Map::new();
        while let Some(line) = self.peek().cloned() {
            if line.indent != indent {
                break;
            }
            let Some(end) = key_end(&line.text) else { break };
            let key = unquote_key(&line.text[..end]);
            let rest = strip_tag(line.text[end + 1..].trim()).to_owned();
            self.at += 1;
            let value = if rest.is_empty() {
                match self.peek().cloned() {
                    Some(next) if next.indent > indent => self.node(next.indent)?,
                    Some(next) if next.indent == indent && (next.text == "-" || next.text.starts_with("- ")) => self.sequence(indent)?,
                    _ => Value::Null,
                }
            } else if let Some(style) = rest.strip_prefix('|').map(|s| (true, s)).or_else(|| rest.strip_prefix('>').map(|s| (false, s))) {
                self.block(indent, style.0, style.1)
            } else {
                let text = self.continued(rest, indent);
                scalar(&text)
            };
            map.insert(key, value);
        }
        Ok(Value::Object(map))
    }

    /// A `|` (literal) or `>` (folded) block scalar under a key at `indent`.
    fn block(&mut self, indent: usize, literal: bool, chomp: &str) -> Value {
        let mut lines: Vec<(usize, String)> = Vec::new();
        while let Some(next) = self.lines.get(self.at) {
            if !next.text.is_empty() && next.indent <= indent {
                break;
            }
            lines.push((next.indent, next.text.clone()));
            self.at += 1;
        }
        while lines.last().is_some_and(|(_, t)| t.is_empty()) {
            lines.pop();
        }
        let base = lines.iter().filter(|(_, t)| !t.is_empty()).map(|(i, _)| *i).min().unwrap_or(0);
        let shown: Vec<String> = lines
            .iter()
            .map(|(i, t)| if t.is_empty() { String::new() } else { format!("{}{t}", " ".repeat(i - base)) })
            .collect();
        let mut text = if literal {
            shown.join("\n")
        } else {
            let mut folded = String::new();
            for (n, line) in shown.iter().enumerate() {
                if n > 0 {
                    folded.push(if line.is_empty() || shown[n - 1].is_empty() { '\n' } else { ' ' });
                }
                folded.push_str(line);
            }
            folded
        };
        if !chomp.contains('-') && !text.is_empty() {
            text.push('\n');
        }
        Value::String(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SPEC: &str = r#"--- !ruby/object:Gem::Specification
name: hello-world
version: !ruby/object:Gem::Version
  version: 0.1.0
platform: ruby
authors:
- Ada Lovelace
autorequire:
bindir: exe
cert_chain: []
date: 2026-10-06 00:00:00.000000000 Z
dependencies:
- !ruby/object:Gem::Dependency
  name: rack
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - ">="
      - !ruby/object:Gem::Version
        version: '2.0'
    - - "<"
      - !ruby/object:Gem::Version
        version: '4'
  type: :runtime
  prerelease: false
- !ruby/object:Gem::Dependency
  name: rspec
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - "~>"
      - !ruby/object:Gem::Version
        version: '3.12'
  type: :development
description: |-
  Says hello.

  Then says it again.
email:
- ada@example.com
homepage: https://g1t.sh/acme/hello-world
licenses:
- MIT
metadata:
  source_code_uri: https://g1t.sh/acme/hello-world
  "quoted key": 'it''s'
required_ruby_version: !ruby/object:Gem::Requirement
  requirements:
  - - ">="
    - !ruby/object:Gem::Version
      version: 3.0.0
summary: A summary long enough that Psych wraps it onto a second line when it
  writes the specification
test_files: []
"#;

    #[test]
    fn a_gemspec_reads_as_rubygems_wrote_it() {
        let spec = parse(SPEC).unwrap();
        assert_eq!(spec["name"], "hello-world");
        assert_eq!(spec["version"]["version"], "0.1.0");
        assert_eq!(spec["platform"], "ruby");
        assert_eq!(spec["authors"], json!(["Ada Lovelace"]));
        assert_eq!(spec["autorequire"], Value::Null);
        assert_eq!(spec["cert_chain"], json!([]));
        let deps = spec["dependencies"].as_array().unwrap();
        assert_eq!(deps.len(), 2);
        assert_eq!(deps[0]["name"], "rack");
        assert_eq!(deps[0]["type"], ":runtime");
        assert_eq!(deps[0]["requirement"]["requirements"], json!([[">=", { "version": "2.0" }], ["<", { "version": "4" }]]));
        assert_eq!(deps[1]["type"], ":development");
        assert_eq!(spec["description"], "Says hello.\n\nThen says it again.");
        assert_eq!(spec["metadata"]["source_code_uri"], "https://g1t.sh/acme/hello-world");
        assert_eq!(spec["metadata"]["quoted key"], "it's");
        assert_eq!(spec["required_ruby_version"]["requirements"][0][1]["version"], "3.0.0");
        assert_eq!(spec["summary"], "A summary long enough that Psych wraps it onto a second line when it writes the specification");
        assert_eq!(spec["test_files"], json!([]));
    }

    #[test]
    fn scalars_and_blocks() {
        let doc = parse("a: \"line\\nnext\"\nb: >\n  folded\n  text\nc: [x, 'y']\nd: ~\n").unwrap();
        assert_eq!(doc["a"], "line\nnext");
        assert_eq!(doc["b"], "folded text\n");
        assert_eq!(doc["c"], json!(["x", "y"]));
        assert_eq!(doc["d"], Value::Null);
        assert_eq!(parse("").unwrap(), Value::Null);
        assert_eq!(parse("- a\n- b\n").unwrap(), json!(["a", "b"]));
    }
}
