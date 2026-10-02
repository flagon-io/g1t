//! Plumbing shared by g1t services that run on Workers.
//!
//! Services talk to each other over service bindings with a small JSON
//! protocol: `POST /rpc/<method>` with the method's arguments as the body,
//! answered with the method's return value.

use serde::Serialize;
use serde::de::DeserializeOwned;
use worker::{Date, Fetcher, Headers, Method, Request, RequestInit, Response, Result};

/// The current time in milliseconds since the epoch.
pub fn now_ms() -> u64 {
    Date::now().as_millis()
}

/// The method name of an RPC request, or `None` if it is not one.
pub fn rpc_method(request: &Request) -> Option<String> {
    if request.method() != Method::Post {
        return None;
    }
    request
        .path()
        .strip_prefix("/rpc/")
        .map(|method| method.to_owned())
}

/// Deserializes a method's arguments.
pub fn args<A: DeserializeOwned>(body: serde_json::Value) -> Result<A> {
    serde_json::from_value(body)
        .map_err(|error| worker::Error::RustError(format!("bad arguments: {error}")))
}

/// Serializes a method's return value as the response body.
pub fn reply<R: Serialize>(value: &R) -> Result<Response> {
    Response::from_json(value)
}

/// Calls `method` on another service through its binding.
pub async fn call<A: Serialize, R: DeserializeOwned>(
    service: &Fetcher,
    method: &str,
    arguments: &A,
) -> Result<R> {
    let headers = Headers::new();
    headers.set("content-type", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(serde_json::to_string(arguments)?.into()));
    // The hostname is ignored; a service binding always reaches its service.
    let request = Request::new_with_init(&format!("https://service/rpc/{method}"), &init)?;
    let mut response = service.fetch_request(request).await?;
    if response.status_code() != 200 {
        return Err(worker::Error::RustError(format!(
            "{method} failed with status {}: {}",
            response.status_code(),
            response.text().await.unwrap_or_default()
        )));
    }
    response.json().await
}
