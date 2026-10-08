//! How a version update pull request reads: its branch (with
//! `pull-request-branch-name`), its title and commit message (with
//! `commit-message`), and its body, with what changed, where to read the
//! release notes, and the `@g1t` commands it takes.

use crate::config::{BranchName, CommitMessage, Entry};
use crate::manifests::DependencyType;
use crate::planning::{Planned, PullPlan};

/// What a branch starts with when `pull-request-branch-name.prefix` says
/// nothing.
pub const DEFAULT_BRANCH_PREFIX: &str = "g1t";
const DEFAULT_MAX_LENGTH: usize = 100;

/// The package manager's name in branch names: `npm_and_yarn`, `go_modules`, …
pub fn package_manager(ecosystem: &str) -> String {
    match ecosystem {
        "npm" => "npm_and_yarn".to_owned(),
        "gomod" => "go_modules".to_owned(),
        "gitsubmodule" => "submodules".to_owned(),
        "mix" => "hex".to_owned(),
        other => other.replace('-', "_"),
    }
}

/// FNV-1a, as ten hex digits: what keeps a shortened or grouped branch
/// name apart from another.
pub fn digest(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")[..10].to_owned()
}

/// A part of a branch name made safe: a dependency's `@` dropped, and
/// what a branch name cannot hold as `-`.
fn clean(text: &str) -> String {
    let text = text.trim_start_matches('@');
    let mut out = String::new();
    for c in text.chars() {
        let c = if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/') { c } else { '-' };
        out.push(c);
    }
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    out.trim_matches(['-', '.', '/']).to_owned()
}

/// The branch a pull request is made on. Without a template:
/// `<prefix>/<package manager>/<directory>/<dependency>-<version>` for one
/// dependency, `<prefix>/<package manager>/<directory>/<group>-<digest>`
/// for a group; the directory is left out for the root.
pub fn branch(entry: &Entry, plan: &PullPlan) -> String {
    let name: &BranchName = &entry.branch_name;
    let prefix = name.prefix.clone().unwrap_or_else(|| DEFAULT_BRANCH_PREFIX.to_owned());
    let manager = package_manager(&entry.ecosystem);
    let directories = plan.directories();
    let directory = if directories.len() == 1 { clean(directories[0].trim_start_matches('/')) } else { String::new() };
    let first = &plan.updates[0];
    let solo = plan.group.is_none() || plan.by_name;
    let dependency = clean(&first.name);
    let version = clean(&first.to);
    let group = plan.group.as_deref().map(clean).unwrap_or_default();
    let named = if solo { format!("{dependency}-{version}") } else { format!("{group}-{}", digest(&plan.signature())) };
    let rendered = match &name.template {
        Some(template) => {
            let mut text = template
                .replace("{prefix}", &prefix)
                .replace("{package_manager}", &manager)
                .replace("{directory}", &directory)
                .replace("{target_branch}", &clean(entry.target_branch.as_deref().unwrap_or_default()))
                .replace("{dependency}", &dependency)
                .replace("{version}", &version)
                .replace("{group_name}", &group)
                .replace("{name}", &named);
            if !solo && !template.contains("{name}") {
                text = format!("{text}-{}", digest(&plan.signature()));
            }
            text
        }
        None => [prefix.as_str(), manager.as_str(), directory.as_str(), named.as_str()]
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join("/"),
    };
    let rendered = rendered.split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("/");
    // Separators, words and case apply after the prefix.
    let (head, rest) = match rendered.strip_prefix(&prefix) {
        Some(rest) => (prefix.clone(), rest.to_owned()),
        None => (String::new(), rendered.clone()),
    };
    let mut rest = rest.replace('/', &name.separator);
    if let Some(word) = &name.word_separator {
        rest = rest.replace('_', word);
    }
    match name.case.as_deref() {
        Some("lowercase") => rest = rest.to_lowercase(),
        Some("uppercase") => rest = rest.to_uppercase(),
        _ => {}
    }
    let head = if head.is_empty() { head } else { head.replace('/', &name.separator) };
    let full = format!("{head}{rest}");
    let limit = name.max_length.map_or(DEFAULT_MAX_LENGTH, |length| length as usize);
    if full.chars().count() <= limit {
        return full;
    }
    let keep: String = full.chars().take(limit.saturating_sub(11)).collect();
    format!("{}-{}", keep.trim_end_matches(['-', '/', '.', '_']), digest(&full))
}

