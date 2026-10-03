//! The GitHub Actions expression language: the `${{ }}` language.
//!
//! This follows GitHub's "Evaluate expressions in workflows and actions"
//! precisely, so a real GitHub workflow evaluates here the way it
//! does on GitHub: the same literals, the same operator precedence, the same
//! loose equality (with its coercions to number), the same case-insensitive
//! string handling, the same object filters (`labels.*.name`) and the same
//! functions. Parse errors are found before anything is evaluated, so an
//! unknown context or function is an error even in a branch that would never
//! run, as on GitHub.

use serde_json::{Map, Value};
use std::borrow::Cow;
use std::cmp::Ordering;

/// How the job is going, for success(), failure(), cancelled(), always().
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Success,
    Failure,
    Cancelled,
}

pub struct Scope<'a> {
    /// Top-level contexts by lower-case name: github, env, vars, secrets, inputs, matrix, strategy, needs, steps, job, jobs, runner.
    pub contexts: &'a Map<String, Value>,
    pub status: Status,
    /// hashFiles(...) when the caller can compute it (the sandbox); None means hashFiles evaluates to "".
    #[allow(clippy::type_complexity)]
    pub hash_files: Option<&'a dyn Fn(&[String]) -> String>,
}

/// The contexts a workflow may name, whether or not the caller supplied them.
const NAMED_VALUES: &[&str] = &[
    "github", "env", "vars", "secrets", "inputs", "matrix", "strategy", "needs", "steps", "job",
    "jobs", "runner",
];

/// Evaluates one expression (the text between `${{` and `}}`, or a bare `if:`).
pub fn evaluate(expression: &str, scope: &Scope) -> Result<Value, String> {
    let ast = parse(expression, scope.contexts)?;
    Ok(eval(&ast, scope)?.into_value())
}

/// An `if:` value: with or without `${{ }}` around it; when the expression calls none of success/failure/cancelled/always, it is implicitly `success() && (expr)`. An empty condition is `success()`.
pub fn condition(text: &str, scope: &Scope) -> Result<bool, String> {
    let success = scope.status == Status::Success;
    let trimmed = text.trim();
    let source = match single_expression(trimmed) {
        Some(inner) => inner,
        // Text around or between expressions makes the whole thing a string,
        // as on GitHub: it is true whenever it interpolates to anything.
        None if has_expression(trimmed) => {
            let text = interpolate(trimmed, scope)?;
            return Ok(success && !text.is_empty());
        }
        None => trimmed,
    };
    if source.trim().is_empty() {
        return Ok(success);
    }
    let ast = parse(source, scope.contexts)?;
    if uses_status(&ast) {
        Ok(eval(&ast, scope)?.truthy())
    } else {
        Ok(success && eval(&ast, scope)?.truthy())
    }
}

/// Replaces each `${{ expr }}` in text with the value converted to a string. Text without `${{` is returned unchanged.
pub fn interpolate(text: &str, scope: &Scope) -> Result<String, String> {
    if !has_expression(text) {
        return Ok(text.to_string());
    }
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    while let Some(rel) = text[from..].find("${{") {
        let open = from + rel;
        out.push_str(&text[from..open]);
        let body = open + 3;
        let close = find_close(text, body).ok_or_else(|| {
            format!(
                "The expression is not closed. An unescaped ${{{{ sequence was found, but the closing }}}} sequence was not found: {text}"
            )
        })?;
        let value = evaluate(&text[body..close], scope)?;
        out.push_str(&to_text(&value));
        from = close + 2;
    }
    out.push_str(&text[from..]);
    Ok(out)
}

/// Interpolates every string inside a JSON value (keys too). If a string is exactly one `${{ expr }}` and nothing else, the result keeps the expression's type (as GitHub does for e.g. `strategy.matrix: ${{ fromJSON(...) }}`, `continue-on-error: ${{ ... }}`).
pub fn interpolate_value(value: &Value, scope: &Scope) -> Result<Value, String> {
    Ok(match value {
        Value::String(text) => match single_expression(text) {
            Some(inner) => evaluate(inner, scope)?,
            None => Value::String(interpolate(text, scope)?),
        },
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| interpolate_value(item, scope))
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                out.insert(interpolate(key, scope)?, interpolate_value(item, scope)?);
            }
            Value::Object(out)
        }
        other => other.clone(),
    })
}

/// false, 0, -0, NaN, "" and null are falsy; everything else is truthy.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A value as GitHub writes it into a string: null → "", bools "true"/"false", numbers as GitHub formats them (integers without ".0"), strings as-is, and `Array` or `Object` for collections, as GitHub's runner does (`toJSON` gives their contents).
pub fn to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => format_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(_) => "Array".to_owned(),
        Value::Object(_) => "Object".to_owned(),
    }
}

/// Whether text contains `${{`.
pub fn has_expression(text: &str) -> bool {
    text.contains("${{")
}

// ---------------------------------------------------------------------------
// Template scanning

/// Finds the `}}` closing an expression whose body starts at byte `from`,
/// skipping over string literals (which may themselves contain `}}`).
fn find_close(text: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut in_string = false;
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' => in_string = !in_string,
            b'}' if !in_string && bytes.get(i + 1) == Some(&b'}') => return Some(i),
            _ => {}
        }
        i += 1;
    }
    None
}

/// The body of text when text is exactly one `${{ expr }}` and nothing else.
fn single_expression(text: &str) -> Option<&str> {
    let text = text.trim();
    if !text.starts_with("${{") {
        return None;
    }
    let close = find_close(text, 3)?;
    (close + 2 == text.len()).then(|| &text[3..close])
}

// ---------------------------------------------------------------------------
// Lexing

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Null,
    True,
    False,
    Number(f64),
    Str(String),
    Ident(String),
    Dot,
    Star,
    LBracket,
    RBracket,
    LParen,
    RParen,
    Comma,
    Not,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    And,
    Or,
}

#[derive(Clone, Debug)]
struct Token {
    tok: Tok,
    /// 1-based character position within the expression.
    pos: usize,
    /// The token as written, for error messages.
    text: String,
}

fn located(message: &str, pos: usize, src: &str) -> String {
    format!("{message}. Located at position {pos} within expression: {src}")
}

