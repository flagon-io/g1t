//! `g1t api`: any operation, by name or by path, with your token.

use serde_json::{Map, Value, json};
use std::io::Read;

use crate::cli::ApiArgs;
use crate::client::{Client, Reply, encode_segment};
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::ops::{self, Operation};
use crate::output::Cell;
use crate::repo::Repo;

/// A field's value, as `-F` reads it: JSON's literals and numbers become
/// themselves, `@file` a file's text, anything else a string.
pub fn typed(value: &str) -> Result<Value> {
    if let Some(path) = value.strip_prefix('@') {
        let text = if path == "-" {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            s
        } else {
            std::fs::read_to_string(path)
                .map_err(|e| Error::usage(format!("Could not read {path}: {e}")))?
        };
        return Ok(Value::String(text));
    }
    Ok(match value {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" => Value::Null,
        _ => match value.parse::<i64>() {
            Ok(n) => json!(n),
            Err(_) => match value.parse::<f64>() {
                Ok(f) if f.is_finite() && !value.starts_with('.') => json!(f),
                _ => Value::String(value.to_owned()),
            },
        },
    })
}

/// `-f`/`-F` pairs into one object: `a[]=x` adds to a list, `a[b]=x` sets
/// a key of an object.
pub fn fields(raw: &[String], typed_fields: &[String]) -> Result<Map<String, Value>> {
    let mut map = Map::new();
    let pairs = raw
        .iter()
        .map(|p| (p, false))
        .chain(typed_fields.iter().map(|p| (p, true)));
    for (pair, is_typed) in pairs {
        let (key, value) = pair
            .split_once('=')
            .ok_or_else(|| Error::usage(format!("`{pair}` is not KEY=VALUE.")))?;
        let value = if is_typed {
            typed(value)?
        } else {
            Value::String(value.to_owned())
        };
        if let Some(name) = key.strip_suffix("[]") {
            let slot = map
                .entry(name.to_owned())
                .or_insert_with(|| Value::Array(Vec::new()));
            match slot {
                Value::Array(list) => list.push(value),
                _ => {
                    return Err(Error::usage(format!(
                        "`{name}` is given both as a list and not."
                    )));
                }
            }
        } else if let Some((name, inner)) = key.strip_suffix(']').and_then(|k| k.split_once('[')) {
            let slot = map
                .entry(name.to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
            match slot {
                Value::Object(obj) => {
                    obj.insert(inner.to_owned(), value);
                }
                _ => {
                    return Err(Error::usage(format!(
                        "`{name}` is given both as an object and not."
                    )));
                }
            }
        } else {
            map.insert(key.to_owned(), value);
        }
    }
    Ok(map)
}

fn as_query(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(list) => list.iter().map(as_query).collect::<Vec<_>>().join(","),
        other => other.to_string(),
    }
}

/// What a request is, worked out from the arguments.
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
}

/// Fills `{owner}`, `{name}`, `{repo}` and `{workspace}` from the repository.
fn fill_placeholders(path: &str, repo: &dyn Fn() -> Result<Repo>) -> Result<String> {
    if !path.contains('{') {
        return Ok(path.to_owned());
    }
    let repo = repo()?;
    Ok(path
        .replace("{owner}", &encode_segment(&repo.owner))
        .replace("{workspace}", &encode_segment(&repo.owner))
        .replace("{name}", &encode_segment(&repo.name))
        .replace("{repo}", &encode_segment(&repo.name)))
}

/// A request to an operation: path parameters from the fields or the
/// repository, query parameters from the fields, the rest as its body.
pub fn plan_op(
    op: &Operation,
    method: Option<&str>,
    mut given: Map<String, Value>,
    repo: &dyn Fn() -> Result<Repo>,
) -> Result<Plan> {
    let mut path = op.path.to_owned();
    let mut repo_cache: Option<Repo> = None;
    for p in op.path_params() {
        let value = match given.remove(p.name) {
            Some(v) => as_query(&v),
            None => {
                let from_repo = matches!(p.name, "owner" | "name" | "workspace");
                if !from_repo {
                    return Err(Error::usage(format!(
                        "{} needs {}: pass -f {}=...",
                        op.id, p.name, p.name
                    )));
                }
                if repo_cache.is_none() {
                    repo_cache = Some(repo().map_err(|e| {
                        Error::usage(format!(
                            "{} needs {}: pass -f {}=... or --repo OWNER/NAME ({})",
                            op.id, p.name, p.name, e.message
                        ))
                    })?);
                }
                let r = repo_cache.as_ref().expect("set above");
                if p.name == "name" {
                    r.name.clone()
                } else {
                    r.owner.clone()
                }
            }
        };
        path = path.replace(&format!("{{{}}}", p.name), &encode_segment(&value));
    }
    let method = method
        .map(str::to_uppercase)
        .unwrap_or_else(|| op.method.to_owned());
    let mut query = Vec::new();
    let names: Vec<&str> = op.query_params().map(|p| p.name).collect();
    let has_body = !op.body.is_empty() || matches!(method.as_str(), "POST" | "PUT" | "PATCH");
    let mut body = Map::new();
    for (k, v) in given {
        if names.contains(&k.as_str()) || !has_body {
            query.push((k, as_query(&v)));
        } else {
            body.insert(k, v);
        }
    }
    let body = if has_body && (!body.is_empty() || method != "GET") {
        Some(Value::Object(body))
    } else {
        None
    };
    Ok(Plan {
        method,
        path,
        query,
        body,
    })
}

