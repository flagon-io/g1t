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
    let message = Message {
        to,
        from: FROM,
        subject,
        text: format!("{intro}\n\n{action}: {link}\n\n{footer}\n"),
        html: format!(
            "<div style=\"font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#16150f\">\
             <p style=\"margin:0 0 20px\"><img src=\"{SITE}/brand/g1t-logo.png\" width=\"69\" height=\"28\" alt=\"g1t\" style=\"display:block;border:0\"></p>\
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