fn lex(src: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut out: Vec<Token> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        let next = chars.get(i + 1).copied();
        // Whether a value (rather than an operator) may come next, which
        // decides whether `.5` is a number or a dereference.
        let value_may_start = out.last().is_none_or(|t| {
            !matches!(
                t.tok,
                Tok::Ident(_)
                    | Tok::Number(_)
                    | Tok::Str(_)
                    | Tok::Null
                    | Tok::True
                    | Tok::False
                    | Tok::RParen
                    | Tok::RBracket
                    | Tok::Star
            )
        });
        let starts_number = c.is_ascii_digit()
            || ((c == '-' || c == '+') && next.is_some_and(|n| n.is_ascii_digit() || n == '.'))
            || (c == '.' && value_may_start && next.is_some_and(|n| n.is_ascii_digit()));
        let tok = if starts_number {
            i += 1;
            while i < chars.len() {
                let d = chars[i];
                let so_far: String = chars[start..i].iter().collect();
                let hex = so_far
                    .trim_start_matches(['-', '+'])
                    .to_ascii_lowercase()
                    .starts_with("0x");
                let exponent_sign =
                    (d == '+' || d == '-') && matches!(chars[i - 1], 'e' | 'E') && !hex;
                if d.is_ascii_alphanumeric() || d == '.' || d == '_' || exponent_sign {
                    i += 1;
                } else {
                    break;
                }
            }
            let text: String = chars[start..i].iter().collect();
            match parse_number(&text, false) {
                Some(n) => Tok::Number(n),
                None => {
                    return Err(located(
                        &format!("Unexpected symbol: '{text}'"),
                        start + 1,
                        src,
                    ));
                }
            }
        } else if c.is_alphabetic() || c == '_' {
            i += 1;
            while i < chars.len()
                && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '-')
            {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            match word.as_str() {
                "null" => Tok::Null,
                "true" => Tok::True,
                "false" => Tok::False,
                _ => Tok::Ident(word),
            }
        } else if c == '\'' {
            i += 1;
            let mut s = String::new();
            loop {
                match chars.get(i) {
                    None => {
                        let text: String = chars[start..].iter().collect();
                        return Err(located(
                            &format!("Unexpected symbol: '{text}'"),
                            start + 1,
                            src,
                        ));
                    }
                    Some('\'') if chars.get(i + 1) == Some(&'\'') => {
                        s.push('\'');
                        i += 2;
                    }
                    Some('\'') => {
                        i += 1;
                        break;
                    }
                    Some(&ch) => {
                        s.push(ch);
                        i += 1;
                    }
                }
            }
            Tok::Str(s)
        } else {
            let two = |a: char, b: char| c == a && next == Some(b);
            let (tok, len) = if two('=', '=') {
                (Tok::Eq, 2)
            } else if two('!', '=') {
                (Tok::Ne, 2)
            } else if two('<', '=') {
                (Tok::Le, 2)
            } else if two('>', '=') {
                (Tok::Ge, 2)
            } else if two('&', '&') {
                (Tok::And, 2)
            } else if two('|', '|') {
                (Tok::Or, 2)
            } else {
                let tok = match c {
                    '.' => Tok::Dot,
                    '*' => Tok::Star,
                    '[' => Tok::LBracket,
                    ']' => Tok::RBracket,
                    '(' => Tok::LParen,
                    ')' => Tok::RParen,
                    ',' => Tok::Comma,
                    '!' => Tok::Not,
                    '<' => Tok::Lt,
                    '>' => Tok::Gt,
                    _ => {
                        return Err(located(
                            &format!("Unexpected symbol: '{c}'"),
                            start + 1,
                            src,
                        ));
                    }
                };
                (tok, 1)
            };
            i += len;
            tok
        };
        out.push(Token {
            tok,
            pos: start + 1,
            text: chars[start..i].iter().collect(),
        });
    }
    Ok(out)
}

/// Parses a number. Literals (`lenient == false`) must be exactly a number;
/// strings being coerced (`lenient == true`) may be padded with whitespace,
/// and the empty string is 0.
fn parse_number(text: &str, lenient: bool) -> Option<f64> {
    let s = if lenient { text.trim() } else { text };
    if s.is_empty() {
        return lenient.then_some(0.0);
    }
    let (negative, body) = match s.as_bytes()[0] {
        b'-' => (true, &s[1..]),
        b'+' => (false, &s[1..]),
        _ => (false, s),
    };
    let sign = if negative { -1.0 } else { 1.0 };
    let lower = body.to_ascii_lowercase();
    if let Some(hex) = lower.strip_prefix("0x") {
        return u64::from_str_radix(hex, 16).ok().map(|n| sign * n as f64);
    }
    if let Some(oct) = lower.strip_prefix("0o") {
        return u64::from_str_radix(oct, 8).ok().map(|n| sign * n as f64);
    }
    if lenient && body == "Infinity" {
        return Some(sign * f64::INFINITY);
    }
    // digits [. digits] [e [+-] digits], with at least one mantissa digit.
    let bytes = body.as_bytes();
    let mut i = 0;
    let mut mantissa_digits = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        mantissa_digits += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            mantissa_digits += 1;
        }
    }
    if mantissa_digits == 0 {
        return None;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let digits_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits_start {
            return None;
        }
    }
    if i != bytes.len() {
        return None;
    }
    let normalized = if body.starts_with('.') {
        format!("0{body}")
    } else {
        body.to_string()
    };
    normalized.parse::<f64>().ok().map(|n| sign * n)
}

// ---------------------------------------------------------------------------
// Parsing

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Func {
    Contains,
    StartsWith,
    EndsWith,
    Format,
    Join,
    ToJson,
    FromJson,
    HashFiles,
    Success,
    Always,
    Cancelled,
    Failure,
}

/// Name, function, fewest and most arguments.
const FUNCTIONS: &[(&str, Func, usize, usize)] = &[
    ("contains", Func::Contains, 2, 2),
    ("startsWith", Func::StartsWith, 2, 2),
    ("endsWith", Func::EndsWith, 2, 2),
    ("format", Func::Format, 1, usize::MAX),
    ("join", Func::Join, 1, 2),
    ("toJSON", Func::ToJson, 1, 1),
    ("fromJSON", Func::FromJson, 1, 1),
    ("hashFiles", Func::HashFiles, 1, usize::MAX),
    ("success", Func::Success, 0, 0),
    ("always", Func::Always, 0, 0),
    ("cancelled", Func::Cancelled, 0, 0),
    ("failure", Func::Failure, 0, 0),
];

#[derive(Clone, Copy, Debug)]
enum CmpOp {
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
}

