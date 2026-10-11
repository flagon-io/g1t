//! Customize over REST and MCP: what shapes how a workspace's agents work,
//! at `/workspaces/{workspace}/customize/…` and as the MCP `customize` tool.
//! Marketplaces the workspace reads plugins from, what Discover lists, the
//! plugins it installed and the agents they brought, and its connectors
//! (MCP servers connected once, then given to agents), with their keys and
//! grants. Also the bundle a job's Claude Code loads on a runner.
//!
//! The agents service keeps all of it and decides who may do what
//! (`services/agents/src/customize-rpc.ts`): members see, owners change,
//! and the bundle is read with a job's agent token or a workspace's. The
//! bundle holds connectors' secrets: the API hands it on and never keeps
//! or logs it. OAuth sign-in to a connector needs a browser, so it stays
//! on the site.

use g1t_contracts::rules::actor_kind;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::Services;

/// One operation on a workspace's Customize.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustomizeOp {
    ListMarketplaces,
    AddMarketplace,
    RemoveMarketplace,
    RefreshMarketplace,
    Discover,
    ListPlugins,
    GetPlugin,
    InstallPlugin,
    SetPluginEnabled,
    UninstallPlugin,
    UpdatePlugin,
    ListPluginAgents,
    ListConnectors,
    GetConnector,
    AddConnector,
    SetConnectorKey,
    RemoveConnector,
    RefreshConnector,
    GrantConnector,
    RevokeConnector,
    Bundle,
}

