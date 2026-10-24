//! Intake is independent of account closure, workspace ownership and billing.
//! Staff assess shared content and retention; an event publish is not proof of erasure.
use crate::{Identity, security::is_person};
use g1t_contracts::identity::UserArgs;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;

#[derive(Deserialize)]
pub(crate) struct RequestArgs {
    user: User,
}
#[derive(Deserialize)]
pub(crate) struct ReviewArgs {
    id: String,
    staff: String,
    status: String,
    evidence: String,
}
#[derive(Deserialize)]
pub(crate) struct IntakeArgs {
    username: String,
    received_at: String,
    staff: String,
    evidence: String,
}
#[derive(Deserialize, Serialize)]
pub(crate) struct ErasureRequest {
    id: String,
    user_id: String,
    username: String,
    requested_at: String,
    due_at: String,
    status: String,
    scope: String,
    evidence: String,
    updated_at: String,
    updated_by: Option<String>,
    closed_at: Option<String>,
    /// The case's trail, oldest first: intake notes, reviews, refusal or completion.
    #[serde(default)]
    reviews: Vec<Review>,
}
#[derive(Deserialize, Serialize)]
pub(crate) struct Review {
    #[serde(default, skip_serializing)]
    request_id: String,
    at: String,
    staff: String,
    status: String,
    evidence: String,
}

