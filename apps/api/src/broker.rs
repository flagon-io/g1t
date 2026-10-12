//! `POST /actions/jobs/{job}/broker`: a request a self-hosted runner's job
//! made to one of its brokered secrets' hosts, which the job's harness
//! passes to g1t so the secret's value never reaches the runner's
//! computer (services/actions broker.rs, crates/runner actions/broker.rs).
//!
//! The job's current token comes in `Authorization: Bearer`, never in the
//! URL, and the request to make in `x-g1t-broker-request` (base64 of
//! `{ method, url, headers }`), with its body as this request's. The
//! runner Worker does the rest (services/runner broker-relay.ts): it
//! fills in the stand-ins, sends the request without following redirects,
//! and answers with what came back, scrubbed of the values, its status and
//! headers in `x-g1t-broker-response`. Bodies stream through here as they
//! are; the Worker holds the limits.

use worker::wasm_bindgen::JsValue;
use worker::{Method, Request, RequestInit, Response, Result};

use crate::operations::Services;

/// The headers passed on to the runner Worker; nothing else of the
/// request is. Its body's length the Worker counts as it reads.
const PASSED: &[&str] = &["authorization", "x-g1t-broker-request"];

/// The job a broker request is for, from its path, or None when the path
/// is not one.
pub fn job_of(path: &str) -> Option<&str> {
    let job = path.strip_prefix("/actions/jobs/")?.strip_suffix("/broker")?;
    (!job.is_empty() && !job.contains('/')).then_some(job)
}

/// Passes a broker request to the runner Worker, and its answer back.
pub async fn relay(request: Request, services: &Services, job: &str) -> Result<Response> {
    let headers = worker::Headers::new();
    headers.set("x-g1t-broker-job", job)?;
    for name in PASSED {
        if let Some(value) = request.headers().get(name)? {
            headers.set(name, &value)?;
        }
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers).with_body(request.inner().body().map(JsValue::from));
    services.runner.fetch_request(Request::new_with_init("https://runner/rpc/broker", &init)?).await
}

#[cfg(test)]
mod tests {
    use super::job_of;

    #[test]
    fn only_a_job_s_own_broker_path_is_one() {
        assert_eq!(job_of("/actions/jobs/job_1/broker"), Some("job_1"));
        assert_eq!(job_of("/actions/jobs//broker"), None);
        assert_eq!(job_of("/actions/jobs/job_1/spec"), None);
        assert_eq!(job_of("/actions/jobs/a/b/broker"), None);
        assert_eq!(job_of("/repos/a/b/actions/jobs/job_1/broker"), None);
    }
}
