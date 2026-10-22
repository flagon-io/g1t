//! Brokered secrets: a secret a job uses only to call an API never enters
//! its sandbox. Its row names the hosts it is for (settings.rs); when a job
//! starts, `job_spec` gives the job a stand-in in its place, one per job and
//! secret, and keeps here what the stand-in stands for, sealed and bound to
//! it, until the job's time is up. The runner Worker sees every HTTP and
//! HTTPS request a job on g1t's machines makes (services/runner broker.ts),
//! asks `brokered_secrets` with the job's token for its stand-ins, and puts
//! the real value in place of a stand-in on requests to the secret's hosts
//! as they leave. Anywhere else the stand-in goes as it is, which is
//! useless to whoever receives it.
//!
//! A self-hosted runner's traffic never passes the Worker, and the real
//! value is never sent to a machine g1t does not run. A harness that can
//! broker (on Linux or macOS, `JobCallArgs::broker`) is given each
//! stand-in's hosts in its spec (`brokered`), never a value: its job's
//! HTTPS to those hosts goes through a proxy of the harness's, which
//! passes each request carrying a stand-in to g1t
//! (`POST /actions/jobs/{job}/broker`), where the runner Worker fills it
//! in (`relayed_secrets`), sends it and scrubs the answer. Any other
//! harness's job keeps the stand-in, and its log says why it will not
//! work.

use g1t_contracts::actions::{BrokeredSecret, JobCallArgs, STAND_IN_PREFIX};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use g1t_secrets::random_hex;
use serde::Deserialize;
use serde_json::{Map, Value};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::plan::{LOG_COUNTED, LOG_INSERT};
use crate::{Actions, Count, check, fail};

/// The most hosts one brokered secret names.
pub(crate) const MAX_HOSTS: usize = 20;
/// The shortest value a brokered secret may have: a shorter one would be
/// found, and swapped, inside unrelated secrets.
pub(crate) const MIN_VALUE_CHARS: usize = 8;

/// Keeps a job's stand-in: what it stands for, sealed and bound to it.
pub(crate) const STAND_IN_INSERT: &str =
    "INSERT OR REPLACE INTO brokered_secrets (stand_in, job_id, name, value, hosts, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
/// A job's stand-ins that still work at `?2`.
pub(crate) const STAND_INS_OF_JOB: &str =
    "SELECT stand_in, name, value, hosts FROM brokered_secrets WHERE job_id = ?1 AND expires_at > ?2";
/// Stand-ins whose jobs' time is up.
pub(crate) const STAND_INS_EXPIRED: &str = "DELETE FROM brokered_secrets WHERE expires_at <= ?1";

/// A brokered secret as one reader resolved it: its key, real value and
/// the hosts it is for.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Broker {
    pub name: String,
    pub value: String,
    pub hosts: Vec<String>,
}

/// A stand-in made for one job.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StandIn {
    pub stand_in: String,
    pub broker: Broker,
}

/// A new stand-in: the prefix and 48 random hex characters.
pub(crate) fn stand_in() -> String {
    format!("{STAND_IN_PREFIX}{}", random_hex(24))
}

/// Puts a stand-in in place of each brokered value wherever it appears in
/// `secrets`, as a whole value or inside one a called workflow built from
/// it (`${{ secrets.USER }}:${{ secrets.TOKEN }}`), and returns the
/// stand-ins made: one per brokered value found, whatever keys it is under.
/// Longer values go first, so one that holds another is replaced whole.
pub(crate) fn substitute(secrets: &mut Map<String, Value>, brokers: &[Broker], mut make: impl FnMut() -> String) -> Vec<StandIn> {
    let mut ordered: Vec<&Broker> = brokers.iter().filter(|b| b.value.chars().count() >= MIN_VALUE_CHARS).collect();
    ordered.sort_by_key(|b| std::cmp::Reverse(b.value.len()));
    let mut made: Vec<StandIn> = Vec::new();
    for broker in ordered {
        if made.iter().any(|m| m.broker.value == broker.value) {
            continue;
        }
        let mut stand_in: Option<String> = None;
        for value in secrets.values_mut() {
            let Value::String(text) = value else { continue };
            if text.contains(&broker.value) {
                let with = stand_in.get_or_insert_with(&mut make);
                *text = text.replace(&broker.value, with);
            }
        }
        if let Some(stand_in) = stand_in {
            made.push(StandIn { stand_in, broker: broker.clone() });
        }
    }
    made
}

