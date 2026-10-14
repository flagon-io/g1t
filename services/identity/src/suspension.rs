//! Staff suspending an account or a workspace, and blocking email domains
//! from signing up (sudo.g1t.sh).
//!
//! - A suspended **account** cannot sign in, with a password or GitHub:
//!   it is told it is suspended. Every way of being it (sessions, access
//!   tokens, SSH keys, git passwords) finds nobody while it is, and its
//!   sessions are ended when it is suspended. Lifting it lets it sign in
//!   again; tokens and keys work again as they were.
//! - A suspended **workspace**'s own tokens find nobody while it is. Sudo
//!   also puts a hold on its compute in billing, which stops its runs,
//!   deploys, new self-hosted runners and telemetry.
//! - A **blocked domain** (and its subdomains) makes no new account, with
//!   a password or GitHub, and is not added to an existing one. Accounts
//!   already there are not touched: suspend them one at a time.
//!
//! Every change is in sudo's audit log, with the staff member.

use g1t_contracts::identity::{AdminBlockDomainArgs, AdminSuspendArgs, BlockedDomain, Suspension};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Identity;

/// What a suspended account is told when it signs in.
pub const SUSPENDED: &str = "This account is suspended. If you think this is a mistake, write to support@g1t.sh from its address.";
/// What signing up with a blocked domain is told.
pub const BLOCKED: &str = "Accounts cannot be made with addresses at this domain. Use another address.";