#[derive(Debug)]
enum Expr {
    Literal(Value),
    Named(String),
    Property(Box<Expr>, String),
    Index(Box<Expr>, Box<Expr>),
    Wildcard(Box<Expr>),
    Not(Box<Expr>),
    Compare(CmpOp, Box<Expr>, Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Call(Func, Vec<Expr>),
}

fn parse(src: &str, contexts: &Map<String, Value>) -> Result<Expr, String> {
    let toks = lex(src)?;
    if toks.is_empty() {
        return Err(format!("An expression was expected: '{src}'"));
    }
    let mut parser = Parser {
        toks,
        i: 0,
        src,
        contexts,
    };
    let expr = parser.or()?;
    if parser.i < parser.toks.len() {
        return Err(parser.unexpected());
    }
    Ok(expr)
}

struct Parser<'s> {
    toks: Vec<Token>,
    i: usize,
    src: &'s str,
    contexts: &'s Map<String, Value>,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.i).map(|t| &t.tok)
    }

    fn eat(&mut self, tok: &Tok) -> bool {
        if self.peek() == Some(tok) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn unexpected(&self) -> String {
        match self.toks.get(self.i) {
            Some(t) => located(&format!("Unexpected symbol: '{}'", t.text), t.pos, self.src),
            None => match self.toks.last() {
                Some(t) => located(
                    &format!("Unexpected end of expression: '{}'", t.text),
                    t.pos,
                    self.src,
                ),
                None => format!("An expression was expected: '{}'", self.src),
            },
        }
    }

    fn or(&mut self) -> Result<Expr, String> {
        let mut left = self.and()?;
        while self.eat(&Tok::Or) {
            let right = self.and()?;
            left = Expr::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<Expr, String> {
        let mut left = self.equality()?;
        while self.eat(&Tok::And) {
            let right = self.equality()?;
            left = Expr::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn equality(&mut self) -> Result<Expr, String> {
        let mut left = self.comparison()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Eq) => CmpOp::Eq,
                Some(Tok::Ne) => CmpOp::Ne,
                _ => return Ok(left),
            };
            self.i += 1;
            let right = self.comparison()?;
            left = Expr::Compare(op, Box::new(left), Box::new(right));
        }
    }

    fn comparison(&mut self) -> Result<Expr, String> {
        let mut left = self.unary()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Lt) => CmpOp::Lt,
                Some(Tok::Le) => CmpOp::Le,
                Some(Tok::Gt) => CmpOp::Gt,
                Some(Tok::Ge) => CmpOp::Ge,
                _ => return Ok(left),
            };
            self.i += 1;
            let right = self.unary()?;
            left = Expr::Compare(op, Box::new(left), Box::new(right));
        }
    }

    fn unary(&mut self) -> Result<Expr, String> {
        if self.eat(&Tok::Not) {
            return Ok(Expr::Not(Box::new(self.unary()?)));
        }
        self.postfix()
    }

    fn postfix(&mut self) -> Result<Expr, String> {
        let mut expr = self.primary()?;
        loop {
            if self.eat(&Tok::Dot) {
                let token = self.toks.get(self.i).cloned();
                expr = match token.map(|t| (t.tok, t.text)) {
                    Some((Tok::Star, _)) => Expr::Wildcard(Box::new(expr)),
                    Some((Tok::Ident(name), _)) => Expr::Property(Box::new(expr), name),
                    Some((Tok::True | Tok::False | Tok::Null, text)) => {
                        Expr::Property(Box::new(expr), text)
                    }
                    _ => return Err(self.unexpected()),
                };
                self.i += 1;
            } else if self.eat(&Tok::LBracket) {
                if self.peek() == Some(&Tok::Star)
                    && self.toks.get(self.i + 1).map(|t| &t.tok) == Some(&Tok::RBracket)
                {
                    self.i += 2;
                    expr = Expr::Wildcard(Box::new(expr));
                } else {
                    let index = self.or()?;
                    if !self.eat(&Tok::RBracket) {
                        return Err(self.unexpected());
                    }
                    expr = Expr::Index(Box::new(expr), Box::new(index));
                }
            } else {
                return Ok(expr);
            }
        }
    }

    fn primary(&mut self) -> Result<Expr, String> {
        let Some(token) = self.toks.get(self.i).cloned() else {
            return Err(self.unexpected());
        };
        self.i += 1;
        match token.tok {
            Tok::Null => Ok(Expr::Literal(Value::Null)),
            Tok::True => Ok(Expr::Literal(Value::Bool(true))),
            Tok::False => Ok(Expr::Literal(Value::Bool(false))),
            Tok::Number(n) => Ok(Expr::Literal(number(n))),
            Tok::Str(s) => Ok(Expr::Literal(Value::String(s))),
            Tok::LParen => {
                let inner = self.or()?;
                if !self.eat(&Tok::RParen) {
                    return Err(self.unexpected());
                }
                Ok(inner)
            }
            Tok::Ident(name) if self.peek() == Some(&Tok::LParen) => {
                self.i += 1;
                self.call(&name, token.pos)
            }
            Tok::Ident(name) => {
                let known = NAMED_VALUES.iter().any(|n| n.eq_ignore_ascii_case(&name))
                    || self.contexts.keys().any(|k| k.eq_ignore_ascii_case(&name));
                if !known {
                    return Err(located(
                        &format!("Unrecognized named-value: '{name}'"),
                        token.pos,
                        self.src,
                    ));
                }
                Ok(Expr::Named(name))
            }
            _ => {
                self.i -= 1;
                Err(self.unexpected())
            }
        }
    }

    fn call(&mut self, name: &str, pos: usize) -> Result<Expr, String> {
        let Some(&(canonical, func, min, max)) = FUNCTIONS
            .iter()
            .find(|(n, ..)| n.eq_ignore_ascii_case(name))
        else {
            return Err(located(
                &format!("Unrecognized function: '{name}'"),
                pos,
                self.src,
            ));
        };
        let mut args = Vec::new();
        if !self.eat(&Tok::RParen) {
            loop {
                args.push(self.or()?);
                if self.eat(&Tok::Comma) {
                    continue;
                }
                if self.eat(&Tok::RParen) {
                    break;
                }
                return Err(self.unexpected());
            }
        }
        if args.len() < min {
            return Err(located(
                &format!("Too few parameters supplied: '{canonical}'"),
                pos,
                self.src,
            ));
        }
        if args.len() > max {
            return Err(located(
                &format!("Too many parameters supplied: '{canonical}'"),
                pos,
                self.src,
            ));
        }
        Ok(Expr::Call(func, args))
    }
}

/// Whether the expression calls success(), failure(), cancelled() or always().
fn uses_status(expr: &Expr) -> bool {
    match expr {
        Expr::Literal(_) | Expr::Named(_) => false,
        Expr::Property(base, _) | Expr::Wildcard(base) | Expr::Not(base) => uses_status(base),
        Expr::Index(a, b) | Expr::Compare(_, a, b) | Expr::And(a, b) | Expr::Or(a, b) => {
            uses_status(a) || uses_status(b)
        }
        Expr::Call(func, args) => {
            matches!(
                func,
                Func::Success | Func::Failure | Func::Cancelled | Func::Always
            ) || args.iter().any(uses_status)
        }
    }
}

// ---------------------------------------------------------------------------
// Evaluation

/// A value while evaluating: borrowed from the contexts where possible, and
/// a filtered array (the result of a `*`) kept apart, since property access on
/// it applies to every item.
enum Ev<'c> {
    One(Cow<'c, Value>),
    Filtered(Vec<Cow<'c, Value>>),
}

impl Ev<'_> {
    fn into_value(self) -> Value {
        match self {
            Ev::One(v) => v.into_owned(),
            Ev::Filtered(items) => Value::Array(items.into_iter().map(Cow::into_owned).collect()),
        }
    }

    fn truthy(&self) -> bool {
        match self {
            Ev::One(v) => truthy(v),
            Ev::Filtered(_) => true,
        }
    }
}

fn owned<'c>(value: Value) -> Ev<'c> {
    Ev::One(Cow::Owned(value))
}