/// Same day next month, clamped to its last day; never a fixed 30-day delay.
fn deadline(now: &str) -> String {
    let mut year: u32 = now[0..4].parse().unwrap();
    let month: u32 = now[5..7].parse().unwrap();
    let day: u32 = now[8..10].parse().unwrap();
    let month = if month == 12 {
        year += 1;
        1
    } else {
        month + 1
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    format!("{year:04}-{month:02}-{:02}{}", day.min(days), &now[10..])
}

impl Identity {
    /// Requests received by email or verbally keep their original receipt date.
    pub(crate) async fn intake_erasure(&self, a: IntakeArgs) -> Result<Outcome<bool>> {
        let now = rfc3339(now_ms());
        let received = g1t_contracts::time::parse_rfc3339(&a.received_at).map(rfc3339);
        let Some(received) = received.filter(|at| at <= &now && at == &a.received_at) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Use the original receipt time in UTC (YYYY-MM-DDTHH:MM:SS.sssZ), no later than now.",
            ));
        };
        if a.staff.trim().is_empty() || a.evidence.trim().is_empty() || a.evidence.len() > 16000 {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Record the source of the request and the identity verification needed or performed.",
            ));
        }
        #[derive(Deserialize)]
        struct Person {
            id: String,
            username: String,
        }
        let Some(person) = self.db.prepare("SELECT id, username FROM users WHERE username = ?1 UNION ALL SELECT user_id AS id, username FROM deleted_users WHERE username = ?1 LIMIT 1")
            .bind(&[a.username.trim().to_lowercase().into()])?.first::<Person>(None).await? else {
                return Ok(Outcome::fail(FailureCode::NotFound, "Account not found. Track requests about non-account data in the restricted support case system."));
            };
        // Earlier evidence of receipt moves the deadline earlier, never later.
        // The intake notes join the open case's review trail either way, so a
        // second channel's evidence is never dropped by the upsert.
        let id = new_id("era", now_ms());
        self.db.batch(vec![
            self.db.prepare("INSERT INTO erasure_requests (id, user_id, username, requested_at, due_at, scope, evidence, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'Personal data and account; assess shared content and lawful retention separately', ?, ?, ?) ON CONFLICT(user_id) WHERE closed_at IS NULL DO UPDATE SET requested_at = min(requested_at, excluded.requested_at), due_at = min(due_at, excluded.due_at)")
                .bind(&[id.as_str().into(), person.id.as_str().into(), person.username.into(), received.as_str().into(), deadline(&received).into(), a.evidence.as_str().into(), now.as_str().into(), a.staff.as_str().into()])?,
            self.db.prepare("INSERT INTO erasure_reviews (request_id, at, staff, status, evidence) SELECT id, ?2, ?3, 'intake', ?4 FROM erasure_requests WHERE user_id = ?1 AND closed_at IS NULL")
                .bind(&[person.id.into(), now.into(), a.staff.into(), format!("Received {received}. {}", a.evidence).into()])?,
        ]).await?;
        Ok(Outcome::Ok(true))
    }

    pub(crate) async fn request_erasure(&self, a: RequestArgs) -> Result<Outcome<serde_json::Value>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Sign in as yourself to request erasure."));
        }
        #[derive(Deserialize)]
        struct Person {
            username: String,
        }
        let Some(person) = self
            .db
            .prepare("SELECT username FROM users WHERE id = ? AND deleted_at IS NULL")
            .bind(&[a.user.id.as_str().into()])?
            .first::<Person>(None)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Account not found."));
        };
        let now = rfc3339(now_ms());
        let due = deadline(&now);
        self.db.prepare("INSERT OR IGNORE INTO erasure_requests (id, user_id, username, requested_at, due_at, scope, updated_at) VALUES (?, ?, ?, ?, ?, 'Personal data and account; assess shared content and lawful retention separately', ?)")
            .bind(&[new_id("era", now_ms()).into(), a.user.id.as_str().into(), person.username.into(), now.as_str().into(), due.into(), now.into()])?.run().await?;
        let row = self
            .db
            .prepare("SELECT * FROM erasure_requests WHERE user_id = ? AND closed_at IS NULL")
            .bind(&[a.user.id.into()])?
            .first::<ErasureRequest>(None)
            .await?
            .ok_or_else(|| worker::Error::RustError("Request not recorded".into()))?;
        Ok(Outcome::Ok(serde_json::json!({"id": row.id, "requested_at": row.requested_at, "due_at": row.due_at, "status": row.status})))
    }

    pub(crate) async fn my_erasure(&self, a: UserArgs) -> Result<Option<serde_json::Value>> {
        if !is_person(&a.user) {
            return Ok(None);
        }
        // Internal notes and staff details are not part of the self-service status.
        self.db
            .prepare("SELECT id, requested_at, due_at, status FROM erasure_requests WHERE user_id = ? ORDER BY requested_at DESC LIMIT 1")
            .bind(&[a.user.id.into()])?
            .first(None)
            .await
    }

    pub(crate) async fn erasure_requests(&self) -> Result<Vec<ErasureRequest>> {
        const LISTED: &str = "SELECT id FROM erasure_requests ORDER BY closed_at IS NOT NULL, due_at LIMIT 500";
        let mut requests = self
            .db
            .prepare(format!("SELECT * FROM erasure_requests WHERE id IN ({LISTED}) ORDER BY closed_at IS NOT NULL, due_at"))
            .all()
            .await?
            .results::<ErasureRequest>()?;
        let reviews = self
            .db
            .prepare(format!(
                "SELECT request_id, at, staff, status, evidence FROM erasure_reviews WHERE request_id IN ({LISTED}) ORDER BY id"
            ))
            .all()
            .await?
            .results::<Review>()?;
        for review in reviews {
            if let Some(request) = requests.iter_mut().find(|r| r.id == review.request_id) {
                request.reviews.push(review);
            }
        }
        Ok(requests)
    }

    pub(crate) async fn review_erasure(&self, a: ReviewArgs) -> Result<Outcome<bool>> {
        if a.staff.trim().is_empty()
            || !["reviewing", "completed", "refused"].contains(&a.status.as_str())
            || a.evidence.trim().is_empty()
            || a.evidence.len() > 16000
        {
            return Ok(Outcome::fail(FailureCode::Invalid, "Choose a status and record the review evidence (up to 16,000 bytes)."));
        }
        let Some(case) = self
            .db
            .prepare("SELECT * FROM erasure_requests WHERE id = ? AND closed_at IS NULL")
            .bind(&[a.id.as_str().into()])?
            .first::<ErasureRequest>(None)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Open request not found."));
        };
        if a.status == "completed" {
            let pending = self.db.prepare("SELECT 1 FROM users WHERE id = ?1 UNION ALL SELECT 1 FROM purge_jobs WHERE subject_id = ?1 AND completed_at IS NULL LIMIT 1")
                .bind(&[case.user_id.as_str().into()])?.first::<serde_json::Value>(None).await?.is_some();
            if pending {
                return Ok(Outcome::fail(FailureCode::Conflict, "Account purge and its cleanup jobs must finish before completion."));
            }
            // Each part needs an actual outcome, including a reason for anything retained.
            let evidence: serde_json::Value = match serde_json::from_str(&a.evidence) {
                Ok(value) => value,
                Err(_) => {
                    return Ok(Outcome::fail(FailureCode::Invalid, "Completion evidence must be a JSON object."));
                }
            };
            for key in ["identity", "downstream", "shared_content", "processors", "backups", "response", "retention"] {
                if evidence.get(key).and_then(serde_json::Value::as_str).is_none_or(|v| v.trim().is_empty()) {
                    return Ok(Outcome::fail(FailureCode::Invalid, format!("Record the {key} outcome before completing this request.")));
                }
            }
        }
        let now = rfc3339(now_ms());
        self.db.batch(vec![
            self.db.prepare("INSERT INTO erasure_reviews (request_id, at, staff, status, evidence) SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM erasure_requests WHERE id = ?1 AND closed_at IS NULL)")
                .bind(&[a.id.as_str().into(), now.as_str().into(), a.staff.as_str().into(), a.status.as_str().into(), a.evidence.as_str().into()])?,
            self.db.prepare("UPDATE erasure_requests SET status = ?2, evidence = ?3, updated_at = ?4, updated_by = ?5, closed_at = CASE WHEN ?2 IN ('completed','refused') THEN ?4 ELSE NULL END WHERE id = ?1 AND closed_at IS NULL")
                .bind(&[a.id.into(), a.status.into(), a.evidence.into(), now.into(), a.staff.into()])?,
        ]).await?;
        Ok(Outcome::Ok(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calendar_month_deadlines() {
        for (from, to) in
            [("2026-01-31", "2026-02-28"), ("2028-01-31", "2028-02-29"), ("2026-12-14", "2027-01-14"), ("2026-10-14", "2026-11-14")]
        {
            assert_eq!(deadline(&format!("{from}T15:30:00.123Z")), format!("{to}T15:30:00.123Z"));
        }
    }
}
