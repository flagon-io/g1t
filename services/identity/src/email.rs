//! Transactional email through Cloudflare Email Sending.

use g1t_kit::js;
use serde::Serialize;
use worker::{Env, Result};

const FROM: &str = "g1t <noreply@g1t.sh>";
const SITE: &str = "https://g1t.sh";

/// Where links in mail point: SITE_URL, or g1t.sh when it is not set (a
/// self-hosted installation sets it from its PUBLIC_URL).
pub fn site(env: &Env) -> String {
    let value = env.var("SITE_URL").map(|value| value.to_string()).unwrap_or_default();
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() { SITE.to_owned() } else { value.to_owned() }
}

/// Who mail is from: MAIL_FROM, or g1t.sh's address when it is not set.
fn from(env: &Env) -> String {
    let value = env.var("MAIL_FROM").map(|value| value.to_string()).unwrap_or_default();
    if value.trim().is_empty() { FROM.to_owned() } else { value.trim().to_owned() }
}

/// A site's address without its scheme, as mail names it in a sentence.
fn bare(site: &str) -> &str {
    site.split_once("://").map_or(site, |(_, rest)| rest)
}

#[derive(Serialize)]
struct Message<'a> {
    to: &'a str,
    from: &'a str,
    subject: &'a str,
    text: String,
    html: String,
}

/// What one email says, before it is laid out as text and HTML.
#[derive(Debug, Default)]
pub struct Letter {
    pub paragraphs: Vec<String>,
    /// Quoted passages, each with who or what it is from: a note from the
    /// person who sent an invite, or what someone asking for access said.
    pub quotes: Vec<(String, String)>,
    /// A code to type, shown large before the button, with the line that
    /// leads from it to the button.
    pub code: Option<Code>,
    /// The button: what it says, and where it goes.
    pub action: Option<(String, String)>,
    pub footer: String,
}

/// A code in a letter, and what joins it to the button after it.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Code {
    pub code: String,
    /// Said between the code and the button, such as "or follow the link".
    pub then: String,
}

/// The plain text and HTML of a letter. Everything in it is escaped:
/// names, notes and requests people wrote can reach every line.
pub fn render(letter: &Letter, site: &str) -> (String, String) {
    let mut text = String::new();
    let mut html = format!(
        "<div style=\"font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#16150f\">\
         <p style=\"margin:0 0 20px\"><img src=\"{site}/brand/g1t-logo.png\" width=\"60\" height=\"28\" alt=\"g1t\" style=\"display:block;border:0\"></p>"
    );
    for paragraph in &letter.paragraphs {
        text.push_str(paragraph);
        text.push_str("\n\n");
        html.push_str(&format!("<p style=\"font-size:15px;line-height:1.6\">{}</p>", escape(paragraph)));
    }
    for (from, quote) in &letter.quotes {
        text.push_str(&format!("{from}:\n"));
        for line in quote.lines() {
            text.push_str(&format!("> {line}\n"));
        }
        text.push('\n');
        html.push_str(&format!(
            "<p style=\"margin:20px 0 6px;font-size:13px;color:#6e6a5e\">{}</p>\
             <blockquote style=\"margin:0;padding:2px 0 2px 14px;border-left:3px solid #b9a6f2;font-size:15px;line-height:1.6;white-space:pre-line\">{}</blockquote>",
            escape(from),
            escape(quote)
        ));
    }
    if let Some(code) = &letter.code {
        text.push_str(&format!("    {}\n\n{}\n\n", code.code, code.then));
        html.push_str(&format!(
            "<p style=\"margin:24px 0;padding:16px 0;text-align:center;background:#f3f1ea;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:600;letter-spacing:10px;color:#16150f\">{}</p>\
             <p style=\"font-size:15px;line-height:1.6\">{}</p>",
            escape(&code.code),
            escape(&code.then)
        ));
    }
    if let Some((label, link)) = &letter.action {
        text.push_str(&format!("{label}: {link}\n\n"));
        html.push_str(&format!(
            "<p style=\"margin:24px 0\"><a href=\"{}\" style=\"background:#16150f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:15px\">{}</a></p>",
            escape(link),
            escape(label)
        ));
    }
    text.push_str(&letter.footer);
    text.push('\n');
    html.push_str(&format!(
        "<p style=\"font-size:13px;line-height:1.6;color:#6e6a5e\">{}</p></div>",
        escape(&letter.footer)
    ));
    (text, html)
}

