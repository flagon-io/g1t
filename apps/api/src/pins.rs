//! Pinned projects: the projects a person keeps at the top of a
//! workspace's sidebar, in their order, up to eight a workspace. The
//! projects service keeps them; this is their public shape, in snake_case.
//!
//! A person's own: a personal access token or a session, never a
//! workspace's token or g1t's agents.

use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::{Op, Services};

fn failed(code: FailureCode, message: &str) -> Result<Outcome<Value>> {
    Ok(Outcome::fail(code, message))
}

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_lowercase)
}

/// A place in the pins, 0 first, given as a number or as digits.
fn position(input: &Value) -> Option<u32> {
    match &input["position"] {
        Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(digits) => digits.trim().parse().ok(),
        _ => None,
    }
}

/// The slugs `projects` names, in order: strings, or objects with a `slug`.
pub(crate) fn slugs(input: &Value) -> Option<Vec<String>> {
    input["projects"].as_array().map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str().or_else(|| item["slug"].as_str()))
            .map(|slug| slug.trim().to_lowercase())
            .filter(|slug| !slug.is_empty())
            .collect()
    })
}

/// A project as the projects service answers (camelCase), as the API shows
/// a pin: its place, what it is, and where it is.
pub(crate) fn pin_json(project: &Value, position: usize, site: &str) -> Value {
    let workspace = project["workspace"].as_str().unwrap_or_default();
    let slug = project["slug"].as_str().unwrap_or_default();
    json!({
        "position": position,
        "id": project["id"],
        "workspace": workspace,
        "slug": slug,
        "name": project["name"],
        "description": project["description"],
        "private": project["private"],
        "archived": project["archived"],
        "kind": project["kind"],
        "url": format!("{}/{workspace}/{slug}", site.trim_end_matches('/')),
        "pushed_at": project["pushedAt"],
        "updated_at": project["updatedAt"],
    })
}

fn pins_json(projects: &[Value], site: &str) -> Value {
    Value::Array(projects.iter().enumerate().map(|(at, project)| pin_json(project, at, site)).collect())
}

/// Runs one of the pin operations.
pub async fn run(op: Op, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let user = match viewer {
        Some(user) if user.kind == PrincipalKind::User => user,
        Some(_) => {
            return failed(
                FailureCode::Forbidden,
                "Pins are a person's own: use a personal access token, not a workspace's or an agent's.",
            );
        }
        None => return failed(FailureCode::Unauthenticated, "This needs a g1t access token."),
    };
    let Some(workspace) = text(input, "workspace") else {
        return failed(FailureCode::Invalid, "Give the workspace's slug.");
    };
    let site = services.addresses.site.as_str();
    let changed = |outcome: Outcome<Vec<Value>>| -> Result<Outcome<Value>> {
        Ok(match outcome {
            Outcome::Ok(projects) => Outcome::Ok(pins_json(&projects, site)),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    };
    match op {
        Op::ListPinnedProjects => {
            let shortcuts: Value = g1t_kit::call(
                &services.projects,
                "shortcuts",
                &json!({ "workspace": workspace, "viewer": viewer }),
            )
            .await?;
            let pinned = shortcuts["pinned"].as_array().cloned().unwrap_or_default();
            Ok(Outcome::Ok(pins_json(&pinned, site)))
        }
        Op::PinProject | Op::UnpinProject => {
            let Some(slug) = text(input, "project") else {
                return failed(FailureCode::Invalid, "Give the project's slug.");
            };
            let (method, args) = if op == Op::PinProject {
                ("pin", json!({ "actor": user, "workspace": workspace, "slug": slug, "position": position(input) }))
            } else {
                ("unpin", json!({ "actor": user, "workspace": workspace, "slug": slug }))
            };
            changed(g1t_kit::call(&services.projects, method, &args).await?)
        }
        Op::ReorderPinnedProjects => {
            let Some(order) = slugs(input) else {
                return failed(FailureCode::Invalid, "Give projects: every pinned project's slug, in the order you want them.");
            };
            changed(
                g1t_kit::call(
                    &services.projects,
                    "reorder_pins",
                    &json!({ "actor": user, "workspace": workspace, "slugs": order }),
                )
                .await?,
            )
        }
        _ => failed(FailureCode::Invalid, "Not a pin operation."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_is_snake_case_with_its_place_and_address() {
        let project = json!({
            "id": "prj_1", "workspace": "acme", "slug": "web", "name": "Web", "description": null,
            "private": true, "archived": false, "kind": "app", "pushedAt": "2026-10-07T10:00:00.000Z",
            "updatedAt": "2026-10-01T10:00:00.000Z", "descriptionInherited": false,
        });
        let pin = pin_json(&project, 2, "https://g1t.sh/");
        assert_eq!(pin["position"], 2);
        assert_eq!(pin["url"], "https://g1t.sh/acme/web");
        assert_eq!(pin["pushed_at"], "2026-10-07T10:00:00.000Z");
        assert!(pin.get("pushedAt").is_none());
        assert!(pin.get("descriptionInherited").is_none());
    }

    #[test]
    fn the_order_is_read_from_slugs_or_objects() {
        assert_eq!(slugs(&json!({ "projects": ["Web", { "slug": "api" }, ""] })), Some(vec!["web".into(), "api".into()]));
        assert_eq!(slugs(&json!({})), None);
    }
}