/// A key on an object: the exact key if present, otherwise ignoring ASCII case.
fn find_key<'m>(map: &'m Map<String, Value>, key: &str) -> Option<&'m String> {
    if let Some((k, _)) = map.get_key_value(key) {
        return Some(k);
    }
    map.keys().find(|k| k.eq_ignore_ascii_case(key))
}

enum Key {
    Name(String),
    Index(usize),
}

fn child<'c>(value: Cow<'c, Value>, key: &Key) -> Option<Cow<'c, Value>> {
    match (value, key) {
        (Cow::Borrowed(Value::Object(map)), Key::Name(name)) => find_key(map, name)
            .and_then(|k| map.get(k))
            .map(Cow::Borrowed),
        (Cow::Owned(Value::Object(mut map)), Key::Name(name)) => {
            let k = find_key(&map, name)?.clone();
            map.remove(&k).map(Cow::Owned)
        }
        (Cow::Borrowed(Value::Array(items)), Key::Index(i)) => items.get(*i).map(Cow::Borrowed),
        (Cow::Owned(Value::Array(items)), Key::Index(i)) => {
            items.into_iter().nth(*i).map(Cow::Owned)
        }
        _ => None,
    }
}

fn children(value: Cow<'_, Value>) -> Vec<Cow<'_, Value>> {
    match value {
        Cow::Borrowed(Value::Array(items)) => items.iter().map(Cow::Borrowed).collect(),
        Cow::Borrowed(Value::Object(map)) => map.values().map(Cow::Borrowed).collect(),
        Cow::Owned(Value::Array(items)) => items.into_iter().map(Cow::Owned).collect(),
        Cow::Owned(Value::Object(map)) => map.into_iter().map(|(_, v)| Cow::Owned(v)).collect(),
        _ => Vec::new(),
    }
}

/// The key `index` selects on `target`: a position on an array, a name on an object.
fn key_for(target: &Value, index: &Value) -> Option<Key> {
    match target {
        Value::Array(_) => {
            let n = to_number(index);
            (n.is_finite() && n >= 0.0).then(|| Key::Index(n.trunc() as usize))
        }
        Value::Object(_) => Some(Key::Name(to_text(index))),
        _ => None,
    }
}

fn eval<'c>(expr: &Expr, scope: &Scope<'c>) -> Result<Ev<'c>, String> {
    Ok(match expr {
        Expr::Literal(v) => owned(v.clone()),
        Expr::Named(name) => {
            let contexts: &'c Map<String, Value> = scope.contexts;
            match find_key(contexts, name).and_then(|k| contexts.get(k)) {
                Some(v) => Ev::One(Cow::Borrowed(v)),
                None => owned(Value::Null),
            }
        }
        Expr::Property(base, name) => {
            let key = Key::Name(name.clone());
            match eval(base, scope)? {
                Ev::One(v) => Ev::One(child(v, &key).unwrap_or(Cow::Owned(Value::Null))),
                Ev::Filtered(items) => {
                    Ev::Filtered(items.into_iter().filter_map(|it| child(it, &key)).collect())
                }
            }
        }
        Expr::Index(base, index) => {
            let base = eval(base, scope)?;
            let index = eval(index, scope)?.into_value();
            match base {
                Ev::One(v) => {
                    let found = key_for(&v, &index).and_then(|key| child(v, &key));
                    Ev::One(found.unwrap_or(Cow::Owned(Value::Null)))
                }
                Ev::Filtered(items) => Ev::Filtered(
                    items
                        .into_iter()
                        .filter_map(|it| key_for(&it, &index).and_then(|key| child(it, &key)))
                        .collect(),
                ),
            }
        }
        Expr::Wildcard(base) => match eval(base, scope)? {
            Ev::One(v) => Ev::Filtered(children(v)),
            Ev::Filtered(items) => Ev::Filtered(items.into_iter().flat_map(children).collect()),
        },
        Expr::Not(inner) => owned(Value::Bool(!eval(inner, scope)?.truthy())),
        Expr::And(a, b) => {
            let left = eval(a, scope)?;
            if !left.truthy() {
                return Ok(left);
            }
            eval(b, scope)?
        }
        Expr::Or(a, b) => {
            let left = eval(a, scope)?;
            if left.truthy() {
                return Ok(left);
            }
            eval(b, scope)?
        }
        Expr::Compare(op, a, b) => {
            let left = eval(a, scope)?.into_value();
            let right = eval(b, scope)?.into_value();
            let result = match op {
                CmpOp::Eq => loose_eq(&left, &right),
                CmpOp::Ne => !loose_eq(&left, &right),
                CmpOp::Lt => compare(&left, &right) == Some(Ordering::Less),
                CmpOp::Le => matches!(
                    compare(&left, &right),
                    Some(Ordering::Less | Ordering::Equal)
                ),
                CmpOp::Gt => compare(&left, &right) == Some(Ordering::Greater),
                CmpOp::Ge => {
                    matches!(
                        compare(&left, &right),
                        Some(Ordering::Greater | Ordering::Equal)
                    )
                }
            };
            owned(Value::Bool(result))
        }
        Expr::Call(func, args) => owned(call(*func, args, scope)?),
    })
}

fn call(func: Func, args: &[Expr], scope: &Scope) -> Result<Value, String> {
    let status = scope.status;
    match func {
        Func::Success => return Ok(Value::Bool(status == Status::Success)),
        Func::Failure => return Ok(Value::Bool(status == Status::Failure)),
        Func::Cancelled => return Ok(Value::Bool(status == Status::Cancelled)),
        Func::Always => return Ok(Value::Bool(true)),
        _ => {}
    }
    let values: Vec<Value> = args
        .iter()
        .map(|a| eval(a, scope).map(Ev::into_value))
        .collect::<Result<_, _>>()?;
    Ok(match func {
        Func::Contains => Value::Bool(match &values[0] {
            Value::Array(items) => items.iter().any(|item| loose_eq(item, &values[1])),
            search => upper(&to_text(search)).contains(&upper(&to_text(&values[1]))),
        }),
        Func::StartsWith => {
            Value::Bool(upper(&to_text(&values[0])).starts_with(&upper(&to_text(&values[1]))))
        }
        Func::EndsWith => {
            Value::Bool(upper(&to_text(&values[0])).ends_with(&upper(&to_text(&values[1]))))
        }
        Func::Format => Value::String(format_string(&values)?),
        Func::Join => {
            let separator = values.get(1).map_or_else(|| ",".to_string(), to_text);
            Value::String(match &values[0] {
                Value::Array(items) => items
                    .iter()
                    .map(to_text)
                    .collect::<Vec<_>>()
                    .join(&separator),
                other => to_text(other),
            })
        }
        Func::ToJson => Value::String(to_json(&values[0])),
        Func::FromJson => {
            let text = to_text(&values[0]);
            let parsed: Value = serde_json::from_str(&text)
                .map_err(|e| format!("Error from function 'fromJSON': {e}. Input: '{text}'"))?;
            normalize(parsed)
        }
        Func::HashFiles => {
            let patterns: Vec<String> = values.iter().map(to_text).collect();
            Value::String(scope.hash_files.map(|f| f(&patterns)).unwrap_or_default())
        }
        Func::Success | Func::Failure | Func::Cancelled | Func::Always => unreachable!(),
    })
}