/// Sends a letter.
pub async fn send(env: &Env, to: &str, subject: &str, letter: &Letter) -> Result<()> {
    let (text, html) = render(letter, &site(env));
    let from = from(env);
    let message = Message {
        to,
        from: &from,
        subject,
        text,
        html,
    };
    let binding = js::binding(env, "EMAIL")?;
    js::call(&binding, "send", &[js::to_js(&message)?]).await?;
    Ok(())
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
    let letter = Letter {
        paragraphs: vec![intro.to_owned()],
        quotes: Vec::new(),
        code: None,
        action: Some((action.to_owned(), link.to_owned())),
        footer: footer.to_owned(),
    };
    send(env, to, subject, &letter).await
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

/// What a confirmation email is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confirming {
    /// The address a new account signed up with (or changed to before
    /// confirming any).
    NewAccount,
    /// An address added to an account in use.
    AddedAddress,
}

/// A confirmation email: the code to type, large, and the link that does
/// the same, either one enough. The code leads the subject, so a phone's
/// notification shows it.
pub fn confirmation_letter(confirming: Confirming, username: &str, code: &str, link: &str) -> (String, Letter) {
    let minutes = g1t_contracts::accounts::CONFIRM_TTL_SECONDS / 60;
    let (intro, ignore) = match confirming {
        Confirming::NewAccount => (
            format!("Welcome to g1t, {username}. To finish creating your account, enter this code on the confirmation page:"),
            "If you did not create a g1t account, you can ignore this message.",
        ),
        Confirming::AddedAddress => (
            format!("To add this address to the g1t account {username}, enter this code on the confirmation page:"),
            "If you did not add this address to a g1t account, you can ignore this message.",
        ),
    };
    let letter = Letter {
        paragraphs: vec![intro],
        quotes: Vec::new(),
        code: Some(Code {
            code: code.to_owned(),
            then: "Or skip the code and confirm with this link instead. Either one works; you need only one.".to_owned(),
        }),
        action: Some(("Confirm email".to_owned(), link.to_owned())),
        footer: format!(
            "The code and the link work for {minutes} minutes, and only once. Asking for a new email ends them both. {ignore}"
        ),
    };
    (format!("{code} is your g1t confirmation code"), letter)
}

/// Sends a confirmation email with `code` and the link for `token`.
pub async fn send_confirmation(env: &Env, to: &str, username: &str, confirming: Confirming, token: &str, code: &str) -> Result<()> {
    let link = format!("{}/verify?token={token}", site(env));
    let (subject, letter) = confirmation_letter(confirming, username, code, &link);
    send(env, to, &subject, &letter).await
}

pub async fn send_password_reset(env: &Env, to: &str, username: &str, token: &str) -> Result<()> {
    send_link(
        env,
        to,
        "Reset your g1t password",
        &format!("Someone asked to reset the password for the g1t account {username}."),
        "Choose a new password",
        &format!("{}/reset?token={token}", site(env)),
        "This link works for 1 hour. If this was not you, ignore this message and your password stays the same.",
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
        &format!("{}/settings/emails", site(env)),
        &format!(
            "If this was you, there is nothing to do. If it was not, reset your password at {}/forgot straight away and remove any address you do not recognise.",
            bare(&site(env))
        ),
    )
    .await
}

/// What the email telling an account it was deleted says: its subject and
/// first paragraph. `by_staff` when g1t's staff deleted it.
pub fn deleted_wording(username: &str, by_staff: bool, days: u64) -> (String, String) {
    let who = if by_staff { "g1t's staff deleted" } else { "You deleted" };
    (
        format!("Your g1t account {username} was deleted"),
        format!(
            "{who} your g1t account {username}. It has signed out everywhere, its access tokens and keys no longer work, and it has left every workspace. g1t keeps it for {days} days; after that it is removed for good."
        ),
    )
}