impl CustomizeOp {
    /// Every one: `Op::ALL` lists each as `Op::Customize(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [CustomizeOp; 21] = [
        CustomizeOp::ListMarketplaces,
        CustomizeOp::AddMarketplace,
        CustomizeOp::RemoveMarketplace,
        CustomizeOp::RefreshMarketplace,
        CustomizeOp::Discover,
        CustomizeOp::ListPlugins,
        CustomizeOp::GetPlugin,
        CustomizeOp::InstallPlugin,
        CustomizeOp::SetPluginEnabled,
        CustomizeOp::UninstallPlugin,
        CustomizeOp::UpdatePlugin,
        CustomizeOp::ListPluginAgents,
        CustomizeOp::ListConnectors,
        CustomizeOp::GetConnector,
        CustomizeOp::AddConnector,
        CustomizeOp::SetConnectorKey,
        CustomizeOp::RemoveConnector,
        CustomizeOp::RefreshConnector,
        CustomizeOp::GrantConnector,
        CustomizeOp::RevokeConnector,
        CustomizeOp::Bundle,
    ];

    pub fn name(self) -> &'static str {
        match self {
            CustomizeOp::ListMarketplaces => "list_marketplaces",
            CustomizeOp::AddMarketplace => "add_marketplace",
            CustomizeOp::RemoveMarketplace => "remove_marketplace",
            CustomizeOp::RefreshMarketplace => "refresh_marketplace",
            CustomizeOp::Discover => "discover",
            CustomizeOp::ListPlugins => "list_plugins",
            CustomizeOp::GetPlugin => "get_plugin",
            CustomizeOp::InstallPlugin => "install_plugin",
            CustomizeOp::SetPluginEnabled => "set_plugin_enabled",
            CustomizeOp::UninstallPlugin => "uninstall_plugin",
            CustomizeOp::UpdatePlugin => "update_plugin",
            CustomizeOp::ListPluginAgents => "list_plugin_agents",
            CustomizeOp::ListConnectors => "list_connectors",
            CustomizeOp::GetConnector => "get_connector",
            CustomizeOp::AddConnector => "add_connector",
            CustomizeOp::SetConnectorKey => "set_connector_key",
            CustomizeOp::RemoveConnector => "remove_connector",
            CustomizeOp::RefreshConnector => "refresh_connector",
            CustomizeOp::GrantConnector => "grant_connector",
            CustomizeOp::RevokeConnector => "revoke_connector",
            CustomizeOp::Bundle => "customize_bundle",
        }
    }

    /// The agents service method it passes through to.
    fn method(self) -> &'static str {
        match self {
            CustomizeOp::ListMarketplaces => "marketplaces",
            CustomizeOp::AddMarketplace => "add_marketplace",
            CustomizeOp::RemoveMarketplace => "remove_marketplace",
            CustomizeOp::RefreshMarketplace => "refresh_marketplace",
            CustomizeOp::Discover => "discover",
            CustomizeOp::ListPlugins => "plugin_installs",
            CustomizeOp::GetPlugin => "plugin",
            CustomizeOp::InstallPlugin => "install_plugin",
            CustomizeOp::SetPluginEnabled => "set_plugin_enabled",
            CustomizeOp::UninstallPlugin => "uninstall_plugin",
            CustomizeOp::UpdatePlugin => "update_plugin",
            CustomizeOp::ListPluginAgents => "plugin_agents",
            CustomizeOp::ListConnectors => "connectors",
            CustomizeOp::GetConnector => "connector",
            CustomizeOp::AddConnector => "add_connector",
            CustomizeOp::SetConnectorKey => "set_connector_key",
            CustomizeOp::RemoveConnector => "remove_connector",
            CustomizeOp::RefreshConnector => "refresh_connector",
            CustomizeOp::GrantConnector => "grant_connector",
            CustomizeOp::RevokeConnector => "revoke_connector",
            CustomizeOp::Bundle => "customize_bundle",
        }
    }

    /// For the API reference.
    pub fn title(self) -> &'static str {
        match self {
            CustomizeOp::ListMarketplaces => "List marketplaces",
            CustomizeOp::AddMarketplace => "Add a marketplace",
            CustomizeOp::RemoveMarketplace => "Remove a marketplace",
            CustomizeOp::RefreshMarketplace => "Refresh a marketplace",
            CustomizeOp::Discover => "Discover plugins and skills",
            CustomizeOp::ListPlugins => "List installed plugins",
            CustomizeOp::GetPlugin => "Get a plugin",
            CustomizeOp::InstallPlugin => "Install a plugin",
            CustomizeOp::SetPluginEnabled => "Switch a plugin on or off",
            CustomizeOp::UninstallPlugin => "Uninstall a plugin",
            CustomizeOp::UpdatePlugin => "Update a plugin",
            CustomizeOp::ListPluginAgents => "List plugin agents",
            CustomizeOp::ListConnectors => "List connectors",
            CustomizeOp::GetConnector => "Get a connector",
            CustomizeOp::AddConnector => "Add a connector",
            CustomizeOp::SetConnectorKey => "Set a connector's key",
            CustomizeOp::RemoveConnector => "Remove a connector",
            CustomizeOp::RefreshConnector => "Refresh a connector's tools",
            CustomizeOp::GrantConnector => "Give a connector to agents",
            CustomizeOp::RevokeConnector => "Take a connector back",
            CustomizeOp::Bundle => "Get the runner bundle",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            CustomizeOp::ListMarketplaces => "The marketplaces a workspace reads plugins from, in the open plugin format (`.claude-plugin/marketplace.json`): each with its `name` (the `@marketplace` part of a plugin's ref), `source` (`github` with `repo`, `g1t` with `repo`, `git` or `url` with `url`, or `builtin`), `builtin` (every workspace has it and it cannot be removed: claude-plugins-official, anthropic-agent-skills and g1t), `about`, `owner`, how many `plugins` it lists, `fetched_at` and `problem` (why its manifest could not be read, when it could not), who added it and when, and `can_remove`. Members only.",
            CustomizeOp::AddMarketplace => "Add a marketplace by `address`: `owner/repo` on GitHub, `workspace/name` for a repository on this g1t, a git address, or a link to a `marketplace.json`. `name` overrides the one its manifest gives. Its manifest is read at once; a marketplace that cannot be read is refused with `422`, saying why. At most 20 a workspace. Owners only. Recorded in the audit log.",
            CustomizeOp::RemoveMarketplace => "Remove a marketplace by its name (`marketplace`). Plugins installed from it stay installed, but get no updates and cannot be installed again until it is added back. Built-in marketplaces cannot be removed (`409`). Owners only. Recorded in the audit log.",
            CustomizeOp::RefreshMarketplace => "Read a marketplace's manifest again now, by its name (`marketplace`), and return it as list_marketplaces gives it. Marketplaces are refreshed on their own in the background; this is for seeing a change at once. Owners only.",
            CustomizeOp::Discover => "What a workspace can add, from every marketplace it reads: `plugins`, one per listing (`ref` as `name@marketplace`, `display_name`, `description`, `version`, `author`, `category`, `tags`, how g1t would `fetch` it, and `availability`: `available`, `installed` with `enabled`, `unavailable` with `why` for sources g1t cannot read such as npm or a command, or `soon` for g1t's own announced ones), `skills`, one per skill inside those plugins (`ref` as `plugin:skill`, with `added` when the library already has it), and the `marketplaces` themselves. Members only.",
            CustomizeOp::ListPlugins => "The plugins a workspace installed, switched off ones included: each with its `ref` (`name@marketplace`), `name`, `marketplace`, `display_name`, `description`, `version`, the commit it was read at (`sha`), how it is fetched (`fetch`), what it brought (`components`: skills, agents, commands, mcp_servers, and whether it carries hooks, lsp, bin or output_styles, which only Claude Code on a runner uses), `problems` met when installing, `enabled`, who installed it and when, and `update` when the marketplace lists a newer version. Members only.",
            CustomizeOp::GetPlugin => "One plugin's page by `ref` (`name@marketplace`, URL-encoded in a path: `@` as `%40`), installed or not: its marketplace `listing`, its `install` if any, its `components` and `readme` read from its source, its `manifest`, its subagents in full (`agents`) for hiring from, `problems`, and the marketplace it is listed in (`source`). Reads the plugin's files, so it takes a moment. Members only.",
            CustomizeOp::InstallPlugin => "Install a plugin by `ref` (`name@marketplace`) from a marketplace the workspace reads, at the commit its listing names, which it stays pinned to. Its skills and commands join the workspace's library as `plugin:skill`, its subagents become templates to hire from, and the remote MCP servers of its `.mcp.json` become connectors, unconnected until an owner signs in or gives a key; its hooks, LSP servers, output styles and binaries reach Claude Code on runners and never g1t's own agents. A plugin g1t cannot fetch (npm, a command, a git host g1t does not read) is refused with `422`. At most 100 a workspace. Owners only. Recorded in the audit log.",
            CustomizeOp::SetPluginEnabled => "Switch an installed plugin on or off by `ref`: `enabled` false keeps it installed but takes its skills, agents and connectors away from agents and leaves it out of runners' bundles; true brings them back. Owners only. Recorded in the audit log.",
            CustomizeOp::UninstallPlugin => "Uninstall a plugin by `ref`: its skills leave the library, its agent templates go, and the connectors it brought are removed with their secrets. Agents hired from its templates stay. Owners only. Recorded in the audit log.",
            CustomizeOp::UpdatePlugin => "Update an installed plugin by `ref`: read it again at the commit its marketplace now lists and pin it there. Its skills get new versions and keep their attachments, skills it no longer has are archived, its agent templates and components are rewritten, and a server it already brought keeps its connector; new remote servers become connectors. A plugin already at its marketplace's commit comes back unchanged. list_plugins shows `update` when there is one to take. Owners only. Recorded in the audit log.",
            CustomizeOp::ListPluginAgents => "The subagents installed plugins brought, as templates to hire an agent from: each with its `ref` (`plugin:agent`), `plugin`, `marketplace`, `name`, `description`, the system prompt as `prompt`, and its `model`, `skills` and `tools`. Members only.",
            CustomizeOp::ListConnectors => "A workspace's connectors: MCP servers connected once and given to agents. Each has its `id` (`con_…`), `name` (tools are offered to agents as `<name>__<tool>`), `title`, `url`, `category`, `auth` (`none`, `header` or `oauth`), `state` (`connected`, `needs_sign_in`, `needs_key` or `problem`, with `problem` saying why), `from` (the directory, a plugin's server, an address, or one agent's own server), its `tools` as last listed and `checked_at`, `header_name` for a key (the key itself is never returned), who it is `signed_in_as` for OAuth, its `grants` (where it reaches: every agent, a team or one agent), and who added it. g1t's own integrations (GitHub, trackers, alert sources, model providers) are list_integrations. Members only.",
            CustomizeOp::GetConnector => "One connector by `id`, in the shape list_connectors gives. Members only.",
            CustomizeOp::AddConnector => "Add a connector. `from` says where it comes from: `{\"kind\": \"directory\", \"id\"}` for one of the directory's remote MCP servers, `{\"kind\": \"plugin\", \"ref\", \"server\"}` for a server an installed plugin names, or `{\"kind\": \"address\", \"name\", \"url\"}` for any MCP server over HTTP (`name` is 2 to 32 lowercase letters, digits and hyphens). `auth` is `none`, `header` (give `header` with the header's `name` and `value`, kept sealed and never returned) or `oauth` (an owner then signs in on the site: sign-in needs a browser, so it has no route). Its tools are listed as soon as it can be reached. At most 50 a workspace. Owners only. Recorded in the audit log.",
            CustomizeOp::SetConnectorKey => "Put a key on a connector by `id`: `value` is the header's value, kept sealed and never returned, and `header_name` the header it is sent as (the one it had, or Authorization, when left out). Makes the connector use header auth, lists its tools again, and returns it. Owners only. Recorded in the audit log.",
            CustomizeOp::RemoveConnector => "Remove a connector by `id`, with its secrets and grants. Agents that had it lose its tools at their next turn. Owners only. Recorded in the audit log.",
            CustomizeOp::RefreshConnector => "Ask a connector's server for its tools again now, by `id`, and return the connector with its `tools`, `checked_at` and `state` as they are now. Owners only.",
            CustomizeOp::GrantConnector => "Give a connector by `id` to agents: `scope` is `workspace` (every agent), `team` (with `target`, the team's slug) or `agent` (with `target`, the agent's handle). Returns the connector with its `grants`. Owners only. Recorded in the audit log.",
            CustomizeOp::RevokeConnector => "Take a connector back from where one grant reaches, by the connector's `id` and the grant's id (`grant`). Returns the connector with its `grants`. Owners only. Recorded in the audit log.",
            CustomizeOp::Bundle => "What a job's Claude Code loads from the workspace's Customize, read once per job with the job's agent token (or a workspace's token; a person's token is refused): `plugins` to fetch at their pinned commit (`ref`, `name`, `fetch`, `version`; switched-off ones left out), the library `skills` that reach the job's agent as files (each `name` with its `files`: `path`, `content`, `encoding` utf8 or base64; a plugin's skills come with the plugin), and the `connectors` that reach it and are connected, each with its `name`, `url` and the `headers` that sign it in. Secrets are in it: it is for the runner, and g1t never keeps or logs it. See self-hosted runners, \"What a run gets from Customize\".",
        }
    }

    pub fn input(self) -> Value {
        let workspace = json!({ "type": "string", "description": "The workspace's slug." });
        let marketplace = json!({ "type": "string", "description": "The marketplace's name, as list_marketplaces gives it." });
        let plugin_ref = json!({ "type": "string", "description": "The plugin as name@marketplace, such as commit-commands@claude-plugins-official." });
        let id = json!({ "type": "string", "description": "The connector's id (con_…), from list_connectors." });
        let (properties, required): (Value, &[&str]) = match self {
            CustomizeOp::ListMarketplaces
            | CustomizeOp::Discover
            | CustomizeOp::ListPlugins
            | CustomizeOp::ListPluginAgents
            | CustomizeOp::ListConnectors
            | CustomizeOp::Bundle => (json!({ "workspace": workspace }), &["workspace"]),
            CustomizeOp::AddMarketplace => (
                json!({
                    "workspace": workspace,
                    "address": { "type": "string", "description": "owner/repo on GitHub, workspace/name for a repository here, a git address, or a link to a marketplace.json." },
                    "name": { "type": "string", "description": "What to call it here. The name its manifest gives when left out." },
                }),
                &["workspace", "address"],
            ),
            CustomizeOp::RemoveMarketplace | CustomizeOp::RefreshMarketplace => {
                (json!({ "workspace": workspace, "marketplace": marketplace }), &["workspace", "marketplace"])
            }
            CustomizeOp::GetPlugin | CustomizeOp::InstallPlugin | CustomizeOp::UninstallPlugin | CustomizeOp::UpdatePlugin => {
                (json!({ "workspace": workspace, "ref": plugin_ref }), &["workspace", "ref"])
            }
            CustomizeOp::SetPluginEnabled => (
                json!({
                    "workspace": workspace,
                    "ref": plugin_ref,
                    "enabled": { "type": "boolean", "description": "True to switch it on, false to switch it off." },
                }),
                &["workspace", "ref", "enabled"],
            ),
            CustomizeOp::GetConnector | CustomizeOp::RemoveConnector | CustomizeOp::RefreshConnector => (json!({ "workspace": workspace, "id": id }), &["workspace", "id"]),
            CustomizeOp::AddConnector => (
                json!({
                    "workspace": workspace,
                    "from": {
                        "type": "object",
                        "description": "Where it comes from: {\"kind\": \"directory\", \"id\"}, {\"kind\": \"plugin\", \"ref\", \"server\"} or {\"kind\": \"address\", \"name\", \"url\"}.",
                        "properties": {
                            "kind": { "type": "string", "enum": ["directory", "plugin", "address"] },
                            "id": { "type": "string", "description": "For directory: the directory entry's id." },
                            "ref": { "type": "string", "description": "For plugin: the installed plugin, as name@marketplace." },
                            "server": { "type": "string", "description": "For plugin: the server's name in its .mcp.json." },
                            "name": { "type": "string", "description": "For address: 2 to 32 lowercase letters, digits and hyphens." },
                            "url": { "type": "string", "description": "For address: the MCP server's https address." },
                        },
                        "required": ["kind"],
                    },
                    "auth": { "type": "string", "enum": ["none", "header", "oauth"], "description": "How it signs in. none when left out." },
                    "header": {
                        "type": ["object", "null"],
                        "description": "For header auth: the header's name and value. The value is kept sealed and never returned.",
                        "properties": {
                            "name": { "type": "string" },
                            "value": { "type": "string" },
                        },
                        "required": ["name", "value"],
                    },
                }),
                &["workspace", "from"],
            ),
            CustomizeOp::SetConnectorKey => (
                json!({
                    "workspace": workspace,
                    "id": id,
                    "header_name": { "type": "string", "description": "The header the key is sent as. The one it had, or Authorization, when left out." },
                    "value": { "type": "string", "description": "The key. Kept sealed; never returned." },
                }),
                &["workspace", "id", "value"],
            ),
            CustomizeOp::GrantConnector => (
                json!({
                    "workspace": workspace,
                    "id": id,
                    "scope": { "type": "string", "enum": ["workspace", "team", "agent"], "description": "Every agent, a team's agents, or one agent." },
                    "target": { "type": "string", "description": "The team's slug or the agent's handle; nothing for workspace." },
                }),
                &["workspace", "id", "scope"],
            ),
            CustomizeOp::RevokeConnector => (
                json!({
                    "workspace": workspace,
                    "id": id,
                    "grant": { "type": "string", "description": "The grant's id, from the connector's grants." },
                }),
                &["workspace", "id", "grant"],
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

fn text(input: &Value, key: &str) -> String {
    input[key].as_str().map(str::trim).unwrap_or_default().to_owned()
}

/// A boolean as sent: JSON, or a word from a form.
fn flag(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(word) => match word.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// What an operation asks the agents service beyond the workspace and the
/// viewer, read from the input, or why the input will not do.
fn arguments(op: CustomizeOp, input: &Value) -> std::result::Result<Value, String> {
    let mut args = json!({});
    let need = |key: &str, what: &str| {
        let value = text(input, key);
        if value.is_empty() {
            Err(what.to_owned())
        } else {
            Ok(value)
        }
    };
    match op {
        CustomizeOp::ListMarketplaces
        | CustomizeOp::Discover
        | CustomizeOp::ListPlugins
        | CustomizeOp::ListPluginAgents
        | CustomizeOp::ListConnectors
        | CustomizeOp::Bundle => {}
        CustomizeOp::AddMarketplace => {
            args["address"] = json!(need("address", "Give address: owner/repo, workspace/name, a git address or a link to marketplace.json.")?);
            if let Some(name) = input["name"].as_str().map(str::trim).filter(|name| !name.is_empty()) {
                args["name"] = json!(name);
            }
        }
        CustomizeOp::RemoveMarketplace | CustomizeOp::RefreshMarketplace => {
            args["name"] = json!(need("marketplace", "Name the marketplace.")?);
        }
        CustomizeOp::GetPlugin | CustomizeOp::InstallPlugin | CustomizeOp::UninstallPlugin | CustomizeOp::UpdatePlugin => {
            args["ref"] = json!(need("ref", "Name the plugin as name@marketplace.")?);
        }
        CustomizeOp::SetPluginEnabled => {
            args["ref"] = json!(need("ref", "Name the plugin as name@marketplace.")?);
            args["enabled"] = json!(flag(&input["enabled"]).ok_or("enabled is true or false.")?);
        }
        CustomizeOp::GetConnector | CustomizeOp::RemoveConnector | CustomizeOp::RefreshConnector => {
            args["id"] = json!(need("id", "Name the connector by its id (con_…).")?);
        }
        CustomizeOp::AddConnector => {
            let from = &input["from"];
            if !matches!(from["kind"].as_str(), Some("directory" | "plugin" | "address")) {
                return Err("from.kind is directory, plugin or address.".to_owned());
            }
            let auth = match input["auth"].as_str().map(str::trim) {
                None | Some("") | Some("none") => "none",
                Some(auth @ ("header" | "oauth")) => auth,
                Some(_) => return Err("auth is none, header or oauth.".to_owned()),
            };
            let header = match &input["header"] {
                Value::Null => Value::Null,
                header if header["name"].is_string() && header["value"].is_string() => {
                    json!({ "name": header["name"], "value": header["value"] })
                }
                _ => return Err("header has a name and a value.".to_owned()),
            };
            if auth == "header" && header.is_null() {
                return Err("Header auth needs header: its name and value.".to_owned());
            }
            args["input"] = json!({ "from": from, "auth": auth, "header": header });
        }
        CustomizeOp::SetConnectorKey => {
            args["id"] = json!(need("id", "Name the connector by its id (con_…).")?);
            args["value"] = json!(need("value", "Give value: the key.")?);
            if let Some(name) = input["header_name"].as_str().map(str::trim).filter(|name| !name.is_empty()) {
                args["header_name"] = json!(name);
            }
        }
        CustomizeOp::GrantConnector => {
            args["id"] = json!(need("id", "Name the connector by its id (con_…).")?);
            let scope = text(input, "scope");
            if !matches!(scope.as_str(), "workspace" | "team" | "agent") {
                return Err("scope is workspace, team or agent.".to_owned());
            }
            if scope != "workspace" {
                args["target"] = json!(need("target", "Give target: the team's slug or the agent's handle.")?);
            }
            args["scope"] = json!(scope);
        }
        CustomizeOp::RevokeConnector => {
            args["id"] = json!(need("id", "Name the connector by its id (con_…).")?);
            args["grant"] = json!(need("grant", "Name the grant by its id.")?);
        }
    }
    Ok(args)
}

pub async fn run(op: CustomizeOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let workspace = text(input, "workspace").to_lowercase();
    if workspace.is_empty() {
        return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace."));
    }
    let actor = viewer.clone().unwrap_or_default();
    // The bundle carries connectors' secrets: only a run's own token, or
    // the workspace's, reads it, never a person's. The agents service
    // checks this too.
    if op == CustomizeOp::Bundle && actor_kind(&actor) == "person" {
        return Ok(Outcome::fail(
            FailureCode::Forbidden,
            "The bundle is read with a job's agent token or a workspace's token, not a person's.",
        ));
    }
    let mut args = match arguments(op, input) {
        Ok(args) => args,
        Err(why) => return Ok(Outcome::fail(FailureCode::Invalid, &why)),
    };
    args["workspace"] = json!(workspace);
    args["viewer"] = json!(actor);
    g1t_kit::call(&services.agents, op.method(), &args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::scopes::{Level, scope_for};

    #[test]
    fn each_operation_is_described_and_scoped() {
        for op in CustomizeOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Customize(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("workspace")), "{}", op.name());
            let scope = scope_for(op.name()).unwrap();
            let changes = !matches!(
                op,
                CustomizeOp::ListMarketplaces
                    | CustomizeOp::Discover
                    | CustomizeOp::ListPlugins
                    | CustomizeOp::GetPlugin
                    | CustomizeOp::ListPluginAgents
                    | CustomizeOp::ListConnectors
                    | CustomizeOp::GetConnector
                    | CustomizeOp::Bundle
            );
            let expected = match op {
                CustomizeOp::Bundle => Level::Run,
                _ if changes => Level::Admin,
                _ => Level::Read,
            };
            assert_eq!(scope.level(), expected, "{}", op.name());
        }
        assert_eq!(scope_for("customize_bundle").unwrap().as_str(), "agents:run");
    }

    #[test]
    fn inputs_are_checked_before_the_call() {
        let bad = |op, input: Value| arguments(op, &input).unwrap_err();
        assert!(bad(CustomizeOp::AddMarketplace, json!({})).starts_with("Give address"));
        assert!(bad(CustomizeOp::SetPluginEnabled, json!({ "ref": "a@b" })).contains("enabled"));
        assert!(bad(CustomizeOp::AddConnector, json!({ "from": { "kind": "elsewhere" } })).contains("from.kind"));
        assert!(bad(CustomizeOp::AddConnector, json!({ "from": { "kind": "address", "name": "x", "url": "https://x" }, "auth": "header" })).contains("header"));
        assert!(bad(CustomizeOp::GrantConnector, json!({ "id": "con_1", "scope": "team" })).starts_with("Give target"));
        assert!(bad(CustomizeOp::GrantConnector, json!({ "id": "con_1", "scope": "everyone" })).contains("scope"));

        let ok = |op, input: Value| arguments(op, &input).unwrap();
        assert_eq!(ok(CustomizeOp::SetPluginEnabled, json!({ "ref": "a@b", "enabled": "false" })), json!({ "ref": "a@b", "enabled": false }));
        assert_eq!(ok(CustomizeOp::GrantConnector, json!({ "id": "con_1", "scope": "workspace", "target": "ignored" })), json!({ "id": "con_1", "scope": "workspace" }));
        assert_eq!(
            ok(CustomizeOp::AddConnector, json!({ "from": { "kind": "directory", "id": "linear" } })),
            json!({ "input": { "from": { "kind": "directory", "id": "linear" }, "auth": "none", "header": null } })
        );
        assert_eq!(
            ok(CustomizeOp::SetConnectorKey, json!({ "id": "con_1", "value": "k", "header_name": " X-Api-Key " })),
            json!({ "id": "con_1", "value": "k", "header_name": "X-Api-Key" })
        );
        assert_eq!(ok(CustomizeOp::GetPlugin, json!({ "ref": "commit-commands@claude-plugins-official" }))["ref"], "commit-commands@claude-plugins-official");
        // The path names a marketplace as `marketplace`; the agents service as `name`.
        assert_eq!(ok(CustomizeOp::RemoveMarketplace, json!({ "marketplace": "flagon-tools" })), json!({ "name": "flagon-tools" }));
        assert!(bad(CustomizeOp::RefreshMarketplace, json!({ "name": "flagon-tools" })).starts_with("Name the marketplace"));
    }
}
