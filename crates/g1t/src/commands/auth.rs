//! `g1t auth`: signing in and out, and git's credentials.

use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};
use std::time::{Duration, Instant};

use crate::auth::{self, Host, Source};
use crate::cli::{AccountArgs, AuthCommand, AuthStatusArgs, GitCredentialArgs, LoginArgs, SetupGitArgs};
use crate::client::Client;
use crate::config::Config;
use crate::context::{Ctx, not_signed_in};
use crate::error::{Error, Kind, Result};
use crate::prompt;

pub fn run(mut ctx: Ctx, command: AuthCommand) -> Result<()> {
    match command {
        AuthCommand::Login(args) => login(&mut ctx, args),
        AuthCommand::Logout(args) => logout(&mut ctx, args),
        AuthCommand::Status(args) => status(&ctx, args),
        AuthCommand::Token(args) => token(&ctx, args),
        AuthCommand::Switch(args) => switch(&mut ctx, args),
        AuthCommand::SetupGit(args) => setup_git(&ctx, args),
        AuthCommand::GitCredential(args) => git_credential(&ctx, args),
    }
}

/// The host to sign in to, asking it where its API is when it is new.
fn login_host(ctx: &Ctx) -> Result<Host> {
    let host = ctx.host()?;
    if ctx.config.host(&host.name).is_some() || std::env::var_os("G1T_API_URL").is_some() {
        return Ok(host);
    }
    auth::discover(&host.name, &host.site)
}

fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|n| !n.trim().is_empty())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|n| n.trim().to_owned()))
        .unwrap_or_else(|| "this computer".to_owned())
}

fn login(ctx: &mut Ctx, args: LoginArgs) -> Result<()> {
    let host = login_host(ctx)?;
    let (token, username) = if args.with_token {
        let mut token = String::new();
        std::io::stdin().read_to_string(&mut token)?;
        let token = token.trim().to_owned();
        if token.is_empty() {
            return Err(Error::usage("--with-token read nothing from stdin."));
        }
        let user = Client::new(host.clone(), Some(token.clone())).op("whoami").send()?;
        let username = user["username"].as_str().unwrap_or_default().to_owned();
        (token, username)
    } else {
        device_flow(&host, args.no_browser)?
    };
    if username.is_empty() {
        return Err(Error::failed("The API did not say whose token it is."));
    }
    let source = auth::store(&mut ctx.config, &host, &username, &token, args.insecure_storage);
    ctx.config.save()?;
    let kept = match source {
        Source::Keyring => "in the system keychain".to_owned(),
        _ => format!("in {}", crate::config::path()?.display()),
    };
    eprintln!("{} Signed in to {} as {username}; the token is {kept}.", ctx.out.green("✓"), host.name);
    if std::env::var_os("G1T_TOKEN").is_some_and(|t| !t.is_empty()) {
        eprintln!("! G1T_TOKEN is set, and commands use it before this account. Unset it to use this one.");
    }
    if args.git {
        configure_git(&host, false)?;
        eprintln!("{} git now uses this account for {}.", ctx.out.green("✓"), host.site);
    }
    Ok(())
}