/// Tells an account's primary and backup addresses it was deleted, with how
/// to ask for it back.
pub async fn send_account_deleted(env: &Env, to: &str, username: &str, by_staff: bool, days: u64) -> Result<()> {
    let (subject, intro) = deleted_wording(username, by_staff, days);
    send_link(
        env,
        to,
        &subject,
        &intro,
        "Contact support",
        &format!("{}/support", site(env)),
        &format!(
            "If you did not mean to delete it, or did not delete it, write to support within {days} days and g1t can restore it."
        ),
    )
    .await
}

/// An invite email: to make an account, or for an existing one to join a
/// workspace.
pub struct InviteEmail<'a> {
    pub to: &'a str,
    /// Who sent it (a name, or a username); None when g1t staff did.
    pub from: Option<&'a str>,
    /// The workspace it joins, by name.
    pub workspace: Option<&'a str>,
    pub joins_existing_account: bool,
    pub code: &'a str,
    pub days: u64,
    /// A line from whoever sent it, such as staff approving a request.
    pub note: Option<&'a str>,
}

/// The subject and letter of an invite email.
pub fn invite_letter(invite: &InviteEmail, site: &str) -> (String, Letter) {
    let (subject, intro) = invite_wording(invite.from, invite.workspace, invite.joins_existing_account);
    let action = match invite.workspace {
        Some(workspace) if invite.joins_existing_account => format!("Join {workspace}"),
        _ => "Accept invite".to_owned(),
    };
    let quotes = match invite.note.map(str::trim).filter(|note| !note.is_empty()) {
        Some(note) => vec![(
            match invite.from {
                Some(from) => format!("A note from {from}"),
                None => "A note from the g1t team".to_owned(),
            },
            note.to_owned(),
        )],
        None => Vec::new(),
    };
    let letter = Letter {
        paragraphs: vec![intro],
        quotes,
        code: None,
        action: Some((action, format!("{site}/invite/{}", invite.code))),
        footer: format!(
            "This invite works for {} days, only for this address. If you were not expecting it, you can ignore this message.",
            invite.days
        ),
    };
    (subject, letter)
}

pub async fn send_invite(env: &Env, invite: &InviteEmail<'_>) -> Result<()> {
    let (subject, letter) = invite_letter(invite, &site(env));
    send(env, invite.to, &subject, &letter).await
}

/// Where staff decide on access requests.
pub const SUDO_WAITLIST: &str = "https://sudo.g1t.sh/invites?tab=waitlist";

/// The one confirmation someone gets after asking for access.
pub fn waitlist_confirmation(site: &str) -> (String, Letter) {
    (
        "You're on the list for g1t".to_owned(),
        Letter {
            paragraphs: vec![
                "Thanks for asking to try g1t. You're on the list, and we'll email you an invite at this address when there's a place for you.".to_owned(),
                "g1t is invite-only while we open it up a few people at a time, so we can't say exactly when that will be. Someone already on g1t can also invite you sooner.".to_owned(),
            ],
            quotes: Vec::new(),
            code: None,
            action: None,
            footer: format!("You're getting this because this address asked for access at {}/register. If that wasn't you, ignore this message; nothing more is sent unless you're invited.", bare(site)),
        },
    )
}

pub async fn send_waitlist_confirmation(env: &Env, to: &str) -> Result<()> {
    let (subject, letter) = waitlist_confirmation(&site(env));
    send(env, to, &subject, &letter).await
}

/// One access request, as a staff summary lists it.
pub struct Requested {
    pub email: String,
    pub about: Option<String>,
}

/// The most requests one summary lists; the rest are counted.
pub const SUMMARY_LISTS: usize = 20;