/// A request to a path: fields go in the query of a GET, the body otherwise.
pub fn plan_path(
    endpoint: &str,
    method: Option<&str>,
    given: Map<String, Value>,
    repo: &dyn Fn() -> Result<Repo>,
) -> Result<Plan> {
    let path = if endpoint.starts_with('/') || endpoint.starts_with("http") {
        endpoint.to_owned()
    } else {
        format!("/{endpoint}")
    };
    let path = fill_placeholders(&path, repo)?;
    let method = method.map(str::to_uppercase).unwrap_or_else(|| {
        if given.is_empty() {
            "GET".into()
        } else {
            "POST".into()
        }
    });
    if method == "GET" || method == "HEAD" {
        let query = given
            .iter()
            .map(|(k, v)| (k.clone(), as_query(v)))
            .collect();
        return Ok(Plan {
            method,
            path,
            query,
            body: None,
        });
    }
    let body = (!given.is_empty()).then_some(Value::Object(given));
    Ok(Plan {
        method,
        path,
        query: Vec::new(),
        body,
    })
}

/// Where the next page is, if there is one.
pub fn next_page(
    reply: &Reply,
    body: &Value,
    query: &[(String, String)],
) -> Option<(String, Vec<(String, String)>)> {
    if let Some(link) = reply.header("link") {
        for part in link.split(',') {
            let mut pieces = part.split(';');
            let url = pieces
                .next()?
                .trim()
                .trim_start_matches('<')
                .trim_end_matches('>');
            if pieces.any(|p| p.trim().replace(' ', "") == "rel=\"next\"") {
                return Some((url.to_owned(), Vec::new()));
            }
        }
    }
    let set = |key: &str, value: String| {
        let mut q: Vec<(String, String)> =
            query.iter().filter(|(k, _)| k != key).cloned().collect();
        q.push((key.to_owned(), value));
        q
    };
    for key in ["next_cursor", "next"] {
        if let Some(cursor) = body[key].as_str().filter(|c| !c.is_empty()) {
            return Some((String::new(), set("cursor", cursor.to_owned())));
        }
    }
    let page = body["page"].as_u64();
    if let Some(page) = page {
        let more = body["more"] == true
            || match (body["per_page"].as_u64(), body["total_count"].as_u64()) {
                (Some(per), Some(total)) => page * per < total,
                _ => false,
            };
        if more {
            return Some((String::new(), set("page", (page + 1).to_string())));
        }
    }
    None
}

