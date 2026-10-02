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

/// Helpers for bindings that workers-rs has no typed wrapper for, such as
/// Artifacts and Email Sending. Values cross the boundary as JSON.
pub mod js {
    use serde::Serialize;
    use serde::de::DeserializeOwned;
    use worker::js_sys::{Function, JSON, Promise, Reflect};
    use worker::wasm_bindgen::{JsCast, JsValue};
    use worker::wasm_bindgen_futures::JsFuture;
    use worker::{Env, Error, Result};

    fn error(context: &str, value: JsValue) -> Error {
        let message = JSON::stringify(&value)
            .ok()
            .and_then(|text| text.as_string())
            .filter(|text| text != "{}")
            .or_else(|| {
                Reflect::get(&value, &"message".into())
                    .ok()
                    .and_then(|message| message.as_string())
            })
            .unwrap_or_else(|| format!("{value:?}"));
        Error::RustError(format!("{context}: {message}"))
    }

    /// The binding called `name`, as a raw JavaScript value.
    pub fn binding(env: &Env, name: &str) -> Result<JsValue> {
        let value = Reflect::get(env.as_ref(), &name.into()).map_err(|e| error(name, e))?;
        if value.is_undefined() {
            return Err(Error::RustError(format!(
                "binding {name} is not configured"
            )));
        }
        Ok(value)
    }

    pub fn to_js<T: Serialize>(value: &T) -> Result<JsValue> {
        JSON::parse(&serde_json::to_string(value)?).map_err(|e| error("to_js", e))
    }

    pub fn from_js<T: DeserializeOwned>(value: &JsValue) -> Result<T> {
        if value.is_undefined() {
            return Ok(serde_json::from_value(serde_json::Value::Null)?);
        }
        let text = JSON::stringify(value)
            .map_err(|e| error("from_js", e))?
            .as_string()
            .unwrap_or_else(|| "null".to_owned());
        Ok(serde_json::from_str(&text)?)
    }

    /// Calls `target.method(...args)` and awaits the result if it is a
    /// promise.
    pub async fn call(target: &JsValue, method: &str, args: &[JsValue]) -> Result<JsValue> {
        let function: Function = Reflect::get(target, &method.into())
            .map_err(|e| error(method, e))?
            .dyn_into()
            .map_err(|_| Error::RustError(format!("{method} is not a function")))?;
        let arguments = worker::js_sys::Array::new();
        for arg in args {
            arguments.push(arg);
        }
        let returned = function
            .apply(target, &arguments)
            .map_err(|e| error(method, e))?;
        match returned.dyn_into::<Promise>() {
            Ok(promise) => JsFuture::from(promise).await.map_err(|e| error(method, e)),
            Err(value) => Ok(value),
        }
    }
}