/// Signs in by approving a code in the browser: `/device/code`, then
/// `/device/token` until it is approved.
fn device_flow(host: &Host, no_browser: bool) -> Result<(String, String)> {
    let client = Client::new(host.clone(), None);
    let started = client.op("device_code").field("client_name", format!("g1t CLI on {}", machine_name())).send()?;
    let device_code = started["device_code"].as_str().ok_or("The host did not start a sign-in.")?.to_owned();
    let user_code = started["user_code"].as_str().unwrap_or_default();
    let link = started["verification_uri_complete"].as_str().or(started["verification_uri"].as_str()).unwrap_or_default().to_owned();
    let mut interval = started["interval"].as_u64().unwrap_or(5).max(1);
    let expires = Duration::from_secs(started["expires_in"].as_u64().unwrap_or(900));
    eprintln!("! Your one-time code: {user_code}");
    let opened = !no_browser && prompt::interactive() && prompt::open_browser(&link);
    if opened {
        eprintln!("  Opened {link} in your browser. Approve the code there.");
    } else {
        eprintln!("  Open {link} in a browser, signed in to {}, and approve the code.", host.name);
    }
    eprint!("  Waiting for approval...");
    let _ = std::io::stderr().flush();
    let start = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(interval));
        if start.elapsed() > expires {
            eprintln!();
            return Err(Error::auth("The code expired before it was approved. Run `g1t auth login` again."));
        }
        let reply = client.raw(
            "POST",
            &client.op("device_token").path(),
            &[],
            &[],
            Some(serde_json::to_vec(&json!({ "device_code": device_code })).expect("json")),
        )?;
        let body = reply.json().unwrap_or(Value::Null);
        if reply.status == 429 || body["error"].as_str() == Some("slow_down") {
            interval += 5;
            continue;
        }
        if !(200..300).contains(&reply.status) {
            eprintln!();
            return Err(client.api_error(&reply));
        }
        match body["status"].as_str() {
            Some("approved") => {
                eprintln!(" approved.");
                let token = body["token"].as_str().ok_or("The approval carried no token.")?.to_owned();
                let user = body["username"].as_str().unwrap_or_default().to_owned();
                return Ok((token, user));
            }
            Some("denied") => {
                eprintln!();
                return Err(Error::auth("The sign-in was denied."));
            }
            Some("expired") => {
                eprintln!();
                return Err(Error::auth("The code expired before it was approved. Run `g1t auth login` again."));
            }
            _ => continue,
        }
    }
}

/// The host from --hostname, or the only one signed in, or the default.
fn account_host(ctx: &Ctx) -> Result<Host> {
    if ctx.global.hostname.is_none() && std::env::var_os("G1T_HOST").is_none() && ctx.config.hosts.len() == 1 {
        let name = ctx.config.hosts.keys().next().cloned().unwrap_or_default();
        return auth::resolve(&ctx.config, Some(&name));
    }
    ctx.host()
}

fn logout(ctx: &mut Ctx, args: AccountArgs) -> Result<()> {
    let host = account_host(ctx)?;
    let user = args
        .user
        .or_else(|| ctx.config.host(&host.name).and_then(|h| h.user.clone()))
        .ok_or_else(|| Error::failed(format!("Not signed in to {}.", host.name)))?;
    if !ctx.config.host(&host.name).is_some_and(|h| h.users.contains_key(&user)) {
        return Err(Error::failed(format!("{user} is not signed in on {}.", host.name)));
    }
    auth::forget(&mut ctx.config, &host.name, &user);
    ctx.config.save()?;
    eprintln!("{} Signed out of {} as {user}.", ctx.out.green("✓"), host.name);
    if let Some(next) = ctx.config.host(&host.name).and_then(|h| h.user.clone()) {
        eprintln!("  {next} is now the active account there.");
    }
    Ok(())
}

