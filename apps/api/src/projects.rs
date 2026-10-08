//! Projects: what a workspace builds and runs, where each runs, and its
//! links. The projects service keeps them and decides who may see or change
//! them; this is their public shape, in snake_case.

use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Map, Value, json};
use worker::Result;

use crate::operations::{Op, Services};

fn failed(code: FailureCode, message: &str) -> Result<Outcome<Value>> {
    Ok(Outcome::fail(code, message))
}

fn slug(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_lowercase)
}

/// A reason a kind was decided, as the API shows it.
fn reason_json(reason: &Value) -> Value {
    json!({ "by": reason["by"], "detail": reason["detail"] })
}

/// A project as the projects service answers (camelCase), as the API shows it.
pub(crate) fn project_json(project: &Value, site: &str) -> Value {
    let workspace = project["workspace"].as_str().unwrap_or_default();
    let slug = project["slug"].as_str().unwrap_or_default();
    let source = &project["source"];
    let repository = match (source["repo"]["namespace"].as_str(), source["repo"]["name"].as_str()) {
        (Some(namespace), Some(name)) => json!(format!("{namespace}/{name}")),
        _ => Value::Null,
    };
    let links = &project["links"];
    let custom: Vec<Value> = links["custom"]
        .as_array()
        .map(|items| items.iter().map(|link| json!({ "label": link["label"], "url": link["url"] })).collect())
        .unwrap_or_default();
    json!({
        "id": project["id"],
        "workspace": workspace,
        "slug": slug,
        "name": project["name"],
        "description": project["description"],
        "description_inherited": project["descriptionInherited"].as_bool().unwrap_or(false),
        "url": format!("{}/{workspace}/{slug}", site.trim_end_matches('/')),
        "repository": repository,
        "root_dir": source["rootDir"].as_str().unwrap_or_default(),
        "default_branch": source["defaultBranch"],
        "private": project["private"],
        "archived": project["archived"],
        "primary": project["primary"],
        "kind": project["kind"],
        "kind_reason": reason_json(&project["kindReason"]),
        "runs": project["runs"],
        "production_url": project["productionUrl"],
        "setting": { "kind": project["setting"]["kind"], "runs": project["setting"]["runs"] },
        "detected": {
            "kind": project["detected"]["kind"],
            "reason": reason_json(&project["detected"]["reason"]),
        },
        "ecosystem": project["ecosystem"],
        "links": {
            "homepage": links["homepage"],
            "homepage_inherited": links["homepageInherited"].as_bool().unwrap_or(false),
            "docs": links["docs"],
            "custom": custom,
        },
        "created_at": project["createdAt"],
        "updated_at": project["updatedAt"],
        "pushed_at": project["pushedAt"],
    })
}

/// The fields a change may set: (input, service, whether null clears it).
const CHANGES: &[(&str, &str, bool)] = &[
    ("name", "name", false),
    ("description", "description", true),
    ("root_dir", "rootDir", false),
    ("kind", "kind", false),
    ("runs", "runs", false),
    ("production_url", "productionUrl", true),
    ("homepage", "homepage", true),
    ("docs_url", "docsUrl", true),
];

/// The change `input` asks for, in the service's spelling: only what it
/// gives, with null passed on for what null clears.
pub(crate) fn changes(input: &Value) -> std::result::Result<Value, String> {
    let mut out = Map::new();
    for (key, field, clearable) in CHANGES {
        match input.get(*key) {
            None => {}
            Some(Value::Null) if *clearable => {
                out.insert((*field).to_owned(), Value::Null);
            }
            Some(Value::Null) => {}
            Some(Value::String(text)) => {
                out.insert((*field).to_owned(), json!(text));
            }
            Some(_) => {
                let kind = if *clearable { "a string or null" } else { "a string" };
                return Err(format!("{key} must be {kind}."));
            }
        }
    }
    match input.get("links") {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => {
            let mut links = Vec::with_capacity(items.len());
            for item in items {
                match (item["label"].as_str(), item["url"].as_str()) {
                    (Some(label), Some(url)) => links.push(json!({ "label": label, "url": url })),
                    _ => return Err("Each of links needs a label and a url.".to_owned()),
                }
            }
            out.insert("links".to_owned(), Value::Array(links));
        }
        Some(_) => return Err("links must be a list of { label, url }.".to_owned()),
    }
    Ok(Value::Object(out))
}