/// The commit message's prefix for this pull request, ready to go before
/// "bump": `build(deps): `, `chore: `, `[deps] `, or nothing.
pub fn prefix(message: Option<&CommitMessage>, development: bool) -> String {
    let Some(message) = message else { return String::new() };
    let chosen = if development { message.prefix_development.as_deref().or(message.prefix.as_deref()) } else { message.prefix.as_deref() };
    let mut text = match (chosen, message.scope) {
        (Some(text), _) => text.to_owned(),
        (None, true) => "chore".to_owned(),
        (None, false) => return String::new(),
    };
    if message.scope {
        text = format!("{}({})", text.trim_end(), if development { "deps-dev" } else { "deps" });
    }
    if text.ends_with(char::is_whitespace) {
        text
    } else if text.ends_with(|c: char| c.is_alphanumeric() || c == ')' || c == ']') {
        format!("{text}: ")
    } else {
        format!("{text} ")
    }
}

fn where_(directory: &str) -> String {
    if directory == "/" { String::new() } else { format!(" in {directory}") }
}

/// The pull request's title, which is also its commit's first line.
pub fn title(entry: &Entry, plan: &PullPlan) -> String {
    let development = plan.updates.iter().all(|update| update.kind == DependencyType::Development);
    let prefix = prefix(entry.commit_message.as_ref(), development);
    let directories = plan.directories();
    let first = &plan.updates[0];
    let count = plan.updates.len();
    let updates = if count == 1 { "1 update".to_owned() } else { format!("{count} updates") };
    let body = match (&plan.group, plan.by_name) {
        (None, _) => format!("Bump {} from {} to {}{}", first.name, first.from, first.to, where_(&first.directory)),
        (Some(_), true) if directories.len() > 1 => {
            format!("Bump {} to {} across {} directories", first.name, first.to, directories.len())
        }
        (Some(_), true) => format!("Bump {} from {} to {}{}", first.name, first.from, first.to, where_(&first.directory)),
        (Some(group), false) if directories.len() > 1 => {
            format!("Bump the {group} group across {} directories with {updates}", directories.len())
        }
        (Some(group), false) => format!("Bump the {group} group{} with {updates}", where_(&directories[0])),
    };
    let text = if prefix.is_empty() { body } else { format!("{prefix}{}{}", body[..1].to_lowercase(), &body[1..]) };
    text.chars().take(200).collect()
}

fn linked(update: &Planned) -> String {
    match update.source.as_deref().or(update.page.as_deref()) {
        Some(url) => format!("[{}]({url})", update.name),
        None => format!("`{}`", update.name),
    }
}

/// Where to read about a release: the registry's changelog, the source's
/// releases page on a forge that has one, and the package's page.
fn links(update: &Planned) -> Vec<String> {
    let mut links = Vec::new();
    if let Some(changelog) = &update.changelog {
        links.push(format!("[Changelog]({changelog})"));
    }
    if let Some(source) = update.source.as_deref() {
        if source.starts_with("https://github.com/") || source.starts_with("https://g1t.sh/") {
            links.push(format!("[Release notes]({source}/releases)"));
        } else if source.starts_with("https://gitlab.com/") {
            links.push(format!("[Release notes]({source}/-/releases)"));
        }
        links.push(format!("[Source]({source})"));
    }
    if let Some(page) = &update.page {
        links.push(format!("[Package]({page})"));
    }
    links
}

/// The commands a version or security update pull request takes.
pub const COMMANDS: &str = "<details>\n<summary>Commands</summary>\n\n\
Comment on this pull request to ask g1t for any of these:\n\n\
- `@g1t rebase` brings it up to date with its base branch, unless someone else has pushed to it\n\
- `@g1t recreate` makes it again from scratch, dropping anything pushed to it\n\
- `@g1t merge` merges it once its required checks pass\n\
- `@g1t squash and merge` does the same\n\
- `@g1t cancel merge` cancels an earlier `@g1t merge`\n\
- `@g1t close` closes it, and stops g1t opening it again for these versions\n\
- `@g1t reopen` opens it again\n\
- `@g1t ignore this dependency` closes it and stops updating this dependency\n\
- `@g1t ignore this major version` closes it and skips this major version (also `minor` and `patch`)\n\
- `@g1t ignore <dependency>` and `@g1t unignore <dependency>`, on a grouped pull request, skip one dependency or stop skipping it\n\
- `@g1t show <dependency> ignore conditions` lists what is skipped for a dependency\n\
</details>";

