//! `g1t secret`: a repository's or a workspace's secrets. Values go in and
//! never come back out.

use serde_json::{Value, json};
use std::io::{IsTerminal, Read};

use crate::cli::{SecretCommand, SecretDeleteArgs, SecretScope, SecretSetArgs};
use crate::client::{Call, Client};
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{Cell, ago, s};
use crate::repo::Repo;

pub fn run(ctx: &Ctx, command: SecretCommand) -> Result<()> {
    match command {
        SecretCommand::List(scope) => list(ctx, scope),
        SecretCommand::Set(args) => set(ctx, args),
        SecretCommand::Delete(args) => delete(ctx, args),
    }
}

enum Owner {
    Repo(Repo),
    Workspace(String),
}

impl Owner {
    fn label(&self) -> String {
        match self {
            Owner::Repo(r) => r.to_string(),
            Owner::Workspace(w) => format!("the workspace {w}"),
        }
    }
}

fn owner(ctx: &Ctx, scope: &SecretScope) -> Result<(Owner, Client)> {
    match &scope.workspace {
        Some(w) => Ok((Owner::Workspace(w.clone()), ctx.signed_in_client()?)),
        None => {
            let (repo, client) = ctx.repo_client()?;
            Ok((Owner::Repo(repo), client))
        }
    }
}

fn call<'a>(client: &'a Client, owner: &Owner, repo_op: &str, workspace_op: &str) -> Call<'a> {
    match owner {
        Owner::Repo(r) => client.op(repo_op).repo(r),
        Owner::Workspace(w) => client.op(workspace_op).arg("workspace", w),
    }
}

fn rows(client: &Client, owner: &Owner) -> Result<Vec<Value>> {
    let found = call(
        client,
        owner,
        "list_actions_secrets",
        "list_actions_secrets_for_workspace",
    )
    .send()?;
    Ok(super::items(found, "secrets")
        .into_iter()
        .filter(|r| r["kind"].as_str().is_none_or(|k| k == "secret"))
        .collect())
}

fn for_env(row: &Value, env: &str) -> bool {
    match row["environments"].as_array() {
        Some(list) if !list.is_empty() => list
            .iter()
            .any(|e| e.as_str().is_some_and(|e| e.eq_ignore_ascii_case(env))),
        _ => true,
    }
}

fn list(ctx: &Ctx, scope: SecretScope) -> Result<()> {
    let (owner, client) = owner(ctx, &scope)?;
    let mut secrets = rows(&client, &owner)?;
    if let Some(env) = &scope.env {
        secrets.retain(|r| for_env(r, env));
    }
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(secrets));
    }
    if secrets.is_empty() {
        eprintln!("No secrets in {}.", owner.label());
        return Ok(());
    }
    let out = &ctx.out;
    let joined = |v: &Value, empty: &str| {
        let list: Vec<&str> = v
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if list.is_empty() {
            empty.to_owned()
        } else {
            list.join(", ")
        }
    };
    let table: Vec<Vec<Cell>> = secrets
        .iter()
        .map(|r| {
            vec![
                Cell::styled(s(r, "name"), out.bold(s(r, "name"))),
                Cell::new(joined(&r["environments"], "all")),
                Cell::new(joined(&r["available_to"], "")),
                Cell::new(joined(&r["brokered_hosts"], "")),
                Cell::styled(ago(s(r, "updated_at")), out.dim(&ago(s(r, "updated_at")))),
            ]
        })
        .collect();
    out.table(
        &[
            "name",
            "environments",
            "available to",
            "brokered for",
            "updated",
        ],
        &table,
    )
}

/// The value: --body, or stdin, or typed at a hidden prompt.
fn value(given: Option<String>) -> Result<String> {
    if let Some(v) = given {
        return Ok(v);
    }
    if std::io::stdin().is_terminal() {
        if !crate::prompt::interactive() {
            return Err(crate::prompt::needed("The value", "--body or stdin"));
        }
        return crate::prompt::secret("Value:");
    }
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    // A file or `echo` ends with a newline that is not part of the secret.
    let text = text
        .strip_suffix('\n')
        .map(|t| t.strip_suffix('\r').unwrap_or(t))
        .unwrap_or(&text)
        .to_owned();
    Ok(text)
}

fn set(ctx: &Ctx, args: SecretSetArgs) -> Result<()> {
    let (owner, client) = owner(ctx, &args.scope)?;
    let value = value(args.body)?;
    if value.is_empty() {
        return Err(Error::usage("The value is empty."));
    }
    let name = args.name.to_uppercase();
    let mut call = call(
        &client,
        &owner,
        "set_actions_secret",
        "set_actions_secret_for_workspace",
    )
    .arg("setting", &name)
    .field("value", value);
    if let Some(env) = &args.scope.env {
        call = call.field("environments", json!([env]));
    }
    if !args.available_to.is_empty() {
        call = call.field("available_to", json!(args.available_to));
    }
    if !args.brokered_host.is_empty() {
        call = call.field("brokered_hosts", json!(args.brokered_host));
    }
    if let Some(note) = args.note {
        call = call.field("note", note);
    }
    let row = call.send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&row);
    }
    let env = args
        .scope
        .env
        .map(|e| format!(" for {e}"))
        .unwrap_or_default();
    eprintln!(
        "{} Set {name}{env} in {}.",
        ctx.out.green("✓"),
        owner.label()
    );
    Ok(())
}

fn delete(ctx: &Ctx, args: SecretDeleteArgs) -> Result<()> {
    let (owner, client) = owner(ctx, &args.scope)?;
    let name = args.name.to_uppercase();
    let mut call = call(
        &client,
        &owner,
        "delete_actions_secret",
        "delete_actions_secret_for_workspace",
    )
    .arg("setting", &name);
    if let Some(env) = &args.scope.env {
        // One environment's value: that row, by its id.
        let row = rows(&client, &owner)?
            .into_iter()
            .find(|r| {
                s(r, "name").eq_ignore_ascii_case(&name)
                    && r["environments"].as_array().is_some_and(|l| {
                        l.iter()
                            .any(|e| e.as_str().is_some_and(|e| e.eq_ignore_ascii_case(env)))
                    })
            })
            .ok_or_else(|| {
                Error::failed(format!(
                    "{name} has no value for {env} in {}.",
                    owner.label()
                ))
            })?;
        call = call.field("id", s(&row, "id"));
    }
    let gone = call.send()?;
    if ctx.out.structured() {
        return ctx
            .out
            .emit(&json!({ "deleted": gone != Value::Bool(false), "name": name }));
    }
    let env = args
        .scope
        .env
        .map(|e| format!(" for {e}"))
        .unwrap_or_default();
    eprintln!(
        "{} Deleted {name}{env} from {}.",
        ctx.out.green("✓"),
        owner.label()
    );
    Ok(())
}