/// Runs one of the project operations.
pub async fn run(op: Op, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(workspace) = slug(input, "workspace") else {
        return failed(FailureCode::Invalid, "Give the workspace's slug.");
    };
    let site = services.addresses.site.as_str();
    let one = |outcome: Outcome<Value>| -> Outcome<Value> {
        match outcome {
            Outcome::Ok(project) => Outcome::Ok(project_json(&project, site)),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        }
    };
    if op == Op::ListProjects {
        let listed: Outcome<Vec<Value>> =
            g1t_kit::call(&services.projects, "list", &json!({ "workspace": workspace, "viewer": viewer })).await?;
        return Ok(match listed {
            Outcome::Ok(projects) => {
                Outcome::Ok(Value::Array(projects.iter().map(|project| project_json(project, site)).collect()))
            }
            Outcome::Fail(failure) => Outcome::Fail(failure),
        });
    }
    let Some(project) = slug(input, "project") else {
        return failed(FailureCode::Invalid, "Give the project's slug.");
    };
    match op {
        Op::GetProject => Ok(one(
            g1t_kit::call(
                &services.projects,
                "get",
                &json!({ "workspace": workspace, "slug": project, "viewer": viewer }),
            )
            .await?,
        )),
        Op::UpdateProject => {
            let Some(actor) = viewer else {
                return failed(FailureCode::Unauthenticated, "This needs a g1t access token.");
            };
            let changes = match changes(input) {
                Ok(changes) => changes,
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            Ok(one(
                g1t_kit::call(
                    &services.projects,
                    "update",
                    &json!({ "actor": actor, "workspace": workspace, "slug": project, "changes": changes }),
                )
                .await?,
            ))
        }
        _ => failed(FailureCode::Invalid, "Not a project operation."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_kit::wire;

    fn project() -> Value {
        json!({
            "id": "prj_1", "workspace": "flagon-io", "slug": "g1t", "name": "g1t",
            "description": "Git hosting for people and agents.", "descriptionInherited": true,
            "source": {
                "kind": "hosted", "repoId": "repo_1", "repo": { "namespace": "flagon-io", "name": "g1t" },
                "rootDir": "", "defaultBranch": "main",
            },
            "private": false, "archived": false, "primary": true,
            "setting": { "kind": "app", "runs": "elsewhere" },
            "kind": "app", "kindReason": { "by": "set", "detail": "Set to an app." },
            "runs": "elsewhere", "productionUrl": "https://g1t.sh",
            "detected": { "kind": "app", "reason": { "by": "files", "detail": "It has a wrangler.jsonc." } },
            "ecosystem": null,
            "links": {
                "homepage": "https://g1t.sh", "homepageInherited": true, "docs": "https://docs.g1t.sh",
                "custom": [{ "label": "Status", "url": "https://status.g1t.sh" }],
            },
            "createdBy": "usr_1", "createdAt": "2026-09-01T10:00:00.000Z", "updatedAt": "2026-10-07T10:00:00.000Z",
            "pushedAt": "2026-10-07T09:00:00.000Z", "activity": 12.5,
        })
    }

    #[test]
    fn a_project_is_snake_case_with_its_address() {
        let shown = project_json(&project(), "https://g1t.sh/");
        assert!(wire::camel_case_keys(&shown).is_empty(), "{:?}", wire::camel_case_keys(&shown));
        assert_eq!(shown["url"], "https://g1t.sh/flagon-io/g1t");
        assert_eq!(shown["repository"], "flagon-io/g1t");
        assert_eq!(shown["root_dir"], "");
        assert_eq!(shown["default_branch"], "main");
        assert_eq!(shown["description_inherited"], true);
        assert_eq!(shown["kind_reason"]["by"], "set");
        assert_eq!(shown["production_url"], "https://g1t.sh");
        assert_eq!(shown["setting"]["runs"], "elsewhere");
        assert_eq!(shown["detected"]["reason"]["by"], "files");
        assert_eq!(shown["links"]["homepage_inherited"], true);
        assert_eq!(shown["links"]["custom"][0]["label"], "Status");
        assert_eq!(shown["pushed_at"], "2026-10-07T09:00:00.000Z");
        // What is the service's own business stays there.
        assert!(shown.get("source").is_none());
        assert!(shown.get("activity").is_none());
        assert!(shown.get("created_by").is_none());
    }

    #[test]
    fn a_change_is_only_what_is_given_in_the_service_s_spelling() {
        let asked = json!({
            "workspace": "flagon-io", "project": "g1t",
            "kind": "app", "runs": "elsewhere", "production_url": "https://g1t.sh",
            "root_dir": "apps/web", "docs_url": "docs.g1t.sh",
            "links": [{ "label": "Status", "url": "https://status.g1t.sh", "extra": 1 }],
        });
        let sent = changes(&asked).unwrap();
        assert_eq!(
            sent,
            json!({
                "kind": "app", "runs": "elsewhere", "productionUrl": "https://g1t.sh", "rootDir": "apps/web",
                "docsUrl": "docs.g1t.sh", "links": [{ "label": "Status", "url": "https://status.g1t.sh" }],
            })
        );
        assert!(sent.get("workspace").is_none());
        assert!(sent.get("name").is_none());
    }

    #[test]
    fn null_clears_what_it_can_and_absent_changes_nothing() {
        let sent = changes(&json!({ "description": null, "homepage": null, "production_url": null, "docs_url": null, "name": null, "kind": null })).unwrap();
        assert_eq!(sent, json!({ "description": null, "homepage": null, "productionUrl": null, "docsUrl": null }));
        assert_eq!(changes(&json!({})).unwrap(), json!({}));
        assert_eq!(changes(&json!({ "links": [] })).unwrap(), json!({ "links": [] }));
    }

    #[test]
    fn a_change_of_the_wrong_type_is_refused() {
        assert!(changes(&json!({ "kind": 3 })).is_err());
        assert!(changes(&json!({ "links": "https://g1t.sh" })).is_err());
        assert!(changes(&json!({ "links": [{ "url": "https://g1t.sh" }] })).is_err());
    }
}