fn status(ctx: &Ctx, _args: AuthStatusArgs) -> Result<()> {
    let show = _args.show_token;
    let mut hosts: Vec<String> = ctx.config.hosts.keys().cloned().collect();
    if let Some(h) = &ctx.global.hostname {
        hosts = vec![auth::parse_hostname(h)?.0];
    }
    let env_token = std::env::var("G1T_TOKEN").ok().filter(|t| !t.trim().is_empty());
    let mut report = Vec::new();
    if let Some(token) = &env_token {
        let host = ctx.host()?;
        let checked = check(&host, token);
        report.push(json!({
            "host": host.name, "user": checked.as_ref().ok().and_then(|u| u["username"].as_str()),
            "active": true, "source": "G1T_TOKEN", "valid": checked.is_ok(),
            "scopes": checked.as_ref().ok().map(|u| u["token"]["scopes"].clone()),
            "error": checked.as_ref().err().map(|e| e.message.clone()),
            "token": show.then(|| token.clone()),
        }));
    }
    for name in &hosts {
        let host = auth::resolve(&ctx.config, Some(name))?;
        for (user, token, active) in auth::accounts(&ctx.config, name) {
            let checked = match &token {
                Some(t) => check(&host, &t.value),
                None => Err(Error::failed("its token is not in the keychain any more")),
            };
            report.push(json!({
                "host": name, "user": user, "active": active && env_token.is_none(),
                "source": token.as_ref().map(|t| t.source.label()), "valid": checked.is_ok(),
                "scopes": checked.as_ref().ok().map(|u| u["token"]["scopes"].clone()),
                "error": checked.as_ref().err().map(|e| e.message.clone()),
                "token": if show { token.as_ref().map(|t| t.value.clone()) } else { None },
            }));
        }
    }
    if ctx.out.structured() {
        ctx.out.emit(&Value::Array(report.clone()))?;
    } else if report.is_empty() {
        eprintln!("Not signed in to any host. Run `g1t auth login`.");
    } else {
        let out = &ctx.out;
        let mut last_host = String::new();
        for r in &report {
            let host = r["host"].as_str().unwrap_or_default();
            if host != last_host {
                println!("{}", out.bold(host));
                last_host = host.to_owned();
            }
            let user = r["user"].as_str().unwrap_or("?");
            let source = r["source"].as_str().unwrap_or("nowhere");
            let active = if r["active"] == true { " (active)" } else { "" };
            if r["valid"] == true {
                println!("  {} Signed in as {user}{active}, token from {source}", out.green("✓"));
                let scopes = match r["scopes"].as_array() {
                    Some(list) if !list.is_empty() => list.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
                    _ => "full access".to_owned(),
                };
                println!("    Scopes: {scopes}");
            } else {
                let why = r["error"].as_str().unwrap_or("");
                println!("  {} {user}{active}: {why}", out.red("X"));
            }
            if let Some(t) = r["token"].as_str() {
                println!("    Token: {t}");
            }
        }
    }
    if report.is_empty() {
        return Err(Error::exit(Kind::Auth));
    }
    if report.iter().any(|r| r["active"] == true && r["valid"] != true) {
        return Err(Error::exit(Kind::Auth));
    }
    Ok(())
}

fn check(host: &Host, token: &str) -> Result<Value> {
    Client::new(host.clone(), Some(token.to_owned())).op("whoami").send()
}

fn token(ctx: &Ctx, args: AccountArgs) -> Result<()> {
    let host = account_host(ctx)?;
    match auth::token(&ctx.config, &host.name, args.user.as_deref()) {
        Some(t) => {
            println!("{}", t.value);
            Ok(())
        }
        None => Err(not_signed_in(&host)),
    }
}

fn switch(ctx: &mut Ctx, args: AccountArgs) -> Result<()> {
    let host = account_host(ctx)?;
    let entry = ctx.config.hosts.get(&host.name).ok_or_else(|| not_signed_in(&host))?;
    let users: Vec<String> = entry.users.keys().cloned().collect();
    let current = entry.user.clone();
    let next = match args.user {
        Some(user) if users.contains(&user) => user,
        Some(user) => {
            return Err(Error::usage(format!("{user} is not signed in on {}.", host.name)));
        }
        None if users.len() < 2 => {
            return Err(Error::usage(format!("Only one account is signed in on {}.", host.name)));
        }
        None if users.len() == 2 => users.iter().find(|u| Some(*u) != current.as_ref()).cloned().unwrap_or_default(),
        None if prompt::interactive() => users[prompt::select("Which account?", &users)?].clone(),
        None => return Err(prompt::needed("The account", "--user")),
    };
    if let Some(entry) = ctx.config.hosts.get_mut(&host.name) {
        entry.user = Some(next.clone());
    }
    ctx.config.save()?;
    eprintln!("{} {next} is now the active account on {}.", ctx.out.green("✓"), host.name);
    Ok(())
}

/// The helper line git runs: this program, quoted for git's shell.
fn helper_command() -> Result<String> {
    let exe = std::env::current_exe()?;
    let exe = exe.to_string_lossy().replace('\\', "/");
    Ok(format!("!'{exe}' auth git-credential"))
}

fn configure_git(host: &Host, dry_run: bool) -> Result<()> {
    let key = format!("credential.{}.helper", host.site);
    let helper = helper_command()?;
    let steps: [Vec<&str>; 2] = [vec!["config", "--global", "--replace-all", &key, ""], vec!["config", "--global", "--add", &key, &helper]];
    for step in &steps {
        if dry_run {
            let quoted: Vec<String> = step
                .iter()
                .map(|a| if a.is_empty() || a.contains(' ') || a.contains('\'') { format!("\"{a}\"") } else { (*a).to_owned() })
                .collect();
            println!("git {}", quoted.join(" "));
        } else {
            crate::git::run(step)?;
        }
    }
    Ok(())
}