/// The pull request's body. `file` is the dependency update file it came from.
pub fn body(entry: &Entry, plan: &PullPlan, file: &str) -> String {
    let directories = plan.directories();
    let mut body = String::new();
    if plan.updates.len() == 1 {
        let update = &plan.updates[0];
        body.push_str(&format!("Bumps {} from {} to {}{}.\n", linked(update), update.from, update.to, where_(&update.directory)));
        let links = links(update);
        if !links.is_empty() {
            body.push_str(&format!("\n{}\n", links.join(" · ")));
        }
    } else {
        let what = match &plan.group {
            Some(group) if !plan.by_name => format!("the {group} group with {} updates", plan.updates.len()),
            _ => format!("{} in {} directories", plan.updates[0].name, directories.len()),
        };
        let place = if directories.len() == 1 {
            format!("the {} directory", directories[0])
        } else {
            format!("the {} directories", directories.join(", "))
        };
        body.push_str(&format!("Bumps {what} in {place}:\n\n"));
        let several = directories.len() > 1;
        body.push_str(if several { "| Package | Directory | From | To |\n| --- | --- | --- | --- |\n" } else { "| Package | From | To |\n| --- | --- | --- |\n" });
        for update in &plan.updates {
            if several {
                body.push_str(&format!("| {} | `{}` | `{}` | `{}` |\n", linked(update), update.directory, update.from, update.to));
            } else {
                body.push_str(&format!("| {} | `{}` | `{}` |\n", linked(update), update.from, update.to));
            }
        }
        for update in &plan.updates {
            let links = links(update);
            if !links.is_empty() {
                body.push_str(&format!("\n**{}**: {}", update.name, links.join(" · ")));
            }
        }
        body.push('\n');
    }
    body.push_str(&format!(
        "\nThis pull request lands through this branch's required checks like any other. If an update breaks them, g1t closes it and puts g1t on an issue to make the code changes it needs.\n\n{COMMANDS}\n\n---\n_Opened by g1t's version updates, as `{file}` asks{}._",
        entry.name.as_deref().map(|name| format!(" for {name}")).unwrap_or_default()
    ));
    body
}

