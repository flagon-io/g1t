//! A repository's deploy keys over REST and MCP, at GitHub's addresses:
//! `GET`/`POST /repos/{owner}/{name}/keys` and
//! `GET`/`DELETE /repos/{owner}/{name}/keys/{id}`, and as actions of the
//! MCP `access` tool.
//!
//! Identity keeps them and decides who may see and change them
//! (`g1t_contracts::deploy_keys`): the Admin role on the repository, never
//! an agent, a workspace's token only when it was given Admin.

use g1t_contracts::deploy_keys::{AddDeployKeyArgs, DeployKeyArgs, DeployKeysArgs, RemoveDeployKeyArgs};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::{Services, repo_path};

/// One operation on deploy keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeployKeysOp {
    ListDeployKeys,
    GetDeployKey,
    CreateDeployKey,
    DeleteDeployKey,
}

impl DeployKeysOp {
    /// Every one: `Op::ALL` lists each as `Op::DeployKeys(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [DeployKeysOp; 4] = [
        DeployKeysOp::ListDeployKeys,
        DeployKeysOp::GetDeployKey,
        DeployKeysOp::CreateDeployKey,
        DeployKeysOp::DeleteDeployKey,
    ];

    pub fn name(self) -> &'static str {
        match self {
            DeployKeysOp::ListDeployKeys => "list_deploy_keys",
            DeployKeysOp::GetDeployKey => "get_deploy_key",
            DeployKeysOp::CreateDeployKey => "create_deploy_key",
            DeployKeysOp::DeleteDeployKey => "delete_deploy_key",
        }
    }

    /// For the API reference.
    pub fn title(self) -> &'static str {
        match self {
            DeployKeysOp::ListDeployKeys => "List deploy keys",
            DeployKeysOp::GetDeployKey => "Get a deploy key",
            DeployKeysOp::CreateDeployKey => "Create a deploy key",
            DeployKeysOp::DeleteDeployKey => "Delete a deploy key",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            DeployKeysOp::ListDeployKeys => "List a repository's deploy keys, oldest first: SSH keys that reach this one repository, for a server or a pipeline. Each has its `id` (`dk_…`), `title`, public `key`, `fingerprint` (`SHA256:…`), `read_only` (false when it may push), `created_at`, `created_by` (who added it) and `last_used_at` (null when it never signed in). Needs the Admin role on the repository; agents' tokens are refused.",
            DeployKeysOp::GetDeployKey => "Get one of a repository's deploy keys by its `id`, in the shape list_deploy_keys gives. Needs the Admin role on the repository.",
            DeployKeysOp::CreateDeployKey => "Add a deploy key to a repository: `key`, one line in OpenSSH public key format (ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa), and a `title`. It is read-only unless `read_only` is false, which lets it push, workflow files included. A key registered anywhere already, as a person's SSH key or another deploy key, is refused with `409`: give each machine its own. At most 100 keys a repository. Needs the Admin role on the repository and a confirmed email address; agents' tokens and workspace tokens without Admin are refused. Recorded in the workspace's audit log.",
            DeployKeysOp::DeleteDeployKey => "Delete one of a repository's deploy keys by its `id`. A machine using it can no longer clone or push. There is no editing a key: to change its title or access, delete it and add it again. Needs the Admin role on the repository. Recorded in the workspace's audit log.",
        }
    }

    pub fn input(self) -> Value {
        let repo = json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let id = json!({ "type": "string", "description": "The deploy key's id (dk_…), from list_deploy_keys." });
        let (properties, required): (Value, &[&str]) = match self {
            DeployKeysOp::ListDeployKeys => (json!({ "repo": repo }), &["repo"]),
            DeployKeysOp::GetDeployKey | DeployKeysOp::DeleteDeployKey => (json!({ "repo": repo, "id": id }), &["repo", "id"]),
            DeployKeysOp::CreateDeployKey => (
                json!({
                    "repo": repo,
                    "title": { "type": "string", "description": "A name for it, such as the machine that uses it. Left out, the key's comment, else \"Deploy key\"." },
                    "key": { "type": "string", "description": "The public key, one line in OpenSSH format: the contents of a .pub file." },
                    "read_only": { "type": "boolean", "description": "False lets it push, workflow files included. True (read-only) unless you say." },
                }),
                &["repo", "key"],
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

fn text(input: &Value, key: &str) -> String {
    input[key].as_str().map(str::trim).unwrap_or_default().to_owned()
}

/// `read_only` as sent: a boolean, or a word from a form. True unless said.
fn read_only(input: &Value) -> Option<bool> {
    match &input["read_only"] {
        Value::Null => Some(true),
        Value::Bool(read_only) => Some(*read_only),
        Value::String(word) => match word.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

pub async fn run(op: DeployKeysOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(path) = repo_path(input) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\"."));
    };
    let identity = &services.identity;
    let id = text(input, "id");
    if matches!(op, DeployKeysOp::GetDeployKey | DeployKeysOp::DeleteDeployKey) && id.is_empty() {
        return Ok(Outcome::fail(FailureCode::Invalid, "Name the deploy key by its id (dk_…)."));
    }
    let actor = || viewer.clone().unwrap_or_default();
    let surface = Some(services.audit.surface);
    match op {
        DeployKeysOp::ListDeployKeys => {
            g1t_kit::call(identity, "list_deploy_keys", &DeployKeysArgs { viewer: viewer.clone(), path }).await
        }
        DeployKeysOp::GetDeployKey => {
            g1t_kit::call(identity, "get_deploy_key", &DeployKeyArgs { viewer: viewer.clone(), path, id }).await
        }
        DeployKeysOp::CreateDeployKey => {
            let key = text(input, "key");
            if key.is_empty() {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give key: one line in OpenSSH public key format."));
            }
            let Some(read_only) = read_only(input) else {
                return Ok(Outcome::fail(FailureCode::Invalid, "read_only is true or false."));
            };
            let args = AddDeployKeyArgs { actor: actor(), path, title: text(input, "title"), key, read_only, surface };
            g1t_kit::call(identity, "add_deploy_key", &args).await
        }
        DeployKeysOp::DeleteDeployKey => {
            g1t_kit::call(identity, "remove_deploy_key", &RemoveDeployKeyArgs { actor: actor(), path, id, surface }).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::scopes::{Level, scope_for};

    #[test]
    fn read_only_is_true_unless_said() {
        assert_eq!(read_only(&json!({})), Some(true));
        assert_eq!(read_only(&json!({ "read_only": false })), Some(false));
        assert_eq!(read_only(&json!({ "read_only": "false" })), Some(false));
        assert_eq!(read_only(&json!({ "read_only": "maybe" })), None);
    }

    #[test]
    fn each_operation_is_described_and_scoped() {
        for op in DeployKeysOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::DeployKeys(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("repo")), "{}", op.name());
            let level = scope_for(op.name()).unwrap().level();
            let changes = matches!(op, DeployKeysOp::CreateDeployKey | DeployKeysOp::DeleteDeployKey);
            assert_eq!(level, if changes { Level::Admin } else { Level::Read }, "{}", op.name());
        }
    }
}