/// The summary staff get of new access requests: every one since the last
/// summary, and how many are waiting in all.
pub fn waitlist_summary(new: &[Requested], waiting: u32) -> (String, Letter) {
    let subject = match new {
        [one] => format!("g1t access request from {}", one.email),
        _ => format!("{} new g1t access requests", new.len()),
    };
    let asked = match new.len() {
        1 => "Someone asked for access to g1t.".to_owned(),
        n => format!("{n} people asked for access to g1t since the last summary."),
    };
    let in_all = if waiting as usize > new.len() {
        format!(" {waiting} requests are waiting in all.")
    } else {
        String::new()
    };
    let mut quotes: Vec<(String, String)> = new
        .iter()
        .take(SUMMARY_LISTS)
        .map(|request| {
            (
                request.email.clone(),
                request
                    .about
                    .as_deref()
                    .map(str::trim)
                    .filter(|about| !about.is_empty())
                    .unwrap_or("(They did not say what they will build.)")
                    .to_owned(),
            )
        })
        .collect();
    if new.len() > SUMMARY_LISTS {
        quotes.push(("And more".to_owned(), format!("{} more requests are on the waitlist.", new.len() - SUMMARY_LISTS)));
    }
    let letter = Letter {
        paragraphs: vec![format!("{asked}{in_all}")],
        quotes,
        code: None,
        action: Some(("Review the waitlist".to_owned(), SUDO_WAITLIST.to_owned())),
        footer: "Sent to WAITLIST_NOTIFY_EMAIL at most once every 15 minutes. A request that arrives in between is in the next summary, and every request is in sudo straight away.".to_owned(),
    };
    (subject, letter)
}

pub async fn send_waitlist_summary(env: &Env, to: &str, new: &[Requested], waiting: u32) -> Result<()> {
    let (subject, letter) = waitlist_summary(new, waiting);
    send(env, to, &subject, &letter).await
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
        Some(code) => format!("{}/invite/{code}", site(env)),
        None => format!("{}/{repo}/invitations", site(env)),
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

/// Why a person is emailed about an inbox item, as the end of a sentence.
fn notified_because(reason: g1t_contracts::inbox::Reason) -> &'static str {
    use g1t_contracts::inbox::Reason;
    match reason {
        Reason::Agent => "an agent is waiting on you",
        Reason::ReviewRequested => "you were asked to review",
        Reason::Assign => "you were assigned",
        Reason::Mention => "you were mentioned",
        Reason::TeamMention => "a team you are in was mentioned",
        Reason::CiActivity => "it is about your work",
        Reason::SecurityAlert => "you look after this repository's security",
        Reason::StateChange => "you are subscribed to it",
        Reason::Author => "you opened it",
        Reason::Comment => "you commented on it",
        Reason::Manual => "you subscribed to it",
        Reason::Subscribed => "you watch this repository",
    }
}

/// An item from the inbox, by email: what happened, what it happened to,
/// and a link to it.
pub fn notification_letter(a: &g1t_contracts::inbox::NotifyByEmailArgs, site: &str) -> Letter {
    let path = if a.path.starts_with('/') { a.path.clone() } else { format!("/{}", a.path) };
    Letter {
        paragraphs: [a.subject.trim(), a.intro.trim()]
            .into_iter()
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect(),
        quotes: a.quote.iter().cloned().collect(),
        code: None,
        action: Some(("Open on g1t".to_owned(), format!("{site}{path}"))),
        footer: format!(
            "You are getting this because {}. Choose what you are emailed for at {site}/settings/notifications.",
            notified_because(a.reason)
        ),
    }
}

