//! Transactional email through Cloudflare Email Sending.

use g1t_kit::js;
use serde::Serialize;
use worker::{Env, Result};

const FROM: &str = "g1t <noreply@g1t.sh>";
const SITE: &str = "https://g1t.sh";

#[derive(Serialize)]
struct Message<'a> {
    to: &'a str,
    from: &'a str,
    subject: &'a str,
    text: String,
    html: String,
}

/// A short message with one link to follow.
pub async fn send_link(
    env: &Env,
    to: &str,
    subject: &str,
    intro: &str,
    action: &str,
    link: &str,
    footer: &str,
) -> Result<()> {
    let text = format!("{intro}\n\n{action}: {link}\n\n{footer}\n");
    // Names people chose can reach these lines.
    let (intro, action, link, footer) = (escape(intro), escape(action), escape(link), escape(footer));
    let message = Message {
        to,
        from: FROM,
        subject,
        text,
        html: format!(
            "<div style=\"font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#16150f\">\
             <p style=\"margin:0 0 20px\"><img src=\"{SITE}/brand/g1t-logo.png\" width=\"60\" height=\"28\" alt=\"g1t\" style=\"display:block;border:0\"></p>\
             <p style=\"font-size:15px;line-height:1.6\">{intro}</p>\
             <p style=\"margin:24px 0\"><a href=\"{link}\" style=\"background:#16150f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:15px\">{action}</a></p>\
             <p style=\"font-size:13px;line-height:1.6;color:#6e6a5e\">{footer}</p>\
             </div>"
        ),
    };
    let binding = js::binding(env, "EMAIL")?;
    js::call(&binding, "send", &[js::to_js(&message)?]).await?;
    Ok(())
}

/// Text made safe to put in HTML, in an element or a quoted attribute.
fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            c => escaped.push(c),
        }
    }
    escaped
}

pub async fn send_verification(env: &Env, to: &str, username: &str, token: &str) -> Result<()> {
    send_link(
        env,
        to,
        "Confirm your email for g1t",
        &format!("Welcome to g1t, {username}. Confirm this address to finish creating your account."),
        "Confirm email",
        &format!("{SITE}/verify?token={token}"),
        "This link works for 24 hours. If you did not create a g1t account, you can ignore this message.",
    )
    .await
}

pub async fn send_password_reset(env: &Env, to: &str, username: &str, token: &str) -> Result<()> {
    send_link(
        env,
        to,
        "Reset your g1t password",
        &format!("Someone asked to reset the password for the g1t account {username}."),
        "Choose a new password",
        &format!("{SITE}/reset?token={token}"),
        "This link works for 1 hour. If this was not you, ignore this message and your password stays the same.",
    )
    .await
}

/// Confirms an address added to an existing account.
pub async fn send_added_address(env: &Env, to: &str, username: &str, token: &str) -> Result<()> {
    send_link(
        env,
        to,
        "Confirm your email for g1t",
        &format!("Confirm this address to add it to the g1t account {username}."),
        "Confirm email",
        &format!("{SITE}/verify?token={token}"),
        "This link works for 24 hours. If you did not add this address to a g1t account, you can ignore this message.",
    )
    .await
}

/// What a security notice says: one sentence about what changed.
pub fn security_wording(username: &str, change: &str) -> (String, String) {
    (
        format!("Security notice for your g1t account {username}"),
        format!("{change}. This is about your g1t account {username}."),
    )
}

/// Tells an account's addresses that something about its security changed.
pub async fn send_security_notice(env: &Env, to: &str, username: &str, change: &str) -> Result<()> {
    let (subject, intro) = security_wording(username, change);
    send_link(
        env,
        to,
        &subject,
        &intro,
        "Review your email settings",
        &format!("{SITE}/settings#emails"),
        "If this was you, there is nothing to do. If it was not, reset your password at g1t.sh/forgot straight away and remove any address you do not recognise.",
    )
    .await
}