/// The list in a page: the page itself, or its one list of items.
fn page_items(body: &Value) -> Vec<Value> {
    match body {
        Value::Array(list) => list.clone(),
        Value::Object(map) => {
            for key in [
                "items",
                "hits",
                "check_runs",
                "deployments",
                "workflow_runs",
                "environments",
            ] {
                if let Some(Value::Array(list)) = map.get(key) {
                    return list.clone();
                }
            }
            map.values()
                .find_map(|v| v.as_array().cloned())
                .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

fn list_ops(ctx: &Ctx, query: &str) -> Result<()> {
    let q = query.to_lowercase();
    let mapped = crate::mapping::by_operation();
    let found: Vec<&Operation> = ops::OPERATIONS
        .iter()
        .filter(|op| {
            q.is_empty()
                || op.id.contains(&q)
                || op.path.to_lowercase().contains(&q)
                || op.tag.to_lowercase().contains(&q)
                || op.summary.to_lowercase().contains(&q)
        })
        .collect();
    if ctx.out.structured() {
        let list: Vec<Value> = found
            .iter()
            .map(|op| {
                json!({
                    "id": op.id, "method": op.method, "path": op.path, "tag": op.tag, "summary": op.summary,
                    "scope": op.scope, "command": mapped.get(op.id),
                    "params": op.params.iter().map(|p| json!({ "name": p.name, "in": if p.location == ops::In::Path { "path" } else { "query" }, "type": p.kind, "required": p.required, "values": p.values })).collect::<Vec<_>>(),
                    "body": op.body.iter().map(|f| json!({ "name": f.name, "type": f.kind, "required": f.required, "values": f.values })).collect::<Vec<_>>(),
                })
            })
            .collect();
        return ctx.out.emit(&Value::Array(list));
    }
    let out = &ctx.out;
    let rows: Vec<Vec<Cell>> = found
        .iter()
        .map(|op| {
            vec![
                Cell::styled(op.id, out.bold(op.id)),
                Cell::new(op.method),
                Cell::new(op.path),
                Cell::styled(
                    mapped
                        .get(op.id)
                        .map(|c| format!("g1t {c}"))
                        .unwrap_or_default(),
                    out.cyan(
                        &mapped
                            .get(op.id)
                            .map(|c| format!("g1t {c}"))
                            .unwrap_or_default(),
                    ),
                ),
            ]
        })
        .collect();
    out.table(&["operation", "method", "path", "command"], &rows)
}

fn print_body(ctx: &Ctx, value: &Value, text: &str) -> Result<()> {
    if ctx.out.structured() {
        return ctx.out.emit(value);
    }
    if value.is_null() && !text.trim().is_empty() {
        println!("{}", text.trim_end());
        return Ok(());
    }
    if value.is_null() {
        return Ok(());
    }
    let shown = if ctx.out.tty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    }
    .expect("json");
    println!("{shown}");
    Ok(())
}

pub fn run(ctx: &Ctx, args: ApiArgs) -> Result<()> {
    if let Some(q) = &args.list {
        return list_ops(ctx, q);
    }
    let endpoint = args.endpoint.clone().ok_or_else(|| {
        Error::usage("Say what to call: an operation's name, or a path. List them with --list.")
    })?;
    // Git Bash turns `/user` into `C:/Program Files/Git/user` before we see it.
    let bytes = endpoint.as_bytes();
    if bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        return Err(Error::usage(format!(
            "`{endpoint}` is a Windows path: Git Bash rewrote a path starting with /. Leave the leading slash off, or set MSYS_NO_PATHCONV=1."
        )));
    }
    let given = fields(&args.raw_field, &args.field)?;
    let repo = || ctx.repo();
    let client: Client;
    let plan = if let Some(op) = (!endpoint.contains('/'))
        .then(|| ops::find(&endpoint))
        .flatten()
    {
        let plan = plan_op(op, args.method.as_deref(), given, &repo)?;
        client = client_for(ctx, op.path.contains("{owner}"))?;
        plan
    } else {
        if !endpoint.contains('/') && endpoint.contains('_') {
            return Err(Error::usage(format!(
                "No operation `{endpoint}`. List them: g1t api --list {}",
                endpoint.split('_').next().unwrap_or("")
            )));
        }
        let plan = plan_path(&endpoint, args.method.as_deref(), given, &repo)?;
        client = client_for(
            ctx,
            endpoint.contains("{owner}") || endpoint.starts_with("/repos/"),
        )?;
        plan
    };
    let mut headers: Vec<(String, String)> = Vec::new();
    for h in &args.header {
        let (k, v) = h
            .split_once(':')
            .ok_or_else(|| Error::usage(format!("`{h}` is not KEY:VALUE.")))?;
        headers.push((k.trim().to_owned(), v.trim().to_owned()));
    }
    let body: Option<Vec<u8>> = match &args.input {
        Some(path) => Some(if path == "-" {
            let mut b = Vec::new();
            std::io::stdin().read_to_end(&mut b)?;
            b
        } else {
            std::fs::read(path).map_err(|e| Error::usage(format!("Could not read {path}: {e}")))?
        }),
        None => plan
            .body
            .as_ref()
            .map(|b| serde_json::to_vec(b).expect("json")),
    };
    let mut path = plan.path.clone();
    let mut query = plan.query.clone();
    let mut pages = Vec::new();
    for page in 0..100 {
        let reply = client.raw(
            &plan.method,
            &path,
            &query,
            &headers,
            if page == 0 { body.clone() } else { None },
        )?;
        if args.include {
            println!("HTTP {}", reply.status);
            for (k, v) in &reply.headers {
                println!("{k}: {v}");
            }
            println!();
        }
        let value = reply.json().unwrap_or(Value::Null);
        if !(200..300).contains(&reply.status) {
            if !args.silent && !value.is_null() {
                println!("{}", serde_json::to_string(&value).expect("json"));
            }
            return Err(client.api_error(&reply));
        }
        let next = if args.paginate {
            next_page(&reply, &value, &query)
        } else {
            None
        };
        if args.slurp {
            pages.extend(page_items(&value));
        } else if !args.silent {
            print_body(ctx, &value, &reply.text)?;
        }
        match next {
            Some((url, q)) => {
                if !url.is_empty() {
                    path = url;
                }
                query = q;
            }
            None => break,
        }
    }
    if args.slurp && !args.silent {
        print_body(ctx, &Value::Array(pages), "")?;
    }
    Ok(())
}

/// A client for the repository's host when the call is about one.
fn client_for(ctx: &Ctx, about_repo: bool) -> Result<Client> {
    if about_repo
        && ctx.global.hostname.is_none()
        && (ctx.global.repo.is_some() || crate::git::ok(&["rev-parse", "--git-dir"]))
        && let Ok((_, client)) = ctx.repo_client()
    {
        return Ok(client);
    }
    ctx.client()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Kind;

    fn repo() -> Result<Repo> {
        Ok(Repo {
            host: "g1t.sh".into(),
            owner: "acme".into(),
            name: "web".into(),
        })
    }

    fn no_repo() -> Result<Repo> {
        Err(Error::usage("no repo"))
    }

    fn v(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn fields_take_types_lists_and_objects() {
        let map = fields(
            &v(&["title=Broken", "labels[]=docs", "labels[]=p1", "n=12"]),
            &v(&["draft=true", "count=3", "milestone=null", "meta[a]=1"]),
        )
        .unwrap();
        assert_eq!(
            Value::Object(map),
            json!({ "title": "Broken", "labels": ["docs", "p1"], "n": "12", "draft": true, "count": 3, "milestone": null, "meta": { "a": 1 } })
        );
        assert!(fields(&v(&["nope"]), &[]).is_err());
    }

    #[test]
    fn operations_fill_their_paths_from_the_repository() {
        let op = ops::get("list_issues");
        let mut given = Map::new();
        given.insert("state".into(), json!("closed"));
        let plan = plan_op(op, None, given, &repo).unwrap();
        assert_eq!(
            plan,
            Plan {
                method: "GET".into(),
                path: "/repos/acme/web/issues".into(),
                query: vec![("state".into(), "closed".into())],
                body: None
            }
        );

        let op = ops::get("create_issue");
        let mut given = Map::new();
        given.insert("title".into(), json!("Broken"));
        let plan = plan_op(op, None, given, &repo).unwrap();
        assert_eq!(plan.method, "POST");
        assert_eq!(plan.body, Some(json!({ "title": "Broken" })));

        let op = ops::get("get_issue");
        let err = plan_op(op, None, Map::new(), &repo).unwrap_err();
        assert!(err.message.contains("number"), "{}", err.message);
        let err = plan_op(ops::get("list_issues"), None, Map::new(), &no_repo).unwrap_err();
        assert_eq!(err.kind, Kind::Usage);
    }

    #[test]
    fn paths_fill_placeholders() {
        let plan = plan_path("repos/{owner}/{repo}/issues", None, Map::new(), &repo).unwrap();
        assert_eq!(plan.path, "/repos/acme/web/issues");
        assert_eq!(plan.method, "GET");
        let mut given = Map::new();
        given.insert("title".into(), json!("x"));
        let plan = plan_path("/repos/acme/web/issues", None, given, &no_repo).unwrap();
        assert_eq!(plan.method, "POST");
        assert_eq!(plan.body, Some(json!({ "title": "x" })));
    }

    #[test]
    fn pages_follow_cursors_pages_and_links() {
        let reply = |link: Option<&str>| Reply {
            status: 200,
            headers: link
                .map(|l| vec![("Link".to_owned(), l.to_owned())])
                .unwrap_or_default(),
            text: String::new(),
        };
        let q = vec![("per_page".to_owned(), "2".to_owned())];
        assert_eq!(
            next_page(&reply(None), &json!({ "items": [], "next": "c2" }), &q)
                .unwrap()
                .1,
            vec![
                ("per_page".into(), "2".into()),
                ("cursor".into(), "c2".into())
            ]
        );
        assert_eq!(
            next_page(
                &reply(None),
                &json!({ "page": 1, "per_page": 2, "total_count": 5 }),
                &q
            )
            .unwrap()
            .1[1],
            ("page".into(), "2".into())
        );
        assert!(
            next_page(
                &reply(None),
                &json!({ "page": 3, "per_page": 2, "total_count": 5 }),
                &q
            )
            .is_none()
        );
        assert!(next_page(&reply(None), &json!({ "next": null }), &q).is_none());
        let linked = next_page(&reply(Some("<https://api.g1t.sh/x?page=2>; rel=\"next\", <https://api.g1t.sh/x?page=9>; rel=\"last\"")), &json!([]), &q).unwrap();
        assert_eq!(linked.0, "https://api.g1t.sh/x?page=2");
    }
}