/// format('{0} {1}', ...): `{N}` is the Nth argument after the format string,
/// `{{` and `}}` are literal braces, anything else with a brace is an error.
fn format_string(values: &[Value]) -> Result<String, String> {
    let template = to_text(&values[0]);
    let args: Vec<String> = values[1..].iter().map(to_text).collect();
    let invalid = || format!("The following format string is invalid: '{template}'");
    let chars: Vec<char> = template.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '{' if chars.get(i + 1) == Some(&'{') => {
                out.push('{');
                i += 2;
            }
            '}' if chars.get(i + 1) == Some(&'}') => {
                out.push('}');
                i += 2;
            }
            '{' => {
                let start = i + 1;
                let mut end = start;
                while end < chars.len() && chars[end].is_ascii_digit() {
                    end += 1;
                }
                if end == start || chars.get(end) != Some(&'}') {
                    return Err(invalid());
                }
                let digits: String = chars[start..end].iter().collect();
                let index: usize = digits.parse().map_err(|_| invalid())?;
                let arg = args.get(index).ok_or_else(|| {
                    format!(
                        "The following format string references more arguments than were supplied: '{template}'"
                    )
                })?;
                out.push_str(arg);
                i = end + 1;
            }
            '}' => return Err(invalid()),
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    Ok(out)
}

fn upper(s: &str) -> String {
    s.to_uppercase()
}

/// A value coerced to a number, as GitHub does when operand types differ.
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => parse_number(s, true).unwrap_or(f64::NAN),
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

/// GitHub's `==`: same types compare directly (strings ignoring case; arrays
/// and objects are never equal, since they cannot be the same instance here);
/// different types are both coerced to numbers, and NaN equals nothing.
fn loose_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(_), Value::Number(_)) => to_number(a) == to_number(b),
        (Value::String(x), Value::String(y)) => upper(x) == upper(y),
        (Value::Array(_), Value::Array(_)) | (Value::Object(_), Value::Object(_)) => false,
        _ => to_number(a) == to_number(b),
    }
}

/// GitHub's ordering for `<`, `<=`, `>`, `>=`; None when they do not compare.
fn compare(a: &Value, b: &Value) -> Option<Ordering> {
    match (a, b) {
        (Value::Null, Value::Null) => Some(Ordering::Equal),
        (Value::String(x), Value::String(y)) => Some(upper(x).cmp(&upper(y))),
        (Value::Array(_) | Value::Object(_), _) | (_, Value::Array(_) | Value::Object(_)) => None,
        _ => to_number(a).partial_cmp(&to_number(b)),
    }
}

/// A number as a JSON value, integral numbers as integers so they print and
/// serialize without a trailing ".0".
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// Integral floats as integers, all the way down.
fn normalize(value: Value) -> Value {
    match value {
        Value::Number(n) if n.is_f64() => number(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, normalize(v))).collect())
        }
        other => other,
    }
}

fn to_json(value: &Value) -> String {
    serde_json::to_string_pretty(&normalize(value.clone())).unwrap_or_default()
}

