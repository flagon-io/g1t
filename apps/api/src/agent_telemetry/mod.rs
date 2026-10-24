//! Coding agents' own OpenTelemetry: `POST /v1/logs` and `POST /v1/metrics`
//! on the API's address, OTLP over HTTP in protobuf or JSON, gzipped or
//! not, with a g1t access token in `Authorization` (an exporter's
//! `OTEL_EXPORTER_OTLP_HEADERS`). What it reads becomes the usage and cost
//! of the sessions it belongs to (the work service's
//! `record_agent_telemetry`); the rest of each request is dropped unread
//! (harnesses.rs).
//!
//! Whose sessions they are comes from the token. A person's token records
//! that person's sessions, whatever address the records name. A workspace
//! token, the one for settings rolled out to every machine, records each
//! of its workspace's members' through the address the records name
//! (`user.email`, `cursor.user.email`), when the member has verified it;
//! records it cannot place are rejected (a partial success), as are a
//! person's token's records from Cursor's team export, which carries
//! everyone's.
//!
//! These are not the project telemetry paths (`/otlp/v1/…`, which take a
//! project's ingest token): see lib.rs `otlp_signal`.

mod harnesses;
mod wire;

use std::collections::{BTreeMap, BTreeSet};

use g1t_contracts::identity::{MemberEmail, MembersByEmailArgs, UserIdArgs};
use g1t_contracts::scopes::Scope;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{
    Harness, MAX_TELEMETRY_PEOPLE, MAX_TELEMETRY_SESSIONS, RecordTelemetryArgs, TelemetryRecorded, TelemetrySession,
};
use g1t_contracts::{Outcome, PrincipalKind, User, Viewer};
use serde_json::json;
use worker::{Request, Response, Result};

use crate::operations::Services;
use harnesses::Found;

/// The most bytes a request's body may have as sent.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
/// The most bytes a gzipped body may inflate to.
pub const MAX_INFLATED_BYTES: usize = 16 * 1024 * 1024;

/// Which of the two an export sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Logs,
    Metrics,
}

/// The signal a path receives (`/v1/logs` or `/v1/metrics`), if it is one.
pub fn signal_of(path: &str) -> Option<Signal> {
    match path.trim_end_matches('/') {
        "/v1/logs" => Some(Signal::Logs),
        "/v1/metrics" => Some(Signal::Metrics),
        _ => None,
    }
}

/// How the request was encoded, which its answer is encoded in too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Encoding {
    Protobuf,
    Json,
}

/// An answer: 200 with the export's (partial) success, or an error as a
/// `google.rpc.Status`, in the request's encoding.
fn answer(encoding: Encoding, status: u16, body: Vec<u8>) -> Result<Response> {
    let response = if body.is_empty() { Response::empty()? } else { Response::from_bytes(body)? };
    let mut response = response.with_status(status);
    let kind = match encoding {
        Encoding::Protobuf => "application/x-protobuf",
        Encoding::Json => "application/json",
    };
    response.headers_mut().set("content-type", kind)?;
    Ok(response)
}

/// A `google.rpc.Status` code for each HTTP status sent.
fn refuse(encoding: Encoding, status: u16, message: &str) -> Result<Response> {
    let code = match status {
        401 => 16,
        403 => 7,
        413 => 8,
        _ => 3,
    };
    let body = match encoding {
        Encoding::Protobuf => wire::status_protobuf(code, message),
        Encoding::Json => serde_json::to_vec(&json!({ "code": code, "message": message }))?,
    };
    answer(encoding, status, body)
}

/// What an export answers once read: how many records or points were
/// rejected, and why.
fn accepted(encoding: Encoding, signal: Signal, rejected: u64, message: &str) -> Result<Response> {
    let body = match encoding {
        Encoding::Protobuf => wire::partial_success_protobuf(rejected, message),
        Encoding::Json if rejected == 0 && message.is_empty() => b"{}".to_vec(),
        Encoding::Json => {
            let count = match signal {
                Signal::Logs => "rejectedLogRecords",
                Signal::Metrics => "rejectedDataPoints",
            };
            serde_json::to_vec(&json!({ "partialSuccess": { count: rejected.to_string(), "errorMessage": message } }))?
        }
    };
    answer(encoding, 200, body)
}

