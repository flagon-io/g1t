//! `g1t browse`, and opening pages for `--web`.

use crate::cli::BrowseArgs;
use crate::context::Ctx;
use crate::error::Result;
use crate::repo::Repo;

/// Opens `url` in the browser at a terminal; prints it otherwise.
pub fn open(ctx: &Ctx, url: &str) -> Result<()> {
    if ctx.out.tty && crate::prompt::open_browser(url) {
        eprintln!("Opening {url} in your browser.");
    } else {
        println!("{url}");
    }
    Ok(())
}

/// The page `args` asks for in `repo`.
pub fn address(site: &str, repo: &Repo, args: &BrowseArgs, branch: Option<&str>) -> String {
    let base = format!("{site}/{}/{}", repo.owner, repo.name);
    if args.settings {
        return format!("{base}/settings");
    }
    if args.issues {
        return format!("{base}/issues");
    }
    if args.pulls {
        return format!("{base}/pulls");
    }
    if args.actions {
        return format!("{base}/actions");
    }
    let Some(target) = args.target.as_deref().filter(|t| !t.is_empty()) else {
        return match &args.branch {
            Some(b) => format!("{base}/tree/{b}"),
            None => base,
        };
    };
    let target = target.trim_start_matches('#');
    if target.chars().all(|c| c.is_ascii_digit()) {
        // Issues and pull requests share numbers; the issue page sends a
        // pull request's number on to it.
        return format!("{base}/issues/{target}");
    }
    if target.len() >= 7
        && target.len() <= 40
        && target.chars().all(|c| c.is_ascii_hexdigit())
        && !target.contains('.')
    {
        return format!("{base}/commit/{target}");
    }
    let (path, line) = match target.rsplit_once(':') {
        Some((p, l)) if !l.is_empty() && l.chars().all(|c| c.is_ascii_digit()) => (p, Some(l)),
        _ => (target, None),
    };
    let branch = args.branch.as_deref().or(branch).unwrap_or("HEAD");
    let path = path.trim_start_matches("./").trim_start_matches('/');
    match line {
        Some(l) => format!("{base}/blob/{branch}/{path}#L{l}"),
        None => format!("{base}/blob/{branch}/{path}"),
    }
}

pub fn run(ctx: &Ctx, args: BrowseArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let branch = if args
        .target
        .as_deref()
        .is_some_and(|t| t.contains('/') || t.contains('.'))
        && args.branch.is_none()
    {
        // A file: on the branch checked out, when it is this repository.
        crate::git::current_branch()
    } else {
        None
    };
    let url = address(&client.host.site, &repo, &args, branch.as_deref());
    if args.no_browser {
        println!("{url}");
        return Ok(());
    }
    open(ctx, &url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(target: Option<&str>) -> BrowseArgs {
        BrowseArgs {
            target: target.map(str::to_owned),
            branch: None,
            settings: false,
            issues: false,
            pulls: false,
            actions: false,
            no_browser: true,
        }
    }

    #[test]
    fn addresses_follow_the_site() {
        let repo = Repo {
            host: "g1t.sh".into(),
            owner: "acme".into(),
            name: "web".into(),
        };
        let site = "https://g1t.sh";
        assert_eq!(
            address(site, &repo, &args(None), None),
            "https://g1t.sh/acme/web"
        );
        assert_eq!(
            address(site, &repo, &args(Some("12")), None),
            "https://g1t.sh/acme/web/issues/12"
        );
        assert_eq!(
            address(site, &repo, &args(Some("src/main.rs:41")), Some("dev")),
            "https://g1t.sh/acme/web/blob/dev/src/main.rs#L41"
        );
        assert_eq!(
            address(site, &repo, &args(Some("9f2c4e1")), None),
            "https://g1t.sh/acme/web/commit/9f2c4e1"
        );
        let mut settings = args(None);
        settings.settings = true;
        assert_eq!(
            address(site, &repo, &settings, None),
            "https://g1t.sh/acme/web/settings"
        );
    }
}