pub async fn send_notification(env: &Env, to: &str, a: &g1t_contracts::inbox::NotifyByEmailArgs) -> Result<()> {
    let letter = notification_letter(a, &site(env));
    send(env, to, &a.subject, &letter).await
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
    use super::*;

    #[test]
    fn html_is_escaped() {
        assert_eq!(
            escape("<a href=\"x\">Tom & Jerry's</a>"),
            "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;"
        );
        assert_eq!(escape("https://g1t.sh/verify?token=ab12"), "https://g1t.sh/verify?token=ab12");
    }

    #[test]
    fn an_inbox_item_says_what_happened_and_why_it_was_sent() {
        let a = g1t_contracts::inbox::NotifyByEmailArgs {
            username: "ana".into(),
            repo_id: "rep_1".into(),
            subject: "bo asked you to review acme/rocket#7".into(),
            intro: "Add the inbox".into(),
            quote: None,
            path: "/acme/rocket/pull/7".into(),
            reason: g1t_contracts::inbox::Reason::ReviewRequested,
        };
        let letter = notification_letter(&a, SITE);
        assert_eq!(letter.paragraphs, vec!["bo asked you to review acme/rocket#7", "Add the inbox"]);
        assert_eq!(letter.action.unwrap().1, "https://g1t.sh/acme/rocket/pull/7");
        assert!(letter.footer.starts_with("You are getting this because you were asked to review."));
        assert!(letter.footer.ends_with("https://g1t.sh/settings/notifications."));
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

    fn invite<'a>(note: Option<&'a str>, from: Option<&'a str>) -> InviteEmail<'a> {
        InviteEmail {
            to: "ada@example.com",
            from,
            workspace: Some("Flagon, Inc."),
            joins_existing_account: false,
            code: "g1t-abcd",
            days: 30,
            note,
        }
    }

    #[test]
    fn an_invite_links_to_its_page_and_carries_a_note() {
        let (subject, letter) = invite_letter(&invite(Some("Welcome aboard <3"), None), SITE);
        assert_eq!(subject, "The g1t team invited you to Flagon, Inc. on g1t");
        assert_eq!(letter.action.as_ref().unwrap().1, "https://g1t.sh/invite/g1t-abcd");
        assert_eq!(letter.quotes, vec![("A note from the g1t team".to_owned(), "Welcome aboard <3".to_owned())]);
        let (text, html) = render(&letter, SITE);
        assert!(text.contains("> Welcome aboard <3"));
        assert!(html.contains("Welcome aboard &lt;3"));
        assert!(!html.contains("<3"));
        // No note, no quote; a blank note is no note.
        assert!(invite_letter(&invite(None, Some("Chase Pierce")), SITE).1.quotes.is_empty());
        assert!(invite_letter(&invite(Some("  "), Some("Chase Pierce")), SITE).1.quotes.is_empty());
        assert_eq!(invite_letter(&invite(Some("hi"), Some("Chase Pierce")), SITE).1.quotes[0].0, "A note from Chase Pierce");
    }

    #[test]
    fn links_point_at_the_site_they_are_given() {
        let (_, letter) = invite_letter(&invite(None, None), "http://localhost:8787");
        assert_eq!(letter.action.as_ref().unwrap().1, "http://localhost:8787/invite/g1t-abcd");
        let (text, html) = render(&letter, "http://localhost:8787");
        assert!(html.contains("http://localhost:8787/brand/g1t-logo.png"));
        assert!(!text.contains("g1t.sh/") && !html.contains("https://g1t.sh"));
        let (_, letter) = waitlist_confirmation("http://localhost:8787");
        assert!(letter.footer.contains("localhost:8787/register"));
        assert_eq!(bare("https://git.example.com"), "git.example.com");
    }

    #[test]
    fn the_waitlist_confirmation_promises_no_date() {
        let (subject, letter) = waitlist_confirmation(SITE);
        assert_eq!(subject, "You're on the list for g1t");
        let (text, _) = render(&letter, SITE);
        assert!(text.contains("g1t.sh/register"));
        assert!(text.contains("we'll email you an invite"));
        assert!(text.contains("can't say exactly when"));
        assert!(letter.action.is_none());
    }

    #[test]
    fn staff_summaries_list_each_request_and_link_to_sudo() {
        let one = [Requested { email: "ada@example.com".into(), about: Some("A compiler <for> fun".into()) }];
        let (subject, letter) = waitlist_summary(&one, 1);
        assert_eq!(subject, "g1t access request from ada@example.com");
        assert_eq!(letter.paragraphs, vec!["Someone asked for access to g1t."]);
        assert_eq!(letter.action.as_ref().unwrap().1, SUDO_WAITLIST);
        let (_, html) = render(&letter, SITE);
        assert!(html.contains("A compiler &lt;for&gt; fun"));

        let many: Vec<Requested> = (0..25).map(|n| Requested { email: format!("p{n}@example.com"), about: None }).collect();
        let (subject, letter) = waitlist_summary(&many, 40);
        assert_eq!(subject, "25 new g1t access requests");
        assert_eq!(
            letter.paragraphs[0],
            "25 people asked for access to g1t since the last summary. 40 requests are waiting in all."
        );
        assert_eq!(letter.quotes.len(), SUMMARY_LISTS + 1);
        assert_eq!(letter.quotes[0].1, "(They did not say what they will build.)");
        assert!(letter.quotes.last().unwrap().1.starts_with("5 more"));
    }

    #[test]
    fn a_confirmation_email_shows_the_code_large_and_the_link_as_the_other_way() {
        let (subject, letter) = confirmation_letter(Confirming::NewAccount, "ada", "482913", "https://g1t.sh/verify?token=ab12");
        assert_eq!(subject, "482913 is your g1t confirmation code");
        assert!(letter.paragraphs[0].starts_with("Welcome to g1t, ada."));
        assert_eq!(letter.action.as_ref().unwrap().1, "https://g1t.sh/verify?token=ab12");
        assert!(letter.footer.contains("60 minutes, and only once"));
        let (text, html) = render(&letter, SITE);
        // The code comes before the link, and says either one works.
        let code_at = text.find("    482913").unwrap();
        let link_at = text.find("Confirm email: https://g1t.sh/verify?token=ab12").unwrap();
        assert!(code_at < link_at);
        assert!(text.contains("Either one works"));
        assert!(html.contains("font-size:34px"));
        assert!(html.contains(">482913</p>"));
        assert!(html.find("482913").unwrap() < html.find("verify?token=ab12").unwrap());
        let (_, added) = confirmation_letter(Confirming::AddedAddress, "ada", "000001", "x");
        assert!(added.paragraphs[0].contains("add this address to the g1t account ada"));
        assert!(added.footer.contains("did not add this address"));
    }

    /// Writes each email as HTML for a look in a browser:
    /// `G1T_WRITE_EMAILS=<dir> cargo test -p g1t-identity write_emails`.
    #[test]
    fn write_emails() {
        let Ok(dir) = std::env::var("G1T_WRITE_EMAILS") else { return };
        let page = |name: &str, subject: &str, letter: &Letter| {
            let (_, html) = render(letter, SITE);
            std::fs::write(
                format!("{dir}/{name}.html"),
                format!("<!doctype html><meta charset=utf-8><title>{}</title><body style=\"margin:0;background:#fff\">{html}", escape(subject)),
            )
            .unwrap();
        };
        let (subject, letter) = waitlist_confirmation(SITE);
        page("waitlist-confirmation", &subject, &letter);
        let requests = [
            Requested { email: "ada@example.com".into(), about: Some("A compiler for a teaching language, with agents writing the test suite.".into()) },
            Requested { email: "linus@example.com".into(), about: None },
        ];
        let (subject, letter) = waitlist_summary(&requests, 7);
        page("waitlist-summary", &subject, &letter);
        let (subject, letter) = invite_letter(&InviteEmail {
            to: "margaret@example.com",
            from: Some("Chase Pierce"),
            workspace: Some("Flagon, Inc."),
            joins_existing_account: false,
            code: "g1t-k7m2-q9xd-4hpw-abcd-0123-4567-89ef-ghjk",
            days: 30,
            note: None,
        }, SITE);
        page("workspace-invite", &subject, &letter);
        let (subject, letter) = invite_letter(&InviteEmail {
            to: "ada@example.com",
            from: None,
            workspace: None,
            joins_existing_account: false,
            code: "g1t-k7m2-q9xd-4hpw-abcd-0123-4567-89ef-ghjk",
            days: 30,
            note: Some("Thanks for waiting. We would love to see the compiler."),
        }, SITE);
        page("waitlist-approved", &subject, &letter);
        let (subject, letter) =
            confirmation_letter(Confirming::NewAccount, "ada", "482913", "https://g1t.sh/verify?token=4f9c2a7e0b13d5c8");
        page("confirm-email", &subject, &letter);
    }
}