/// A domain as staff type it: lowercased, without `@` or a trailing dot,
/// with at least one dot. None when it is not one.
pub fn normalize_domain(input: &str) -> Option<String> {
    let domain = input.trim().trim_start_matches('@').trim_end_matches('.').to_ascii_lowercase();
    let well_formed = domain.len() <= 253
        && domain.contains('.')
        && domain.split('.').all(|label| {
            !label.is_empty() && label.len() <= 63 && !label.starts_with('-') && !label.ends_with('-') && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    well_formed.then_some(domain)
}

/// The domains a blocked list would match for `email`: its own and each
/// parent, so blocking `example.com` blocks `mail.example.com` too.
pub fn domains_of(email: &str) -> Vec<String> {
    let email = email.trim().to_ascii_lowercase();
    let Some((_, domain)) = email.rsplit_once('@') else {
        return Vec::new();
    };
    let labels: Vec<&str> = domain.split('.').collect();
    (0..labels.len().saturating_sub(1)).map(|at| labels[at..].join(".")).collect()
}

#[derive(Deserialize)]
struct SuspensionRow {
    suspended_at: Option<String>,
    suspended_reason: Option<String>,
    suspended_by: Option<String>,
}

impl SuspensionRow {
    fn shown(self) -> Option<Suspension> {
        Some(Suspension {
            at: self.suspended_at?,
            reason: self.suspended_reason.unwrap_or_default(),
            by: self.suspended_by.unwrap_or_default(),
        })
    }
}

#[derive(Deserialize)]
struct DomainRow {
    domain: String,
    reason: String,
    blocked_by: String,
    created_at: String,
}

impl Identity {
    /// The account's suspension, if it has one.
    pub(crate) async fn user_suspension(&self, user_id: &str) -> Result<Option<Suspension>> {
        Ok(self
            .db
            .prepare("SELECT suspended_at, suspended_reason, suspended_by FROM users WHERE id = ?")
            .bind(&[user_id.into()])?
            .first::<SuspensionRow>(None)
            .await?
            .and_then(SuspensionRow::shown))
    }

    /// The workspace's suspension, if it has one, by slug.
    pub(crate) async fn workspace_suspension(&self, slug: &str) -> Result<Option<Suspension>> {
        Ok(self
            .db
            .prepare("SELECT suspended_at, suspended_reason, suspended_by FROM workspaces WHERE slug = ? AND deleted_at IS NULL")
            .bind(&[slug.trim().to_lowercase().into()])?
            .first::<SuspensionRow>(None)
            .await?
            .and_then(SuspensionRow::shown))
    }

    /// Whether an address is at a blocked domain.
    pub(crate) async fn email_blocked(&self, email: &str) -> Result<bool> {
        let domains = domains_of(email);
        if domains.is_empty() {
            return Ok(false);
        }
        let marks = vec!["?"; domains.len()].join(", ");
        let binds: Vec<worker::wasm_bindgen::JsValue> = domains.iter().map(|d| d.as_str().into()).collect();
        Ok(self
            .db
            .prepare(format!("SELECT domain FROM blocked_domains WHERE domain IN ({marks}) LIMIT 1"))
            .bind(&binds)?
            .first::<serde_json::Value>(None)
            .await?
            .is_some())
    }

    pub async fn admin_suspend_user(&self, a: AdminSuspendArgs) -> Result<Outcome<Option<Suspension>>> {
        let username = a.name.trim().trim_start_matches('@').to_lowercase();
        self.suspend("users", "username", &username, a, "account").await
    }

    pub async fn admin_suspend_workspace(&self, a: AdminSuspendArgs) -> Result<Outcome<Option<Suspension>>> {
        let slug = a.name.trim().to_lowercase();
        self.suspend("workspaces", "slug", &slug, a, "workspace").await
    }

    async fn suspend(&self, table: &str, column: &str, name: &str, a: AdminSuspendArgs, what: &str) -> Result<Outcome<Option<Suspension>>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is doing it."));
        }
        let reason = a.reason.trim();
        if a.suspend && reason.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("Say why the {what} is suspended. It is kept with the suspension.")));
        }
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let Some(Id { id }) = self
            .db
            .prepare(format!("SELECT id FROM {table} WHERE {column} = ? AND deleted_at IS NULL"))
            .bind(&[name.into()])?
            .first::<Id>(None)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no {what} called {name}.")));
        };
        if a.suspend {
            self.db
                .prepare(format!("UPDATE {table} SET suspended_at = ?, suspended_reason = ?, suspended_by = ? WHERE id = ?"))
                .bind(&[rfc3339(now_ms()).into(), reason.into(), staff.into(), id.as_str().into()])?
                .run()
                .await?;
            if table == "users" {
                // Signed out everywhere at once.
                self.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(&[id.as_str().into()])?.run().await?;
            }
        } else {
            self.db
                .prepare(format!("UPDATE {table} SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL WHERE id = ?"))
                .bind(&[id.as_str().into()])?
                .run()
                .await?;
        }
        let (action, detail) = if a.suspend {
            (format!("{what}_suspended"), format!("Suspended {name}: {reason}"))
        } else {
            (format!("{what}_unsuspended"), format!("Lifted the suspension of {name}"))
        };
        self.record_for_staff(name, &action, &detail, staff).await;
        let now = if table == "users" { self.user_suspension(&id).await? } else { self.workspace_suspension(name).await? };
        Ok(Outcome::Ok(now))
    }

    pub async fn admin_blocked_domains(&self) -> Result<Vec<BlockedDomain>> {
        Ok(self
            .db
            .prepare("SELECT domain, reason, blocked_by, created_at FROM blocked_domains ORDER BY domain")
            .all()
            .await?
            .results::<DomainRow>()?
            .into_iter()
            .map(|row| BlockedDomain { domain: row.domain, reason: row.reason, blocked_by: row.blocked_by, created_at: row.created_at })
            .collect())
    }

    pub async fn admin_block_domain(&self, a: AdminBlockDomainArgs) -> Result<Outcome<Vec<BlockedDomain>>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is doing it."));
        }
        let Some(domain) = normalize_domain(&a.domain) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Enter a domain, such as spam.example."));
        };
        if a.block {
            let reason = a.reason.trim();
            if reason.is_empty() {
                return Ok(Outcome::fail(FailureCode::Invalid, "Say why the domain is blocked."));
            }
            self.db
                .prepare(
                    "INSERT INTO blocked_domains (domain, reason, blocked_by, created_at) VALUES (?, ?, ?, ?)
                     ON CONFLICT (domain) DO UPDATE SET reason = excluded.reason, blocked_by = excluded.blocked_by",
                )
                .bind(&[domain.as_str().into(), reason.into(), staff.into(), rfc3339(now_ms()).into()])?
                .run()
                .await?;
            self.record_for_staff(&domain, "email_domain_blocked", &format!("Blocked sign-ups from {domain}: {reason}"), staff).await;
        } else {
            self.db.prepare("DELETE FROM blocked_domains WHERE domain = ?").bind(&[domain.as_str().into()])?.run().await?;
            self.record_for_staff(&domain, "email_domain_unblocked", &format!("Unblocked sign-ups from {domain}"), staff).await;
        }
        Ok(Outcome::Ok(self.admin_blocked_domains().await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_are_read_as_staff_type_them() {
        assert_eq!(normalize_domain(" @Spam.Example. ").as_deref(), Some("spam.example"));
        assert_eq!(normalize_domain("mail.spam.example").as_deref(), Some("mail.spam.example"));
        for bad in ["", "localhost", "spam..example", "-spam.example", "spam example.com", "a@b.com"] {
            assert_eq!(normalize_domain(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_blocked_domain_blocks_its_subdomains_too() {
        assert_eq!(domains_of("Ada@Mail.Spam.Example"), ["mail.spam.example", "spam.example"]);
        assert_eq!(domains_of("ada@example.com"), ["example.com"]);
        assert!(domains_of("not-an-address").is_empty());
    }
}
