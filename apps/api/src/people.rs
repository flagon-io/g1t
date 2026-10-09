//! Usernames as their owners wrote them. Every person in an answer, the
//! REST API's and MCP's alike (an issue's `author`, a member, a
//! collaborator, whoever `whoami` is), carries `display_username` beside
//! `username`: `username` stays the lowercased key, stable for anything
//! that matches on it, and `display_username` is the case its owner chose
//! (`Ana`), the same as `username` when they chose none.
//!
//! The services keep the lowercased name; this fills the chosen case in on
//! the way out, with one call to identity per answer.

use std::collections::{BTreeSet, HashMap};

use g1t_contracts::identity::DisplayUsernamesArgs;
use serde_json::Value;

use crate::operations::Services;

/// The most people one answer looks up; the rest show `username` as it is.
const MOST: usize = 200;

/// Whether `object` is a person (or another principal) named by `username`,
/// rather than a set of credentials that happens to carry one.
fn names_someone(object: &serde_json::Map<String, Value>) -> bool {
    matches!(object.get("username"), Some(Value::String(name)) if !name.is_empty())
        && !object.contains_key("password")
}

/// The lowercased usernames in `value`, each once, at most [`MOST`].
pub fn usernames_in(value: &Value) -> Vec<String> {
    fn walk(value: &Value, out: &mut BTreeSet<String>) {
        match value {
            Value::Object(object) => {
                if names_someone(object)
                    && let Some(Value::String(name)) = object.get("username")
                {
                    out.insert(name.to_lowercase());
                }
                object.values().for_each(|value| walk(value, out));
            }
            Value::Array(items) => items.iter().for_each(|value| walk(value, out)),
            _ => {}
        }
    }
    let mut out = BTreeSet::new();
    walk(value, &mut out);
    out.into_iter().take(MOST).collect()
}

/// Gives every person in `value` a `display_username`: the case from
/// `chosen` (by lowercased username), one they already carry when it is
/// the same name, or else `username` itself.
pub fn fill(value: &mut Value, chosen: &HashMap<String, String>) {
    match value {
        Value::Object(object) => {
            if names_someone(object) {
                let username = object["username"].as_str().unwrap_or_default().to_owned();
                // A service's own `displayUsername` (a profile's) becomes this.
                let theirs = object.remove("displayUsername");
                let carried = object
                    .get("display_username")
                    .or(theirs.as_ref())
                    .and_then(Value::as_str)
                    .filter(|display| display.eq_ignore_ascii_case(&username))
                    .map(str::to_owned);
                let shown = chosen
                    .get(&username.to_lowercase())
                    .cloned()
                    .or(carried)
                    .unwrap_or(username);
                object.insert("display_username".to_owned(), Value::String(shown));
            }
            object.values_mut().for_each(|value| fill(value, chosen));
        }
        Value::Array(items) => items.iter_mut().for_each(|value| fill(value, chosen)),
        _ => {}
    }
}

/// `value` with each person's chosen case filled in. When identity does
/// not answer, the people are still given `display_username`, as their
/// `username`: an answer is never held up for it.
pub async fn name_people(services: &Services, mut value: Value) -> Value {
    let usernames = usernames_in(&value);
    if usernames.is_empty() {
        return value;
    }
    let chosen: HashMap<String, String> =
        g1t_kit::call(&services.identity, "display_usernames", &DisplayUsernamesArgs { usernames })
            .await
            .unwrap_or_default();
    fill(&mut value, &chosen);
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_person_in_an_answer_is_found_once() {
        let answer = json!({
            "issue": { "author": { "id": "usr_1", "username": "ana" }, "assignees": [{ "username": "bo" }, { "username": "ana" }] },
            "git": { "username": "ana", "password": "your g1t access token" },
            "count": 3,
        });
        assert_eq!(usernames_in(&answer), vec!["ana".to_owned(), "bo".to_owned()]);
    }

    #[test]
    fn people_get_the_case_they_chose_or_their_username() {
        let mut answer = json!({
            "author": { "id": "usr_1", "username": "ana" },
            "members": [{ "username": "bo" }, { "username": "cy", "display_username": "Cy" }],
            "git": { "username": "ana", "password": "your g1t access token" },
        });
        let chosen = HashMap::from([("ana".to_owned(), "Ana".to_owned())]);
        fill(&mut answer, &chosen);
        assert_eq!(answer["author"]["username"], "ana");
        assert_eq!(answer["author"]["display_username"], "Ana");
        assert_eq!(answer["members"][0]["display_username"], "bo");
        assert_eq!(answer["members"][1]["display_username"], "Cy");
        assert!(answer["git"].get("display_username").is_none());
    }

    #[test]
    fn a_carried_case_of_another_name_is_not_kept() {
        let mut answer = json!({ "username": "ana", "display_username": "Bob" });
        fill(&mut answer, &HashMap::new());
        assert_eq!(answer["display_username"], "ana");
    }

    #[test]
    fn a_profiles_own_spelling_is_folded_in() {
        let mut answer = json!({ "username": "ana", "displayUsername": "Ana" });
        fill(&mut answer, &HashMap::new());
        assert_eq!(answer, json!({ "username": "ana", "display_username": "Ana" }));
    }
}