/// Why a caller may not send agent telemetry, if it may not: it needs a
/// person's token or a workspace token (not a workflow job's), with the
/// `work:write` scope sessions need.
pub fn refusal(viewer: &Viewer) -> Option<(u16, String)> {
    let Some(user) = viewer else {
        return Some((401, "Send a g1t access token: Authorization: Bearer g1t_….".to_owned()));
    };
    if !matches!(user.kind, PrincipalKind::User | PrincipalKind::Workspace) {
        return Some((403, "Agent telemetry is sent with a person's access token or a workspace token.".to_owned()));
    }
    if let Some(access) = user.token.as_deref() {
        if access.job.is_some() {
            return Some((403, "A workflow job's token cannot send agent telemetry.".to_owned()));
        }
        if !access.allows(Scope::WorkWrite) {
            return Some((403, format!("This access token needs the {} scope to record sessions.", Scope::WorkWrite.as_str())));
        }
    }
    None
}

/// The bytes of a gzip body, inflated, up to [`MAX_INFLATED_BYTES`].
fn gunzip(bytes: &[u8]) -> std::result::Result<Vec<u8>, String> {
    let bad = || "The body is not gzipped as Content-Encoding says.".to_owned();
    if bytes.len() < 18 || bytes[0] != 0x1f || bytes[1] != 0x8b || bytes[2] != 8 {
        return Err(bad());
    }
    let flags = bytes[3];
    let mut at = 10;
    if flags & 4 != 0 {
        let extra = bytes.get(at..at + 2).ok_or_else(bad)?;
        at += 2 + usize::from(u16::from_le_bytes([extra[0], extra[1]]));
    }
    for flag in [8u8, 16] {
        if flags & flag != 0 {
            at += bytes.get(at..).ok_or_else(bad)?.iter().position(|b| *b == 0).ok_or_else(bad)? + 1;
        }
    }
    if flags & 2 != 0 {
        at += 2;
    }
    let body = bytes.get(at..bytes.len() - 8).ok_or_else(bad)?;
    miniz_oxide::inflate::decompress_to_vec_with_limit(body, MAX_INFLATED_BYTES)
        .map_err(|_| format!("The body is damaged, or inflates past {MAX_INFLATED_BYTES} bytes."))
}

/// What a request says each session used.
fn read(signal: Signal, encoding: Encoding, body: &[u8]) -> std::result::Result<Vec<Found>, String> {
    Ok(match (signal, encoding) {
        (Signal::Logs, Encoding::Protobuf) => harnesses::read_logs(&wire::logs_from_protobuf(body)?).0,
        (Signal::Logs, Encoding::Json) => harnesses::read_logs(&wire::logs_from_json(body)?).0,
        (Signal::Metrics, Encoding::Protobuf) => harnesses::read_metrics(&wire::metrics_from_protobuf(body)?).0,
        (Signal::Metrics, Encoding::Json) => harnesses::read_metrics(&wire::metrics_from_json(body)?).0,
    })
}

/// Each session's usage, as the work service takes it, for `actor_id`.
fn session_of(found: &Found, actor_id: &str, now_ms: u64) -> TelemetrySession {
    let ms = found.seen_unix_nano / 1_000_000;
    TelemetrySession {
        actor_id: actor_id.to_owned(),
        harness: found.harness,
        harness_session_id: found.harness_session_id.clone(),
        signal: found.signal,
        cumulative: found.cumulative,
        usage: found.usage.clone(),
        repo: found.repo.clone(),
        model: found.model(),
        seen_at: if ms == 0 { rfc3339(now_ms) } else { rfc3339(ms.min(now_ms)) },
    }
}

/// Whose each session is, for a person's own token: theirs, except
/// Cursor's team export, which carries everyone's. The sessions, and how
/// many records were rejected.
pub fn for_person(user: &User, found: &[Found], now_ms: u64) -> (Vec<TelemetrySession>, u64) {
    let mut sessions = Vec::new();
    let mut rejected = 0;
    for one in found {
        if one.harness == Harness::Cursor {
            rejected += one.records;
        } else {
            sessions.push(session_of(one, &user.id, now_ms));
        }
    }
    (sessions, rejected)
}

/// Whose each session is, for a workspace token: the member who verified
/// the address it names. The sessions, and how many records were rejected.
pub fn for_members(found: &[Found], members: &[MemberEmail], now_ms: u64) -> (Vec<TelemetrySession>, u64) {
    let mut sessions = Vec::new();
    let mut rejected = 0;
    for one in found {
        let member = one.email.as_deref().and_then(|email| members.iter().find(|member| member.email.eq_ignore_ascii_case(email)));
        match member {
            Some(member) => sessions.push(session_of(one, &member.user_id, now_ms)),
            None => rejected += one.records,
        }
    }
    (sessions, rejected)
}

