//! Just enough XML for package files: a Maven POM and a NuGet `.nuspec`
//! are read into a tree of elements (names without their namespace
//! prefix), and the metadata Maven reads is written with `escape`.
//! Declarations, comments, doctypes and processing instructions are
//! skipped; CDATA and the standard entities are read.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Element {
    /// The local name: `package` for `<ns:package>`.
    pub name: String,
    pub attributes: Vec<(String, String)>,
    pub children: Vec<Element>,
    /// The element's own text, its parts joined.
    pub text: String,
}

impl Element {
    /// The first child named `name`.
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// The trimmed text of the first child named `name`, when it has some.
    pub fn child_text(&self, name: &str) -> Option<String> {
        self.child(name).map(|c| c.text.trim().to_owned()).filter(|t| !t.is_empty())
    }

    pub fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }
}

fn local(name: &str) -> String {
    name.rsplit(':').next().unwrap_or(name).to_owned()
}

/// Text with its entities read: `&amp;` is `&`, `&#65;` is `A`.
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';').filter(|end| *end <= 12) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let read = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|n| n.parse().ok()))
                .and_then(char::from_u32),
        };
        match read {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Text made safe to put between tags or in an attribute.
pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn attributes(text: &str) -> Result<Vec<(String, String)>, String> {
    let mut list = Vec::new();
    let mut rest = text.trim();
    while !rest.is_empty() {
        let eq = rest.find('=').ok_or("An attribute has no value.")?;
        let key = rest[..eq].trim();
        let after = rest[eq + 1..].trim_start();
        let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'').ok_or("An attribute's value is not quoted.")?;
        let close = after[1..].find(quote).ok_or("An attribute's value is not closed.")? + 1;
        list.push((local(key), unescape(&after[1..close])));
        rest = after[close + 1..].trim_start();
    }
    Ok(list)
}

/// Reads a document into its root element.
pub fn parse(text: &str) -> Result<Element, String> {
    let text = text.trim_start_matches('\u{feff}');
    let mut stack: Vec<Element> = Vec::new();
    let mut root = None;
    let mut rest = text;
    while !rest.is_empty() {
        let Some(open) = rest.find('<') else {
            if let Some(top) = stack.last_mut() {
                top.text.push_str(&unescape(rest));
            }
            break;
        };
        if open > 0
            && let Some(top) = stack.last_mut() {
                top.text.push_str(&unescape(&rest[..open]));
            }
        rest = &rest[open..];
        let skip = |rest: &str, end: &str| rest.find(end).map(|at| at + end.len()).ok_or_else(|| "The XML ends early.".to_owned());
        if rest.starts_with("<?") {
            rest = &rest[skip(rest, "?>")?..];
        } else if rest.starts_with("<!--") {
            rest = &rest[skip(rest, "-->")?..];
        } else if let Some(cdata) = rest.strip_prefix("<![CDATA[") {
            let end = cdata.find("]]>").ok_or("The XML ends early.")?;
            if let Some(top) = stack.last_mut() {
                top.text.push_str(&cdata[..end]);
            }
            rest = &cdata[end + 3..];
        } else if rest.starts_with("<!") {
            rest = &rest[skip(rest, ">")?..];
        } else if let Some(closing) = rest.strip_prefix("</") {
            let end = closing.find('>').ok_or("The XML ends early.")?;
            let name = local(closing[..end].trim());
            let element = stack.pop().ok_or("A tag is closed that was not opened.")?;
            if element.name != name {
                return Err(format!("<{}> is closed by </{name}>.", element.name));
            }
            match stack.last_mut() {
                Some(parent) => parent.children.push(element),
                None => root = Some(element),
            }
            rest = &closing[end + 1..];
        } else {
            // An opening tag; `>` inside a quoted attribute does not end it.
            let mut quote = None;
            let end = rest
                .char_indices()
                .find(|&(_, c)| {
                    match quote {
                        Some(q) if c == q => quote = None,
                        None if c == '"' || c == '\'' => quote = Some(c),
                        None if c == '>' => return true,
                        _ => {}
                    }
                    false
                })
                .map(|(at, _)| at)
                .ok_or("The XML ends early.")?;
            let inner = &rest[1..end];
            let empty = inner.ends_with('/');
            let inner = inner.trim_end_matches('/');
            let (name, attrs) = inner.split_once(char::is_whitespace).unwrap_or((inner, ""));
            if name.is_empty() {
                return Err("A tag has no name.".to_owned());
            }
            let element = Element { name: local(name), attributes: attributes(attrs)?, ..Element::default() };
            if empty {
                match stack.last_mut() {
                    Some(parent) => parent.children.push(element),
                    None => root = Some(element),
                }
            } else {
                stack.push(element);
            }
            rest = &rest[end + 1..];
        }
        if root.is_some() && stack.is_empty() {
            break;
        }
    }
    if !stack.is_empty() {
        return Err("The XML ends early.".to_owned());
    }
    root.ok_or_else(|| "There is no XML in it.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_read_into_elements() {
        let doc = parse(
            r#"<?xml version="1.0" encoding="utf-8"?>
<!-- a comment -->
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata minClientVersion="4.0">
    <id>Acme.Web</id>
    <description><![CDATA[Fast & <small>]]></description>
    <authors>Ada &amp; Bo</authors>
    <repository type="git" url="https://g1t.sh/acme/web.git" />
    <dependencies>
      <group targetFramework="net8.0"><dependency id="Newtonsoft.Json" version="13.0.1" exclude="Build,Analyzers" /></group>
    </dependencies>
    <x:other xmlns:x="urn:x" note='a > b'>&#65;&#x42;</x:other>
  </metadata>
</package>"#,
        )
        .unwrap();
        assert_eq!(doc.name, "package");
        let metadata = doc.child("metadata").unwrap();
        assert_eq!(metadata.attribute("minClientVersion"), Some("4.0"));
        assert_eq!(metadata.child_text("id").as_deref(), Some("Acme.Web"));
        assert_eq!(metadata.child_text("description").as_deref(), Some("Fast & <small>"));
        assert_eq!(metadata.child_text("authors").as_deref(), Some("Ada & Bo"));
        assert_eq!(metadata.child("repository").unwrap().attribute("url"), Some("https://g1t.sh/acme/web.git"));
        let dep = metadata.child("dependencies").unwrap().child("group").unwrap().child("dependency").unwrap();
        assert_eq!(dep.attribute("version"), Some("13.0.1"));
        let other = metadata.child("other").unwrap();
        assert_eq!(other.text, "AB");
        assert_eq!(other.attribute("note"), Some("a > b"));
        assert_eq!(metadata.child_text("missing"), None);
    }

    #[test]
    fn broken_documents_are_refused() {
        assert!(parse("<a><b></a>").is_err());
        assert!(parse("<a>").is_err());
        assert!(parse("just text").is_err());
        assert!(parse("<a x=1/>").is_err());
        assert_eq!(escape("a<b & \"c\""), "a&lt;b &amp; &quot;c&quot;");
    }
}