/// What a job on a self-hosted runner whose harness cannot broker (a
/// Windows one, or one from before brokering) is told for each brokered
/// secret it was given.
pub(crate) fn self_hosted_note(name: &str) -> String {
    format!(
        "##[warning]{name} is a brokered secret: this job has a stand-in for it, which this runner cannot have filled in (that takes an up-to-date runner whose jobs run on Linux or macOS). Requests that use it will not be signed in."
    )
}

/// What a job on a self-hosted runner that brokers is told for each
/// brokered secret it was given.
pub(crate) fn brokered_note(name: &str, hosts: &[String]) -> String {
    format!(
        "{name} is a brokered secret: this job's requests to {} go through g1t, which fills it in, so its value never reaches this computer.",
        hosts.join(", ")
    )
}

/// What a brokering harness is given for its job's stand-ins: each one,
/// its secret's key (for the log) and its hosts. Never a value.
pub(crate) fn spec_entries(stand_ins: &[StandIn]) -> Value {
    Value::Array(
        stand_ins
            .iter()
            .map(|made| serde_json::json!({ "standIn": made.stand_in, "name": made.broker.name, "hosts": made.broker.hosts }))
            .collect(),
    )
}

/// A line of a job's log, stamped as the runner stamps its own.
pub(crate) fn stamped(text: &str) -> String {
    let at = rfc3339(now_ms());
    text.lines().map(|line| format!("{at} {line}\n")).collect()
}

#[derive(Deserialize)]
struct StandInRow {
    stand_in: String,
    name: String,
    value: String,
    hosts: String,
}

impl Actions {
    /// Keeps a job's stand-ins until its time is up, and marks the job so
    /// its log is masked for their values. Stand-ins whose time is up go.
    pub(crate) async fn keep_stand_ins(&self, job_id: &str, timeout_minutes: u32, stand_ins: &[StandIn]) -> Result<()> {
        let Some(sealer) = &self.sealer else { return Ok(()) };
        let now = now_ms();
        let expires = now + (u64::from(timeout_minutes) * 60 + 600) * 1000;
        let mut statements = vec![self.db.prepare(STAND_INS_EXPIRED).bind(&[(now as f64).into()])?];
        for made in stand_ins {
            statements.push(self.db.prepare(STAND_IN_INSERT).bind(&[
                made.stand_in.as_str().into(),
                job_id.into(),
                made.broker.name.as_str().into(),
                sealer.seal(&made.broker.value, &made.stand_in).into(),
                serde_json::to_string(&made.broker.hosts)?.into(),
                (expires as f64).into(),
            ])?);
        }
        statements.push(self.db.prepare("UPDATE jobs SET brokered = 1 WHERE id = ?").bind(&[job_id.into()])?);
        self.db.batch(statements).await?;
        Ok(())
    }