/// Receives one export.
pub async fn receive(mut request: Request, services: &Services, viewer: &Viewer, signal: Signal) -> Result<Response> {
    let content_type = request.headers().get("content-type")?.unwrap_or_default().to_ascii_lowercase();
    let encoding = if content_type.starts_with("application/json") {
        Encoding::Json
    } else if content_type.is_empty()
        || content_type.starts_with("application/x-protobuf")
        || content_type.starts_with("application/protobuf")
    {
        Encoding::Protobuf
    } else {
        return refuse(Encoding::Json, 415, "Send OTLP as application/x-protobuf or application/json.");
    };
    if let Some((status, message)) = refusal(viewer) {
        return refuse(encoding, status, &message);
    }
    let Some(user) = viewer else { return refuse(encoding, 401, "Send a g1t access token.") };
    let declared: usize = request.headers().get("content-length")?.and_then(|length| length.parse().ok()).unwrap_or(0);
    if declared > MAX_BODY_BYTES {
        return refuse(encoding, 413, &format!("An export is at most {MAX_BODY_BYTES} bytes: send smaller batches."));
    }
    let body = request.bytes().await?;
    if body.len() > MAX_BODY_BYTES {
        return refuse(encoding, 413, &format!("An export is at most {MAX_BODY_BYTES} bytes: send smaller batches."));
    }
    let body = match request.headers().get("content-encoding")?.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
        "" | "identity" => body,
        "gzip" => match gunzip(&body) {
            Ok(body) => body,
            Err(message) => return refuse(encoding, 400, &message),
        },
        _ => return refuse(encoding, 415, "Send the body as it is, or gzipped."),
    };
    let found = match read(signal, encoding, &body) {
        Ok(read) => read,
        Err(message) => return refuse(encoding, 400, &message),
    };
    if found.is_empty() {
        return accepted(encoding, signal, 0, "");
    }
    let now = g1t_kit::now_ms();

    let (people, workspace, sessions, rejected, why) = if user.kind == PrincipalKind::Workspace {
        let workspace = user.username.clone();
        let emails: BTreeSet<String> = found.iter().filter_map(|one| one.email.clone()).collect();
        let members: Vec<MemberEmail> = if emails.is_empty() {
            Vec::new()
        } else {
            g1t_kit::call(
                &services.identity,
                "members_by_email",
                &MembersByEmailArgs { workspace: workspace.clone(), emails: emails.into_iter().collect() },
            )
            .await?
        };
        let (sessions, rejected) = for_members(&found, &members, now);
        // Each member as identity knows them, with this token's reach.
        let mut people = Vec::new();
        let ids: BTreeSet<&str> = sessions.iter().map(|session| session.actor_id.as_str()).collect();
        for id in ids.into_iter().take(MAX_TELEMETRY_PEOPLE) {
            let member: Viewer = g1t_kit::call(&services.identity, "user_by_id", &UserIdArgs { id: id.to_owned() }).await?;
            if let Some(mut member) = member {
                member.token = user.token.clone();
                people.push(member);
            }
        }
        let why = "Records whose user.email (or cursor.user.email) is no address a member of this workspace has verified are not kept.";
        (people, Some(workspace), sessions, rejected, why)
    } else {
        let (sessions, rejected) = for_person(user, &found, now);
        let why = "Cursor's team export carries everyone's usage: send it with a workspace token.";
        (vec![user.clone()], None, sessions, rejected, why)
    };

    // A request rarely names more sessions than one call takes.
    let mut by_chunk: BTreeMap<usize, Vec<TelemetrySession>> = BTreeMap::new();
    for (index, session) in sessions.into_iter().enumerate() {
        by_chunk.entry(index / MAX_TELEMETRY_SESSIONS).or_default().push(session);
    }
    for (_, sessions) in by_chunk {
        let recorded: Outcome<TelemetryRecorded> = g1t_kit::call(
            &services.work,
            "record_agent_telemetry",
            &RecordTelemetryArgs { people: people.clone(), workspace: workspace.clone(), sessions },
        )
        .await?;
        if let Outcome::Fail(failure) = recorded {
            return refuse(encoding, 400, &failure.message);
        }
    }
    accepted(encoding, signal, rejected, if rejected > 0 { why } else { "" })
}

#[cfg(test)]
mod tests {
    use g1t_contracts::scopes::TokenAccess;
    use g1t_contracts::work::{TelemetrySignal, TelemetryUsage};

    use super::*;

    fn found(harness: Harness, email: Option<&str>) -> Found {
        Found {
            harness,
            harness_session_id: "abc".into(),
            email: email.map(str::to_owned),
            signal: TelemetrySignal::Logs,
            cumulative: false,
            usage: vec![TelemetryUsage::default()],
            repo: None,
            seen_unix_nano: 1_792_692_000_000_000_000,
            records: 3,
        }
    }