/// An invite: to make an account, or for an existing one to join a
/// workspace. `from` is who sent it (a username, or a name and username);
/// None when g1t staff did.
pub async fn send_invite(
    env: &Env,
    to: &str,
    from: Option<&str>,
    workspace: Option<&str>,
    joins_existing_account: bool,
    code: &str,
    days: u64,
) -> Result<()> {
    let (subject, intro) = invite_wording(from, workspace, joins_existing_account);
    let action = match workspace {
        Some(workspace) if joins_existing_account => format!("Join {workspace}"),
        _ => "Accept invite".to_owned(),
    };
    send_link(
        env,
        to,
        &subject,
        &intro,
        &action,
        &format!("{SITE}/invite/{code}"),
        &format!(
            "This invite works for {days} days, only for this address. If you were not expecting it, you can ignore this message."
        ),
    )
    .await
}

/// An invitation to collaborate on one repository. `code` is set when the
/// address has no account yet: the link then makes one and accepts; without
/// it, the link opens the invitation to accept or decline.
pub async fn send_repo_invite(
    env: &Env,
    to: &str,
    from: &str,
    repo: &str,
    role: &str,
    code: Option<&str>,
    days: u64,
) -> Result<()> {
    let (subject, intro) = repo_invite_wording(from, repo, role, code.is_some());
    let link = match code {
        Some(code) => format!("{SITE}/invite/{code}"),
        None => format!("{SITE}/{repo}/invitations"),
    };
    send_link(
        env,
        to,
        &subject,
        &intro,
        "View invitation",
        &link,
        &format!("This invitation works for {days} days. If you were not expecting it, you can ignore this message."),
    )
    .await
}

/// The subject and first line of a repository invitation.
pub fn repo_invite_wording(from: &str, repo: &str, role: &str, new_account: bool) -> (String, String) {
    let subject = format!("{from} invited you to {repo} on g1t");
    let intro = if new_account {
        format!(
            "{from} invited you to collaborate on {repo} on g1t, with the {role} role. Accepting makes your g1t account and gives you access to {repo}."
        )
    } else {
        format!("{from} invited you to collaborate on {repo} on g1t, with the {role} role.")
    };
    (subject, intro)
}

/// The subject and first line of an invite email.
pub fn invite_wording(from: Option<&str>, workspace: Option<&str>, joins_existing_account: bool) -> (String, String) {
    let who = from.unwrap_or("The g1t team");
    match (workspace, joins_existing_account) {
        (Some(workspace), true) => (
            format!("{who} invited you to {workspace} on g1t"),
            format!("{who} invited you to join the {workspace} workspace on g1t."),
        ),
        (Some(workspace), false) => (
            format!("{who} invited you to {workspace} on g1t"),
            format!(
                "{who} invited you to join the {workspace} workspace on g1t, where people and agents ship software together. Accepting makes your account and joins you to {workspace}."
            ),
        ),
        (None, _) => (
            match from {
                Some(from) => format!("{from} invited you to g1t"),
                None => "Your invite to g1t".to_owned(),
            },
            format!("{who} invited you to g1t, where people and agents ship software together. g1t is invite-only for now; this invite lets you make your account."),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{escape, invite_wording};

    #[test]
    fn html_is_escaped() {
        assert_eq!(
            escape("<a href=\"x\">Tom & Jerry's</a>"),
            "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;"
        );
        assert_eq!(escape("https://g1t.sh/verify?token=ab12"), "https://g1t.sh/verify?token=ab12");
    }

    #[test]
    fn invites_say_who_sent_them_and_what_they_are_for() {
        let (subject, intro) = invite_wording(Some("ada"), None, false);
        assert_eq!(subject, "ada invited you to g1t");
        assert!(intro.starts_with("ada invited you to g1t"));
        let (subject, _) = invite_wording(None, None, false);
        assert_eq!(subject, "Your invite to g1t");
        let (subject, intro) = invite_wording(Some("ada"), Some("acme"), true);
        assert_eq!(subject, "ada invited you to acme on g1t");
        assert_eq!(intro, "ada invited you to join the acme workspace on g1t.");
        let (_, intro) = invite_wording(Some("ada"), Some("acme"), false);
        assert!(intro.contains("makes your account and joins you to acme"));
    }
}