    /// A job's stand-ins that still work, opened.
    pub(crate) async fn stand_ins_of(&self, job_id: &str) -> Result<Vec<BrokeredSecret>> {
        let Some(sealer) = &self.sealer else { return Ok(Vec::new()) };
        let rows = self
            .db
            .prepare(STAND_INS_OF_JOB)
            .bind(&[job_id.into(), (now_ms() as f64).into()])?
            .all()
            .await?
            .results::<StandInRow>()?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                Some(BrokeredSecret {
                    value: sealer.open(&row.value, &row.stand_in)?,
                    hosts: serde_json::from_str(&row.hosts).unwrap_or_default(),
                    name: row.name,
                    stand_in: row.stand_in,
                })
            })
            .collect())
    }

    /// Whether a job in the repository could be given a brokered secret:
    /// its project or its workspace has one. Asked as a job starts, so the
    /// runner sends the job's HTTP through the Worker even when its network
    /// is open; a job that turns out to get none just goes the long way.
    pub(crate) async fn may_broker(&self, repo_id: &str, namespace: &str) -> Result<bool> {
        let Some(project) = self.project_of(repo_id).await? else { return Ok(false) };
        let found = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM settings WHERE kind = 'secret' AND brokered_hosts IS NOT NULL AND owner IN (?, ?)")
            .bind(&[project.id.as_str().into(), namespace.to_lowercase().into()])?
            .first::<Count>(None)
            .await?;
        Ok(found.is_some_and(|count| count.n > 0))
    }

    /// Adds g1t's own lines to a job's log, under `step` (0 for its setup).
    /// They count toward its log's size, though they are kept past it.
    pub(crate) async fn note_log(&self, job_id: &str, step: u32, text: &str) -> Result<()> {
        let text = stamped(text);
        self.db
            .batch(vec![
                self.db.prepare(LOG_COUNTED).bind(&[
                    job_id.into(),
                    (text.len() as u32).into(),
                    JsValue::NULL,
                    JsValue::NULL,
                ])?,
                self.db.prepare(LOG_INSERT).bind(&[
                    job_id.into(),
                    step.into(),
                    text.into(),
                    JsValue::NULL,
                ])?,
            ])
            .await?;
        Ok(())
    }

    /// `brokered_secrets`: a running job's stand-ins and what they stand
    /// for, for the runner Worker to fill in on the job's requests. Asked
    /// with the job's own token, which only the runner and the job hold;
    /// the API never passes this method on, so the job cannot ask it. The
    /// Worker holds the token the job started with, so that one still
    /// answers here after the job's harness swapped it for another
    /// (`job_spec` with `rotate`), and nowhere else.
    pub async fn brokered_secrets(&self, a: JobCallArgs) -> Result<Outcome<Vec<BrokeredSecret>>> {
        let job = check!(self.job_for_started_token(&a).await?);
        Ok(Outcome::Ok(self.stand_ins_of(&job.id).await?))
    }

    /// `relayed_secrets`: a running self-hosted job's stand-ins and what
    /// they stand for, for the runner Worker to fill in on a request the
    /// job's harness passed to g1t (`POST /actions/jobs/{job}/broker`).
    /// Only with the job's current token, which its harness holds: the one
    /// it started with may have been left on the runner's computer. A job
    /// on g1t's machines has its requests filled in as they leave its
    /// sandbox, and is refused here.
    pub async fn relayed_secrets(&self, a: JobCallArgs) -> Result<Outcome<Vec<BrokeredSecret>>> {
        let job = check!(self.job_for_token(&a).await?);
        if job.runner_id.is_none() {
            return Ok(fail(FailureCode::Forbidden, "Only a self-hosted runner's job relays its requests."));
        }
        Ok(Outcome::Ok(self.stand_ins_of(&job.id).await?))
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};
    use serde_json::{Map, Value, json};

    use super::{Broker, STAND_IN_INSERT, STAND_INS_EXPIRED, STAND_INS_OF_JOB, StandIn, brokered_note, self_hosted_note, spec_entries, stand_in, substitute};

    fn broker(name: &str, value: &str, hosts: &[&str]) -> Broker {
        Broker { name: name.into(), value: value.into(), hosts: hosts.iter().map(|h| (*h).to_owned()).collect() }
    }

    fn counter() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("g1tsec_{n}")
        }
    }

    #[test]
    fn stand_ins_are_long_random_tokens() {
        let one = stand_in();
        assert!(one.starts_with("g1tsec_"));
        assert_eq!(one.len(), "g1tsec_".len() + 48);
        assert!(one["g1tsec_".len()..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(one, stand_in());
    }

    #[test]
    fn a_brokered_value_never_reaches_the_job() {
        let mut secrets: Map<String, Value> = json!({
            "NPM_TOKEN": "npm_realvalue123",
            "ALSO_NPM": "npm_realvalue123",
            "BASIC": "me:npm_realvalue123",
            "PLAIN": "not-brokered-value",
        })
        .as_object()
        .cloned()
        .unwrap();
        let made = substitute(&mut secrets, &[broker("NPM_TOKEN", "npm_realvalue123", &["registry.npmjs.org"])], counter());
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].stand_in, "g1tsec_1");
        assert_eq!(made[0].broker.hosts, ["registry.npmjs.org"]);
        assert_eq!(secrets["NPM_TOKEN"], "g1tsec_1");
        assert_eq!(secrets["ALSO_NPM"], "g1tsec_1");
        assert_eq!(secrets["BASIC"], "me:g1tsec_1");
        assert_eq!(secrets["PLAIN"], "not-brokered-value");
        assert!(!serde_json::to_string(&secrets).unwrap().contains("npm_realvalue123"));
    }

    #[test]
    fn each_secret_gets_its_own_stand_in_and_longer_values_go_first() {
        let mut secrets: Map<String, Value> =
            json!({ "SHORT": "abcdefgh", "LONG": "abcdefgh-and-more" }).as_object().cloned().unwrap();
        let made = substitute(
            &mut secrets,
            &[broker("SHORT", "abcdefgh", &["a.example.com"]), broker("LONG", "abcdefgh-and-more", &["b.example.com"])],
            counter(),
        );
        assert_eq!(made.len(), 2);
        assert_eq!(made[0].broker.name, "LONG");
        assert_eq!(secrets["LONG"], "g1tsec_1");
        assert_eq!(secrets["SHORT"], "g1tsec_2");
    }

    #[test]
    fn values_too_short_or_not_given_make_no_stand_in() {
        let mut secrets: Map<String, Value> = json!({ "PIN": "1234" }).as_object().cloned().unwrap();
        assert!(substitute(&mut secrets, &[broker("PIN", "1234", &["x.example.com"])], counter()).is_empty());
        assert!(substitute(&mut secrets, &[broker("GONE", "absent-value", &["x.example.com"])], counter()).is_empty());
        assert_eq!(secrets["PIN"], "1234");
    }

    #[test]
    fn the_self_hosted_note_is_a_warning_naming_the_secret() {
        let note = self_hosted_note("NPM_TOKEN");
        assert!(note.starts_with("##[warning]NPM_TOKEN"));
        assert!(note.contains("cannot have filled in"));
    }

    #[test]
    fn a_brokering_harness_gets_hosts_and_stand_ins_but_never_a_value() {
        let made = vec![StandIn {
            stand_in: "g1tsec_1".into(),
            broker: broker("NPM_TOKEN", "npm_realvalue123", &["registry.npmjs.org", "*.npm.example.com"]),
        }];
        let entries = spec_entries(&made);
        assert_eq!(entries, json!([{ "standIn": "g1tsec_1", "name": "NPM_TOKEN", "hosts": ["registry.npmjs.org", "*.npm.example.com"] }]));
        assert!(!entries.to_string().contains("npm_realvalue123"));
        let note = brokered_note("NPM_TOKEN", &made[0].broker.hosts);
        assert!(!note.starts_with("##["), "not a warning: {note}");
        assert!(note.contains("registry.npmjs.org, *.npm.example.com") && note.contains("never reaches this computer"));
    }

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        for name in ["0001_init.sql", "0019_brokered_secrets.sql"] {
            let path = format!("{}/migrations/{name}", env!("CARGO_MANIFEST_DIR"));
            db.execute_batch(&std::fs::read_to_string(path).unwrap()).unwrap();
        }
        db
    }

    #[test]
    fn a_job_finds_only_its_own_stand_ins_while_they_work() {
        let db = database();
        let keep = |stand_in: &str, job: &str, expires: i64| {
            db.execute(STAND_IN_INSERT, params![stand_in, job, "NPM_TOKEN", "sealed", "[\"registry.npmjs.org\"]", expires]).unwrap()
        };
        keep("g1tsec_a", "job_1", 2_000);
        keep("g1tsec_b", "job_2", 2_000);
        keep("g1tsec_c", "job_1", 500);
        let of = |job: &str, now: i64| -> Vec<String> {
            let mut rows = db.prepare(STAND_INS_OF_JOB).unwrap();
            rows.query_map(params![job, now], |row| row.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(of("job_1", 1_000), ["g1tsec_a"]);
        assert_eq!(of("job_2", 1_000), ["g1tsec_b"]);
        assert!(of("job_1", 3_000).is_empty());
        assert_eq!(db.execute(STAND_INS_EXPIRED, params![1_000]).unwrap(), 1);
        // Settings rows and jobs carry the new columns.
        db.execute("UPDATE settings SET brokered_hosts = '[]'", []).unwrap();
        db.execute("UPDATE jobs SET brokered = 1", []).unwrap();
    }
}