fn setup_git(ctx: &Ctx, args: SetupGitArgs) -> Result<()> {
    let hosts: Vec<Host> = if ctx.global.hostname.is_some() || ctx.config.hosts.is_empty() {
        vec![ctx.host()?]
    } else {
        ctx.config.hosts.keys().map(|name| auth::resolve(&ctx.config, Some(name))).collect::<Result<_>>()?
    };
    for host in &hosts {
        configure_git(host, args.dry_run)?;
        if !args.dry_run {
            eprintln!("{} git uses g1t's credentials for {}.", ctx.out.green("✓"), host.site);
        }
    }
    Ok(())
}

/// Reads git's `key=value` lines up to a blank one.
pub fn read_credential_request(input: impl BufRead) -> Vec<(String, String)> {
    let mut fields = Vec::new();
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once('=') {
            fields.push((k.to_owned(), v.to_owned()));
        }
    }
    fields
}

/// The answer to git's `get`, or None when this host is not one of ours.
pub fn answer_credential(config: &Config, fields: &[(String, String)], whoami: &dyn Fn(&Host, &str) -> Option<String>) -> Option<String> {
    let get = |k: &str| fields.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
    let protocol = get("protocol")?;
    let host_name = get("host")?.to_lowercase();
    if protocol != "https" && protocol != "http" {
        return None;
    }
    let known = config.host(&host_name).is_some() || host_name == crate::config::DEFAULT_HOST;
    if !known {
        return None;
    }
    let wanted = get("username").filter(|u| config.host(&host_name).is_some_and(|h| h.users.contains_key(*u)));
    let token = auth::token(config, &host_name, wanted)?;
    let username = match token.user.clone() {
        Some(u) => u,
        None => {
            let host = auth::resolve(config, Some(&host_name)).ok()?;
            whoami(&host, &token.value).unwrap_or_else(|| "g1t".to_owned())
        }
    };
    Some(format!("protocol={protocol}\nhost={host_name}\nusername={username}\npassword={}\n", token.value))
}

fn git_credential(ctx: &Ctx, args: GitCredentialArgs) -> Result<()> {
    if args.operation != "get" {
        // store and erase: the token lives with g1t, not with git.
        let _ = std::io::stdin().read_to_end(&mut Vec::new());
        return Ok(());
    }
    let fields = read_credential_request(std::io::stdin().lock());
    let whoami = |host: &Host, token: &str| {
        Client::new(host.clone(), Some(token.to_owned())).op("whoami").send().ok().and_then(|u| u["username"].as_str().map(str::to_owned))
    };
    if let Some(answer) = answer_credential(&ctx.config, &fields, &whoami) {
        print!("{answer}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(text: &str) -> Vec<(String, String)> {
        read_credential_request(std::io::Cursor::new(text.as_bytes().to_vec()))
    }

    #[test]
    fn git_asks_and_is_answered_for_our_hosts_only() {
        // SAFETY: tests that touch these variables set them the same way.
        unsafe {
            std::env::set_var("G1T_KEYRING", "off");
            std::env::remove_var("G1T_TOKEN");
        }
        let mut config = Config::default();
        auth::store(&mut config, &Host::hosted(), "ana", "g1t_secret", true);
        let nobody = |_: &Host, _: &str| None;
        let asked = fields("protocol=https\nhost=g1t.sh\npath=acme/web.git\n\n");
        assert_eq!(asked.len(), 3);
        assert_eq!(
            answer_credential(&config, &asked, &nobody).as_deref(),
            Some("protocol=https\nhost=g1t.sh\nusername=ana\npassword=g1t_secret\n")
        );
        let other = fields("protocol=https\nhost=example.com\n\n");
        assert_eq!(answer_credential(&config, &other, &nobody), None);
        let ssh = fields("protocol=ssh\nhost=g1t.sh\n\n");
        assert_eq!(answer_credential(&config, &ssh, &nobody), None);
    }
}
