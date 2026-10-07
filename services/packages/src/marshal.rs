//! Ruby's Marshal format, version 4.8, written (never read): what the
//! RubyGems full index is made of. `specs.4.8.gz` is a marshalled array of
//! `[name, Gem::Version, platform]`, and each
//! `quick/Marshal.4.8/<gem>.gemspec.rz` a marshalled `Gem::Specification`.
//!
//! Only what those need is here: nil, booleans, small integers, strings
//! (UTF-8, or binary), symbols, arrays, hashes, plain objects with
//! instance variables, and the two kinds of custom dump RubyGems' classes
//! use (`marshal_dump`, which `Gem::Version` and `Gem::Requirement` use,
//! and `_dump`, which `Gem::Specification` uses). Symbols already written
//! are written again as links, as Ruby does; objects never are, which
//! Ruby reads the same.

use std::collections::HashMap;

/// A Ruby value to marshal.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Nil,
    Bool(bool),
    /// An integer between -2^31 and 2^31, which Marshal writes as a Fixnum.
    Int(i32),
    /// A UTF-8 string.
    Str(String),
    /// A binary (ASCII-8BIT) string.
    Bytes(Vec<u8>),
    Symbol(String),
    Array(Vec<Value>),
    Hash(Vec<(Value, Value)>),
    /// An object of `class` with these instance variables (`@name`).
    Object { class: String, ivars: Vec<(String, Value)> },
    /// What `class#marshal_dump` returned, for `class.marshal_load`.
    UserMarshal { class: String, data: Box<Value> },
    /// The bytes `class#_dump` returned, for `class._load`.
    UserDef { class: String, data: Vec<u8> },
}

impl Value {
    pub fn str(text: impl Into<String>) -> Value {
        Value::Str(text.into())
    }

    /// A string, or nil for none.
    pub fn opt(text: Option<&str>) -> Value {
        text.map_or(Value::Nil, Value::str)
    }
}

/// `value`, marshalled, with the 4.8 header.
pub fn dump(value: &Value) -> Vec<u8> {
    let mut writer = Writer { out: vec![4, 8], symbols: HashMap::new() };
    writer.value(value);
    writer.out
}

struct Writer {
    out: Vec<u8>,
    symbols: HashMap<String, usize>,
}

impl Writer {
    /// Marshal's integer: 0 as itself, -123..=122 in one byte offset by
    /// five, else a byte count (negated for a negative) and the bytes,
    /// least first.
    fn long(&mut self, n: i64) {
        if n == 0 {
            self.out.push(0);
        } else if (1..123).contains(&n) {
            self.out.push((n + 5) as u8);
        } else if (-123..0).contains(&n) {
            self.out.push(((n - 5) & 0xff) as u8);
        } else {
            let mut bytes = Vec::new();
            let mut rest = n;
            for _ in 0..4 {
                bytes.push((rest & 0xff) as u8);
                rest >>= 8;
                if (n > 0 && rest == 0) || (n < 0 && rest == -1) {
                    break;
                }
            }
            let count = bytes.len() as i64;
            self.out.push(if n > 0 { count as u8 } else { (-count & 0xff) as u8 });
            self.out.extend_from_slice(&bytes);
        }
    }

    fn bytes(&mut self, bytes: &[u8]) {
        self.long(bytes.len() as i64);
        self.out.extend_from_slice(bytes);
    }

    fn symbol(&mut self, name: &str) {
        if let Some(&index) = self.symbols.get(name) {
            self.out.push(b';');
            self.long(index as i64);
            return;
        }
        let index = self.symbols.len();
        self.symbols.insert(name.to_owned(), index);
        self.out.push(b':');
        self.bytes(name.as_bytes());
    }

    fn value(&mut self, value: &Value) {
        match value {
            Value::Nil => self.out.push(b'0'),
            Value::Bool(true) => self.out.push(b'T'),
            Value::Bool(false) => self.out.push(b'F'),
            Value::Int(n) => {
                self.out.push(b'i');
                self.long(i64::from(*n));
            }
            // A string with an encoding is a string with one instance
            // variable, `E`: true for UTF-8.
            Value::Str(text) => {
                self.out.push(b'I');
                self.out.push(b'"');
                self.bytes(text.as_bytes());
                self.long(1);
                self.symbol("E");
                self.out.push(b'T');
            }
            Value::Bytes(bytes) => {
                self.out.push(b'"');
                self.bytes(bytes);
            }
            Value::Symbol(name) => self.symbol(name),
            Value::Array(items) => {
                self.out.push(b'[');
                self.long(items.len() as i64);
                for item in items {
                    self.value(item);
                }
            }
            Value::Hash(pairs) => {
                self.out.push(b'{');
                self.long(pairs.len() as i64);
                for (key, item) in pairs {
                    self.value(key);
                    self.value(item);
                }
            }
            Value::Object { class, ivars } => {
                self.out.push(b'o');
                self.symbol(class);
                self.long(ivars.len() as i64);
                for (name, item) in ivars {
                    self.symbol(name);
                    self.value(item);
                }
            }
            Value::UserMarshal { class, data } => {
                self.out.push(b'U');
                self.symbol(class);
                self.value(data);
            }
            Value::UserDef { class, data } => {
                self.out.push(b'u');
                self.symbol(class);
                self.bytes(data);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_are_written_as_ruby_writes_them() {
        // Each as `Marshal.dump` writes it in Ruby 3.3.
        assert_eq!(dump(&Value::Nil), b"\x04\x080");
        assert_eq!(dump(&Value::Bool(true)), b"\x04\x08T");
        assert_eq!(dump(&Value::Int(0)), b"\x04\x08i\x00");
        assert_eq!(dump(&Value::Int(4)), b"\x04\x08i\x09");
        assert_eq!(dump(&Value::Int(-1)), b"\x04\x08i\xfa");
        assert_eq!(dump(&Value::Int(123)), b"\x04\x08i\x01\x7b");
        assert_eq!(dump(&Value::Int(256)), b"\x04\x08i\x02\x00\x01");
        assert_eq!(dump(&Value::Int(-124)), b"\x04\x08i\xff\x84");
        assert_eq!(dump(&Value::Int(-256)), b"\x04\x08i\xff\x00");
        assert_eq!(dump(&Value::Int(-257)), b"\x04\x08i\xfe\xff\xfe");
        assert_eq!(dump(&Value::str("hi")), b"\x04\x08I\"\x07hi\x06:\x06ET");
        assert_eq!(dump(&Value::Bytes(b"hi".to_vec())), b"\x04\x08\"\x07hi");
        // The second `:a` is a link to the first.
        assert_eq!(
            dump(&Value::Array(vec![Value::Symbol("a".into()), Value::Symbol("a".into())])),
            b"\x04\x08[\x07:\x06a;\x00"
        );
        assert_eq!(dump(&Value::Hash(vec![(Value::Int(1), Value::Nil)])), b"\x04\x08{\x06i\x060");
        // Gem::Version.new("1.0")
        assert_eq!(
            dump(&Value::UserMarshal { class: "Gem::Version".into(), data: Box::new(Value::Array(vec![Value::str("1.0")])) }),
            b"\x04\x08U:\x11Gem::Version[\x06I\"\x081.0\x06:\x06ET"
        );
        assert_eq!(
            dump(&Value::Object { class: "Point".into(), ivars: vec![("@x".into(), Value::Int(1))] }),
            b"\x04\x08o:\x0aPoint\x06:\x07@xi\x06"
        );
        assert_eq!(dump(&Value::UserDef { class: "X".into(), data: b"ab".to_vec() }), b"\x04\x08u:\x06X\x07ab");
    }
}