    #[test]
    fn the_paths_are_the_otlp_defaults_at_the_root() {
        assert_eq!(signal_of("/v1/logs"), Some(Signal::Logs));
        assert_eq!(signal_of("/v1/metrics/"), Some(Signal::Metrics));
        assert_eq!(signal_of("/v1/traces"), None);
        assert_eq!(signal_of("/logs"), None);
        assert_eq!(signal_of("/otlp/v1/logs"), None, "a project's telemetry, not an agent's");
    }

    #[test]
    fn only_a_persons_or_a_workspaces_token_with_work_write_may_send() {
        assert_eq!(refusal(&None).map(|(status, _)| status), Some(401));
        let person = User { id: "usr_1".into(), kind: PrincipalKind::User, verified: true, ..User::default() };
        assert_eq!(refusal(&Some(person.clone())), None);
        let reader = User {
            token: Some(Box::new(TokenAccess { scopes: Some(vec![Scope::WorkRead.as_str().to_owned()]), ..TokenAccess::default() })),
            ..person.clone()
        };
        let (status, message) = refusal(&Some(reader)).unwrap();
        assert_eq!(status, 403);
        assert!(message.contains("work:write"), "{message}");
        let writer = User {
            token: Some(Box::new(TokenAccess { scopes: Some(vec![Scope::WorkWrite.as_str().to_owned()]), ..TokenAccess::default() })),
            ..person.clone()
        };
        assert_eq!(refusal(&Some(writer)), None);
        let workspace = User { username: "acme".into(), kind: PrincipalKind::Workspace, ..User::default() };
        assert_eq!(refusal(&Some(workspace.clone())), None);
        let job = User { token: Some(Box::new(TokenAccess { job: Some(Default::default()), ..TokenAccess::default() })), ..workspace };
        assert_eq!(refusal(&Some(job)).map(|(status, _)| status), Some(403));
        let agent = User { kind: PrincipalKind::Agent, ..User::default() };
        assert_eq!(refusal(&Some(agent)).map(|(status, _)| status), Some(403));
    }

    #[test]
    fn a_persons_token_records_their_own_sessions_whatever_address_they_name() {
        let ana = User { id: "usr_ana".into(), ..User::default() };
        let (sessions, rejected) = for_person(&ana, &[found(Harness::ClaudeCode, Some("bo@example.com"))], 1_792_692_100_000);
        assert_eq!(rejected, 0);
        assert_eq!(sessions[0].actor_id, "usr_ana");
        assert_eq!(sessions[0].seen_at, "2026-10-22T18:00:00.000Z");
        // Cursor's team export is everyone's: not one person's to send.
        let (sessions, rejected) = for_person(&ana, &[found(Harness::Cursor, Some("ana@example.com"))], 0);
        assert!(sessions.is_empty());
        assert_eq!(rejected, 3);
    }

    #[test]
    fn a_workspace_token_records_members_by_the_addresses_they_verified() {
        let members = vec![MemberEmail { email: "ana@example.com".into(), user_id: "usr_ana".into(), username: "ana".into() }];
        let (sessions, rejected) = for_members(
            &[
                found(Harness::Cursor, Some("Ana@Example.com")),
                found(Harness::ClaudeCode, Some("eve@example.com")),
                found(Harness::Copilot, None),
            ],
            &members,
            1_792_692_100_000,
        );
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].actor_id, "usr_ana");
        assert_eq!(sessions[0].harness, Harness::Cursor);
        assert_eq!(rejected, 6);
    }

    #[test]
    fn a_clock_ahead_is_taken_as_now() {
        let ana = User { id: "usr_ana".into(), ..User::default() };
        let mut ahead = found(Harness::ClaudeCode, None);
        ahead.seen_unix_nano = u64::MAX;
        let (sessions, _) = for_person(&ana, &[ahead], 1_792_692_000_000);
        assert_eq!(sessions[0].seen_at, "2026-10-22T18:00:00.000Z");
    }

    #[test]
    fn a_gzipped_body_inflates_and_a_bomb_does_not() {
        let gzip = |data: &[u8]| {
            let mut out = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255];
            out.extend(miniz_oxide::deflate::compress_to_vec(data, 6));
            out.extend_from_slice(&[0; 8]);
            out
        };
        assert_eq!(gunzip(&gzip(b"{\"resourceLogs\":[]}")).unwrap(), b"{\"resourceLogs\":[]}");
        assert!(gunzip(b"not gzip at all, no").is_err());
        assert!(gunzip(&gzip(&vec![0; MAX_INFLATED_BYTES + 1])).is_err());
    }
}