/// The commit message: the title, what changed, and the
/// `updated-dependencies` record tools read from it.
pub fn commit_message(entry: &Entry, plan: &PullPlan) -> String {
    let mut message = format!("{}\n\n", title(entry, plan));
    for update in &plan.updates {
        message.push_str(&format!("Bumps {} from {} to {}{}.\n", update.name, update.from, update.to, where_(&update.directory)));
    }
    message.push_str("\n---\nupdated-dependencies:\n");
    for update in &plan.updates {
        message.push_str(&format!(
            "- dependency-name: {}\n  dependency-version: {}\n  dependency-type: {}\n  update-type: version-update:semver-{}\n",
            update.name,
            update.to,
            update.kind.label(),
            update.level
        ));
        if let Some(group) = &plan.group {
            message.push_str(&format!("  dependency-group: {group}\n"));
        }
    }
    message.push_str("...\n");
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::read;

    fn entry(extra: &str) -> Entry {
        let source = format!("version: 2\nupdates:\n  - package-ecosystem: npm\n    directories: [\"/\", \"/web\"]\n    schedule: {{interval: daily}}\n{extra}");
        let found = read(&source);
        assert!(found.problems.is_empty(), "{:?}", found.problems);
        found.config.updates.into_iter().next().unwrap()
    }

    fn update(name: &str, directory: &str, kind: DependencyType) -> Planned {
        Planned {
            name: name.into(),
            directory: directory.into(),
            kind,
            from: "4.17.20".into(),
            to: "4.17.21".into(),
            level: "patch",
            source: Some("https://github.com/lodash/lodash".into()),
            changelog: None,
            page: Some(format!("https://www.npmjs.com/package/{name}")),
        }
    }

    fn solo(name: &str, directory: &str) -> PullPlan {
        PullPlan { group: None, by_name: false, updates: vec![update(name, directory, DependencyType::Production)] }
    }

    fn group(updates: Vec<Planned>) -> PullPlan {
        PullPlan { group: Some("lint".into()), by_name: false, updates }
    }

    #[test]
    fn titles() {
        let plain = entry("");
        assert_eq!(title(&plain, &solo("lodash", "/")), "Bump lodash from 4.17.20 to 4.17.21");
        assert_eq!(title(&plain, &solo("lodash", "/web")), "Bump lodash from 4.17.20 to 4.17.21 in /web");
        let one = group(vec![update("eslint", "/", DependencyType::Development), update("prettier", "/", DependencyType::Development)]);
        assert_eq!(title(&plain, &one), "Bump the lint group with 2 updates");
        let across = group(vec![update("eslint", "/", DependencyType::Development), update("eslint", "/web", DependencyType::Development)]);
        assert_eq!(title(&plain, &across), "Bump the lint group across 2 directories with 2 updates");
        let in_web = group(vec![update("eslint", "/web", DependencyType::Development)]);
        assert_eq!(title(&plain, &in_web), "Bump the lint group in /web with 1 update");
        let by_name = PullPlan { by_name: true, ..across.clone() };
        assert_eq!(title(&plain, &by_name), "Bump eslint to 4.17.21 across 2 directories");
    }

    #[test]
    fn commit_message_prefixes() {
        let message = |prefix: Option<&str>, development: Option<&str>, scope: bool, dev: bool| {
            prefix_text(prefix, development, scope, dev)
        };
        fn prefix_text(prefix: Option<&str>, development: Option<&str>, scope: bool, dev: bool) -> String {
            super::prefix(
                Some(&CommitMessage { prefix: prefix.map(str::to_owned), prefix_development: development.map(str::to_owned), scope }),
                dev,
            )
        }
        assert_eq!(message(Some("build"), None, false, false), "build: ");
        assert_eq!(message(Some("build"), None, true, false), "build(deps): ");
        assert_eq!(message(Some("build"), Some("chore"), true, true), "chore(deps-dev): ");
        assert_eq!(message(Some("[deps]"), None, false, false), "[deps]: ");
        assert_eq!(message(Some("deps "), None, false, false), "deps ");
        assert_eq!(message(Some("⬆️"), None, false, false), "⬆️ ");
        assert_eq!(message(None, None, true, false), "chore(deps): ");
        assert_eq!(super::prefix(None, false), "");
        let prefixed = entry("    commit-message:\n      prefix: build\n      include: scope\n");
        assert_eq!(title(&prefixed, &solo("lodash", "/")), "build(deps): bump lodash from 4.17.20 to 4.17.21");
    }

    #[test]
    fn branches() {
        let plain = entry("");
        assert_eq!(branch(&plain, &solo("lodash", "/")), "g1t/npm_and_yarn/lodash-4.17.21");
        assert_eq!(branch(&plain, &solo("@types/node", "/web")), "g1t/npm_and_yarn/web/types/node-4.17.21");
        let grouped = group(vec![update("eslint", "/", DependencyType::Development)]);
        let name = branch(&plain, &grouped);
        assert!(name.starts_with("g1t/npm_and_yarn/lint-") && name.len() == "g1t/npm_and_yarn/lint-".len() + 10, "{name}");
        let dashed = entry("    pull-request-branch-name:\n      separator: \"-\"\n");
        assert_eq!(branch(&dashed, &solo("lodash", "/web")), "g1t-npm_and_yarn-web-lodash-4.17.21");
        let custom = entry("    pull-request-branch-name:\n      prefix: deps\n      word-separator: \"-\"\n      branch-name-case: uppercase\n");
        assert_eq!(branch(&custom, &solo("lodash", "/")), "deps/NPM-AND-YARN/LODASH-4.17.21");
        let templated = entry("    pull-request-branch-name:\n      template: \"{prefix}/{dependency}/{version}\"\n");
        assert_eq!(branch(&templated, &solo("lodash", "/")), "g1t/lodash/4.17.21");
        let short = entry("    pull-request-branch-name:\n      max-length: 20\n");
        let cut = branch(&short, &solo("a-very-long-dependency-name", "/"));
        assert_eq!(cut.chars().count(), 20, "{cut}");
        assert!(crate::config::valid_ref_part(&cut));
    }

    #[test]
    fn bodies_and_commits() {
        let plain = entry("    name: Web\n");
        let text = body(&plain, &solo("lodash", "/"), ".github/dependabot.yml");
        assert!(text.starts_with("Bumps [lodash](https://github.com/lodash/lodash) from 4.17.20 to 4.17.21.\n"), "{text}");
        assert!(text.contains("[Release notes](https://github.com/lodash/lodash/releases)"));
        assert!(text.contains("[Package](https://www.npmjs.com/package/lodash)"));
        assert!(text.contains("`@g1t rebase`") && text.contains("`@g1t ignore this major version`"));
        assert!(text.ends_with("_Opened by g1t's version updates, as `.github/dependabot.yml` asks for Web._"));
        let grouped = group(vec![update("eslint", "/", DependencyType::Development), update("eslint", "/web", DependencyType::Development)]);
        let text = body(&plain, &grouped, ".g1t/dependabot.yml");
        assert!(text.starts_with("Bumps the lint group with 2 updates in the /, /web directories:"), "{text}");
        assert!(text.contains("| Package | Directory | From | To |"));
        let commit = commit_message(&plain, &grouped);
        assert!(commit.starts_with("Bump the lint group across 2 directories with 2 updates\n\n"));
        assert!(commit.contains("updated-dependencies:\n- dependency-name: eslint\n  dependency-version: 4.17.21\n  dependency-type: direct:development\n  update-type: version-update:semver-patch\n  dependency-group: lint\n"));
    }

    #[test]
    fn package_managers() {
        assert_eq!(package_manager("gomod"), "go_modules");
        assert_eq!(package_manager("github-actions"), "github_actions");
    }
}