/// A number the way GitHub (.NET's "G15") writes it: up to 15 significant
/// digits, no trailing zeros, and scientific notation (`1E+15`, `1E-07`) for
/// very large or very small magnitudes.
fn format_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if n == 0.0 {
        return "0".to_string();
    }
    let scientific = format!("{:.14e}", n.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let mut digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    let mut out = String::new();
    if n < 0.0 {
        out.push('-');
    }
    if !(-5..15).contains(&exponent) {
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('E');
        out.push(if exponent < 0 { '-' } else { '+' });
        out.push_str(&format!("{:02}", exponent.abs()));
    } else if exponent >= 0 {
        let whole = exponent as usize + 1;
        if digits.len() > whole {
            out.push_str(&digits[..whole]);
            out.push('.');
            out.push_str(&digits[whole..]);
        } else {
            out.push_str(&digits);
            out.push_str(&"0".repeat(whole - digits.len()));
        }
    } else {
        out.push_str("0.");
        out.push_str(&"0".repeat((-exponent - 1) as usize));
        out.push_str(&digits);
    }
    out
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn contexts() -> Map<String, Value> {
        let value = json!({
            "github": {
                "ref": "refs/heads/main",
                "ref_name": "main",
                "event_name": "push",
                "repository": "syntaqx/g1t",
                "actor": "dependabot[bot]",
                "event": {
                    "pull_request": {
                        "number": 42,
                        "draft": false,
                        "title": "Fix the thing",
                        "head": { "ref": "feature/x" },
                        "labels": [{ "name": "bug" }, { "name": "Enhancement" }]
                    },
                    "issues": [
                        { "labels": [{ "name": "a" }, { "name": "b" }] },
                        { "labels": [{ "name": "c" }] }
                    ],
                    "head_commit": { "message": "fix: x [skip ci]" }
                }
            },
            "env": { "NODE_VERSION": "18", "EMPTY": "" },
            "vars": { "DEPLOY": "yes" },
            "secrets": { "TOKEN": "s3cret" },
            "inputs": { "debug": "true", "flag": true, "count": 3, "environment": "staging" },
            "matrix": { "os": "ubuntu-latest", "node": 18, "experimental": false },
            "strategy": { "fail-fast": true, "job-index": 0 },
            "steps": {
                "build": { "outputs": { "version": "1.2.3" }, "outcome": "success", "conclusion": "success" },
                "test": { "outputs": {}, "outcome": "failure", "conclusion": "success" },
                "my-step": { "outputs": { "cache-hit": "true" } }
            },
            "needs": {
                "setup": {
                    "result": "success",
                    "outputs": { "matrix": "{\"os\":[\"ubuntu-latest\",\"windows-latest\"],\"node\":[18,20]}" }
                }
            },
            "runner": { "os": "Linux", "arch": "X64" },
            "job": { "status": "success" }
        });
        match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    fn with<T>(status: Status, f: impl FnOnce(&Scope) -> T) -> T {
        let contexts = contexts();
        let hash = |patterns: &[String]| format!("hash({})", patterns.join("|"));
        let scope = Scope {
            contexts: &contexts,
            status,
            hash_files: Some(&hash),
        };
        f(&scope)
    }

    fn ev(expression: &str) -> Value {
        with(Status::Success, |s| evaluate(expression, s))
            .unwrap_or_else(|e| panic!("{expression}: {e}"))
    }

    fn err(expression: &str) -> String {
        with(Status::Success, |s| evaluate(expression, s)).unwrap_err()
    }

    fn cond(status: Status, text: &str) -> bool {
        with(status, |s| condition(text, s)).unwrap_or_else(|e| panic!("{text}: {e}"))
    }

    #[test]
    fn literals() {
        assert_eq!(ev("null"), Value::Null);
        assert_eq!(ev("true"), json!(true));
        assert_eq!(ev("false"), json!(false));
        assert_eq!(ev("711"), json!(711));
        assert_eq!(ev("-9.2"), json!(-9.2));
        assert_eq!(ev("0xff"), json!(255));
        assert_eq!(ev("-2.99e-2"), json!(-0.0299));
        assert_eq!(ev("1e3"), json!(1000));
        assert_eq!(ev("'Mona the Octocat'"), json!("Mona the Octocat"));
        assert_eq!(ev("'It''s open source!'"), json!("It's open source!"));
    }

    #[test]
    fn double_quotes_are_an_error() {
        let e = err("github.ref == \"main\"");
        assert!(
            e.starts_with("Unexpected symbol: '\"'. Located at position 15 within expression:"),
            "{e}"
        );
    }

    #[test]
    fn ref_is_main() {
        assert_eq!(ev("github.ref == 'refs/heads/main'"), json!(true));
        assert_eq!(ev("github.ref != 'refs/heads/main'"), json!(false));
    }

    #[test]
    fn starts_with_tag() {
        assert_eq!(ev("startsWith(github.ref, 'refs/tags/v')"), json!(false));
        assert_eq!(ev("startsWith(github.ref, 'REFS/heads/')"), json!(true));
        assert_eq!(ev("endsWith(github.repository, '/G1T')"), json!(true));
    }

    #[test]
    fn contains_labels_filter() {
        assert_eq!(
            ev("contains(github.event.pull_request.labels.*.name, 'bug')"),
            json!(true)
        );
        assert_eq!(
            ev("contains(github.event.pull_request.labels.*.name, 'enhancement')"),
            json!(true)
        );
        assert_eq!(
            ev("contains(github.event.pull_request.labels.*.name, 'docs')"),
            json!(false)
        );
    }

    #[test]
    fn nested_object_filters_flatten() {
        assert_eq!(
            ev("github.event.issues.*.labels.*.name"),
            json!(["a", "b", "c"])
        );
        assert_eq!(
            ev("github.event.pull_request.labels[*].name"),
            json!(["bug", "Enhancement"])
        );
        assert_eq!(
            ev("github.event.pull_request.*"),
            ev("github.event.pull_request.*")
        );
        assert_eq!(ev("matrix.nothing.*"), json!([]));
    }

    #[test]
    fn matrix_and() {
        assert_eq!(
            ev("matrix.os == 'ubuntu-latest' && matrix.node >= 18"),
            json!(true)
        );
        assert_eq!(
            ev("matrix.os == 'windows-latest' && matrix.node >= 18"),
            json!(false)
        );
    }

    #[test]
    fn step_outputs() {
        assert_eq!(ev("steps.build.outputs.version"), json!("1.2.3"));
        assert_eq!(
            ev("steps.my-step.outputs.cache-hit != 'true'"),
            json!(false)
        );
        assert_eq!(ev("steps.missing.outputs.version"), Value::Null);
    }

    #[test]
    fn format_with_hash_files() {
        assert_eq!(
            ev("format('{0}-{1}', runner.os, hashFiles('**/package-lock.json'))"),
            json!("Linux-hash(**/package-lock.json)")
        );
        assert_eq!(ev("hashFiles('a', 'b')"), json!("hash(a|b)"));
    }

    #[test]
    fn hash_files_without_sandbox_is_empty() {
        let contexts = contexts();
        let scope = Scope {
            contexts: &contexts,
            status: Status::Success,
            hash_files: None,
        };
        assert_eq!(
            evaluate("hashFiles('**/*.lock')", &scope).unwrap(),
            json!("")
        );
    }

    #[test]
    fn format_escapes_and_errors() {
        assert_eq!(
            ev("format('{{Hello {0} {1} {2}!}}', 'Mona', 'the', 'Octocat')"),
            json!("{Hello Mona the Octocat!}")
        );
        assert_eq!(ev("format('{0}{0}', 1)"), json!("11"));
        assert!(err("format('{1}', 'a')").contains("more arguments than were supplied"));
        assert!(err("format('{0', 'a')").contains("invalid"));
    }

    #[test]
    fn from_json_matrix() {
        assert_eq!(
            ev("fromJSON(needs.setup.outputs.matrix)"),
            json!({ "os": ["ubuntu-latest", "windows-latest"], "node": [18, 20] })
        );
        assert_eq!(
            ev("fromJSON(needs.setup.outputs.matrix).node[1]"),
            json!(20)
        );
        assert_eq!(ev("fromJSON('true')"), json!(true));
        assert_eq!(ev("fromJSON('3.0')"), json!(3));
        assert!(err("fromJSON('{nope')").contains("fromJSON"));
    }

    #[test]
    fn event_name_or() {
        assert_eq!(
            ev("github.event_name == 'push' || github.event_name == 'workflow_dispatch'"),
            json!(true)
        );
    }

    #[test]
    fn and_or_return_operands() {
        assert_eq!(ev("matrix.os && 'yes'"), json!("yes"));
        assert_eq!(ev("env.EMPTY && 'yes'"), json!(""));
        assert_eq!(ev("env.EMPTY || 'fallback'"), json!("fallback"));
        assert_eq!(ev("inputs.environment || 'production'"), json!("staging"));
        assert_eq!(ev("github.event.pull_request.draft || null"), Value::Null);
    }

    #[test]
    fn short_circuit_skips_errors() {
        assert_eq!(ev("false && fromJSON('{bad')"), json!(false));
        assert_eq!(ev("true || fromJSON('{bad')"), json!(true));
    }

    #[test]
    fn not_cancelled() {
        assert!(cond(Status::Success, "!cancelled()"));
        assert!(cond(Status::Failure, "!cancelled()"));
        assert!(!cond(Status::Cancelled, "!cancelled()"));
    }

    #[test]
    fn failure_and_outcome() {
        assert!(cond(
            Status::Failure,
            "failure() && steps.test.outcome == 'failure'"
        ));
        assert!(!cond(
            Status::Success,
            "failure() && steps.test.outcome == 'failure'"
        ));
        assert!(!cond(
            Status::Failure,
            "failure() && steps.build.outcome == 'failure'"
        ));
    }

    #[test]
    fn string_input_is_not_true() {
        // The famous gotcha: 'true' coerces to NaN when compared with a bool.
        assert_eq!(ev("inputs.debug == true"), json!(false));
        assert_eq!(ev("inputs.debug == 'true'"), json!(true));
        assert_eq!(ev("inputs.flag == true"), json!(true));
    }

    #[test]
    fn coercions() {
        assert_eq!(ev("'' == 0"), json!(true));
        assert_eq!(ev("null == false"), json!(true));
        assert_eq!(ev("null == 0"), json!(true));
        assert_eq!(ev("1 == '1'"), json!(true));
        assert_eq!(ev("'1.0' == 1"), json!(true));
        assert_eq!(ev("' 2 ' == 2"), json!(true));
        assert_eq!(ev("'0x10' == 16"), json!(true));
        assert_eq!(ev("true == 1"), json!(true));
        assert_eq!(ev("'abc' == 0"), json!(false));
        assert_eq!(ev("'abc' != 0"), json!(true));
        assert_eq!(ev("null == ''"), json!(true));
    }

    #[test]
    fn hex_and_exponent() {
        assert_eq!(ev("0x10 == 16"), json!(true));
        assert_eq!(ev("1e3 == 1000"), json!(true));
        assert_eq!(ev("-0x10 < 0"), json!(true));
    }

    #[test]
    fn case_insensitive_strings() {
        assert_eq!(ev("'ABC' == 'abc'"), json!(true));
        assert_eq!(ev("contains('Hello World', 'WORLD')"), json!(true));
        assert_eq!(ev("'a' < 'B'"), json!(true));
    }

    #[test]
    fn case_insensitive_names() {
        assert_eq!(ev("GitHub.Event_Name"), json!("push"));
        assert_eq!(ev("ENV.node_version"), json!("18"));
        assert_eq!(ev("StartsWith(github.ref, 'refs/')"), json!(true));
        assert_eq!(ev("TOJSON(1)"), json!("1"));
    }

    #[test]
    fn objects_and_arrays_are_never_equal() {
        assert_eq!(ev("github.event == github.event"), json!(false));
        assert_eq!(ev("fromJSON('[]') == fromJSON('[]')"), json!(false));
        assert_eq!(ev("fromJSON('[]') == 0"), json!(false));
        assert_eq!(ev("fromJSON('{}') < 1"), json!(false));
    }

    #[test]
    fn nan_compares_false() {
        assert_eq!(ev("'abc' < 1"), json!(false));
        assert_eq!(ev("'abc' >= 1"), json!(false));
        assert_eq!(ev("'abc' == 'abc'"), json!(true));
    }

    #[test]
    fn comparisons() {
        assert_eq!(ev("matrix.node > 16"), json!(true));
        assert_eq!(ev("matrix.node <= '18'"), json!(true));
        assert_eq!(ev("inputs.count < 3"), json!(false));
        assert_eq!(ev("null <= null"), json!(true));
        assert_eq!(ev("false < true"), json!(true));
    }

    #[test]
    fn precedence() {
        // ! binds tighter than ==, == tighter than &&, && tighter than ||.
        assert_eq!(ev("!matrix.experimental == true"), json!(true));
        assert_eq!(ev("true || false && false"), json!(true));
        assert_eq!(ev("(true || false) && false"), json!(false));
        assert_eq!(ev("1 < 2 == true"), json!(true));
        assert_eq!(ev("!!'x'"), json!(true));
    }

    #[test]
    fn indexing() {
        assert_eq!(ev("github['event']['pull_request']['number']"), json!(42));
        assert_eq!(ev("github.event.pull_request.labels[0].name"), json!("bug"));
        assert_eq!(ev("github.event.pull_request.labels[5]"), Value::Null);
        assert_eq!(ev("matrix['os']"), json!("ubuntu-latest"));
        assert_eq!(ev("strategy.fail-fast"), json!(true));
        assert_eq!(ev("strategy['job-index']"), json!(0));
    }

    #[test]
    fn missing_properties_are_null() {
        assert_eq!(ev("github.event.release.tag_name"), Value::Null);
        assert_eq!(ev("github.ref.nope"), Value::Null);
        assert_eq!(ev("jobs.anything"), Value::Null);
    }

    #[test]
    fn unrecognized_named_value() {
        let e = err("foo.bar == 1");
        assert_eq!(
            e,
            "Unrecognized named-value: 'foo'. Located at position 1 within expression: foo.bar == 1"
        );
        // Found at parse time, even in a branch that never runs.
        assert!(err("false && bogus").contains("Unrecognized named-value: 'bogus'"));
    }

    #[test]
    fn function_errors() {
        assert!(err("nope(1)").starts_with("Unrecognized function: 'nope'"));
        assert!(err("contains('a')").starts_with("Too few parameters supplied: 'contains'"));
        assert!(err("success(1)").starts_with("Too many parameters supplied: 'success'"));
        assert!(err("toJSON()").starts_with("Too few parameters supplied: 'toJSON'"));
    }

    #[test]
    fn syntax_errors() {
        assert!(err("github.ref ==").starts_with("Unexpected end of expression: '=='"));
        assert!(err("(true").starts_with("Unexpected end of expression"));
        assert!(err("true false").starts_with("Unexpected symbol: 'false'. Located at position 6"));
        assert!(err("'open").starts_with("Unexpected symbol: ''open'"));
        assert!(err("a = b").contains("Unexpected symbol"));
        assert!(err("github.").starts_with("Unexpected end of expression"));
        assert!(err("").contains("expression was expected"));
    }

    #[test]
    fn contains_array_uses_loose_equality() {
        assert_eq!(ev("contains(fromJSON('[1, 2, 3]'), '2')"), json!(true));
        assert_eq!(
            ev("contains(fromJSON('[\"push\", \"pull_request\"]'), github.event_name)"),
            json!(true)
        );
        assert_eq!(
            ev("contains(github.event.head_commit.message, '[skip ci]')"),
            json!(true)
        );
        assert_eq!(ev("contains(github.actor, '[bot]')"), json!(true));
    }

    #[test]
    fn join() {
        assert_eq!(
            ev("join(github.event.pull_request.labels.*.name)"),
            json!("bug,Enhancement")
        );
        assert_eq!(
            ev("join(github.event.pull_request.labels.*.name, ', ')"),
            json!("bug, Enhancement")
        );
        assert_eq!(ev("join('abc', '-')"), json!("abc"));
        assert_eq!(
            ev("join(fromJSON('[1, true, null]'), ' ')"),
            json!("1 true ")
        );
    }

    #[test]
    fn to_json_pretty() {
        assert_eq!(
            ev("toJSON(steps.build.outputs)"),
            json!("{\n  \"version\": \"1.2.3\"\n}")
        );
        assert_eq!(ev("toJSON('a')"), json!("\"a\""));
        assert_eq!(ev("toJSON(null)"), json!("null"));
        assert_eq!(ev("toJSON(0x10)"), json!("16"));
    }

    #[test]
    fn truthiness() {
        assert!(!truthy(&json!(false)));
        assert!(!truthy(&json!(0)));
        assert!(!truthy(&json!(-0.0)));
        assert!(!truthy(&json!("")));
        assert!(!truthy(&Value::Null));
        assert!(truthy(&json!("0")));
        assert!(truthy(&json!("false")));
        assert!(truthy(&json!([])));
        assert!(truthy(&json!({})));
        assert!(truthy(&json!(0.5)));
    }

    #[test]
    fn text_conversion() {
        assert_eq!(to_text(&Value::Null), "");
        assert_eq!(to_text(&json!(true)), "true");
        assert_eq!(to_text(&json!(3.0)), "3");
        assert_eq!(to_text(&json!(1.5)), "1.5");
        assert_eq!(to_text(&json!(-0.0299)), "-0.0299");
        assert_eq!(to_text(&json!(1e20)), "1E+20");
        assert_eq!(to_text(&json!(0.0000001)), "1E-07");
        assert_eq!(to_text(&json!(123456789012345_i64)), "123456789012345");
        assert_eq!(to_text(&json!(["a", 1])), "Array");
        assert_eq!(to_text(&json!({ "a": 1 })), "Object");
        assert_eq!(to_text(&json!("as-is")), "as-is");
    }

    #[test]
    fn condition_implicit_success() {
        assert!(cond(Status::Success, "github.event_name == 'push'"));
        assert!(!cond(Status::Failure, "github.event_name == 'push'"));
        assert!(!cond(Status::Cancelled, "github.event_name == 'push'"));
        assert!(!cond(
            Status::Success,
            "github.event_name == 'pull_request'"
        ));
    }

    #[test]
    fn condition_status_functions() {
        assert!(cond(Status::Failure, "always()"));
        assert!(cond(Status::Cancelled, "always()"));
        assert!(cond(Status::Failure, "failure()"));
        assert!(!cond(Status::Success, "failure()"));
        assert!(cond(Status::Cancelled, "cancelled()"));
        assert!(cond(Status::Success, "success()"));
        assert!(cond(
            Status::Failure,
            "${{ always() && github.ref == 'refs/heads/main' }}"
        ));
        // Nested inside another call still counts.
        assert!(cond(Status::Failure, "contains(toJSON(always()), 'true')"));
    }

    #[test]
    fn condition_status_not_by_substring() {
        // 'failure()' inside a string is not a call; implicit success() applies.
        assert!(!cond(Status::Failure, "steps.test.outcome != 'failure()'"));
        assert!(cond(Status::Success, "steps.test.outcome != 'failure()'"));
    }

    #[test]
    fn condition_wrapped_and_empty() {
        assert!(cond(
            Status::Success,
            "${{ github.ref == 'refs/heads/main' }}"
        ));
        assert!(!cond(
            Status::Success,
            "  ${{ github.ref == 'refs/heads/dev' }}  "
        ));
        assert!(cond(Status::Success, ""));
        assert!(!cond(Status::Failure, ""));
        assert!(cond(Status::Success, "${{ }}"));
        assert!(cond(Status::Success, "${{ matrix.os }}"));
        assert!(!cond(Status::Success, "${{ env.EMPTY }}"));
        assert!(cond(
            Status::Success,
            "vars.DEPLOY == 'yes' && !github.event.pull_request.draft"
        ));
    }

    #[test]
    fn condition_with_text_around_is_a_string() {
        // On GitHub this is always true: it's the string "false && x", not an expression.
        assert!(cond(Status::Success, "${{ false }} && x"));
    }

    #[test]
    fn interpolate_mixed_text() {
        let out = with(Status::Success, |s| {
            interpolate(
                "node-${{ matrix.node }}-${{ runner.os }}-${{ hashFiles('**/yarn.lock') }}",
                s,
            )
        })
        .unwrap();
        assert_eq!(out, "node-18-Linux-hash(**/yarn.lock)");
        let out = with(Status::Success, |s| {
            interpolate("echo \"PR #${{ github.event.pull_request.number }}: ${{ github.event.pull_request.title }}\"", s)
        })
        .unwrap();
        assert_eq!(out, "echo \"PR #42: Fix the thing\"");
    }

    #[test]
    fn interpolate_edge_cases() {
        assert_eq!(
            with(Status::Success, |s| interpolate("plain $text {{ x }}", s)).unwrap(),
            "plain $text {{ x }}"
        );
        assert_eq!(
            with(Status::Success, |s| interpolate("${{ '}}' }}!", s)).unwrap(),
            "}}!"
        );
        assert_eq!(
            with(Status::Success, |s| interpolate("[${{ env.MISSING }}]", s)).unwrap(),
            "[]"
        );
        assert_eq!(
            with(Status::Success, |s| interpolate("${{ 1.50 }}", s)).unwrap(),
            "1.5"
        );
        assert!(
            with(Status::Success, |s| interpolate("oops ${{ github.ref", s))
                .unwrap_err()
                .contains("not closed")
        );
        assert!(with(Status::Success, |s| interpolate("${{ \"x\" }}", s)).is_err());
    }

    #[test]
    fn interpolate_value_keeps_types() {
        let input = json!({
            "matrix": "${{ fromJSON(needs.setup.outputs.matrix) }}",
            "continue-on-error": "${{ matrix.experimental }}",
            "timeout-minutes": "${{ inputs.count }}",
            "name": "Build ${{ matrix.os }}",
            "env": { "VERSION_${{ matrix.node }}": "${{ steps.build.outputs.version }}" },
            "list": ["${{ github.event.pull_request.labels.*.name }}", 7, null],
            "plain": true
        });
        let out = with(Status::Success, |s| interpolate_value(&input, s)).unwrap();
        assert_eq!(
            out,
            json!({
                "matrix": { "os": ["ubuntu-latest", "windows-latest"], "node": [18, 20] },
                "continue-on-error": false,
                "timeout-minutes": 3,
                "name": "Build ubuntu-latest",
                "env": { "VERSION_18": "1.2.3" },
                "list": [["bug", "Enhancement"], 7, null],
                "plain": true
            })
        );
    }

    #[test]
    fn has_expression_detects() {
        assert!(has_expression("a ${{ b }}"));
        assert!(!has_expression("a ${ b }"));
        assert!(!has_expression("{{ b }}"));
    }

    #[test]
    fn dependabot_and_draft_guards() {
        assert!(!cond(Status::Success, "github.actor != 'dependabot[bot]'"));
        assert!(cond(
            Status::Success,
            "github.event.pull_request.draft == false"
        ));
        assert!(cond(
            Status::Success,
            "!contains(github.event.head_commit.message, '[skip deploy]')"
        ));
    }

    #[test]
    fn tag_release_condition() {
        let contexts = {
            let mut c = contexts();
            c["github"]["ref"] = json!("refs/tags/v1.4.0");
            c["github"]["event_name"] = json!("push");
            c
        };
        let scope = Scope {
            contexts: &contexts,
            status: Status::Success,
            hash_files: None,
        };
        assert!(
            condition(
                "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
                &scope
            )
            .unwrap()
        );
        assert_eq!(
            interpolate("${{ format('release-{0}', github.ref_name) }}", &scope).unwrap(),
            "release-main"
        );
    }

    #[test]
    fn needs_result_and_number_format() {
        assert!(cond(Status::Success, "needs.setup.result == 'success'"));
        assert_eq!(ev("format('{0}', 0.1)"), json!("0.1"));
        assert_eq!(ev("format('{0}', 100)"), json!("100"));
        assert_eq!(ev("format('{0}|{1}', null, true)"), json!("|true"));
    }
}
