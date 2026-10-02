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
    use std::fmt;

    use serde::Serialize;
    use serde::de::DeserializeOwned;
    use worker::js_sys::{Array, Function, JSON, Promise, Reflect};
    use worker::wasm_bindgen::{JsCast, JsValue};
    use worker::wasm_bindgen_futures::JsFuture;
    use worker::{Env, Error, Result};

    /// An exception thrown by JavaScript, with its `code` if it had one.
    #[derive(Debug)]
    pub struct Thrown {
        pub code: Option<String>,
        pub message: String,
    }

    impl Thrown {
        fn from_value(value: JsValue) -> Self {
            let property = |name: &str| {
                Reflect::get(&value, &name.into())
                    .ok()
                    .and_then(|property| property.as_string())
            };
            Thrown {
                code: property("code"),
                message: property("message").unwrap_or_else(|| format!("{value:?}")),
            }
        }

        pub fn is(&self, code: &str) -> bool {
            self.code.as_deref() == Some(code)
        }
    }

    impl fmt::Display for Thrown {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match &self.code {
                Some(code) => write!(f, "{code}: {}", self.message),
                None => f.write_str(&self.message),
            }
        }
    }

    impl From<Thrown> for Error {
        fn from(thrown: Thrown) -> Self {
            Error::RustError(thrown.to_string())
        }
    }

    /// The binding called `name`, as a raw JavaScript value.
    pub fn binding(env: &Env, name: &str) -> Result<JsValue> {
        let value = Reflect::get(env.as_ref(), &name.into()).map_err(Thrown::from_value)?;
        if value.is_undefined() {
            return Err(Error::RustError(format!(
                "binding {name} is not configured"
            )));
        }
        Ok(value)
    }

    /// Reads a property of a JavaScript object.
    pub fn get(target: &JsValue, name: &str) -> JsValue {
        Reflect::get(target, &name.into()).unwrap_or(JsValue::UNDEFINED)
    }

    /// Sets a property on an object.
    pub fn set(target: &JsValue, name: &str, value: &JsValue) {
        let _ = Reflect::set(target, &name.into(), value);
    }

    pub fn to_js<T: Serialize>(value: &T) -> Result<JsValue> {
        Ok(JSON::parse(&serde_json::to_string(value)?).map_err(Thrown::from_value)?)
    }

    pub fn from_js<T: DeserializeOwned>(value: &JsValue) -> Result<T> {
        let text = if value.is_undefined() {
            None
        } else {
            JSON::stringify(value)
                .map_err(Thrown::from_value)?
                .as_string()
        };
        let text = text.as_deref().unwrap_or("null");
        serde_json::from_str(text).map_err(|error| {
            // Say what arrived; a bare serde error is useless in a log.
            let seen: String = text.chars().take(300).collect();
            Error::RustError(format!(
                "unexpected value from JavaScript ({error}): {seen}"
            ))
        })
    }

    /// Calls `target[method](...args)` and awaits the result if it is a
    /// thenable. `method` may be a name or a symbol.
    pub async fn call_key(
        target: &JsValue,
        method: &JsValue,
        args: &[JsValue],
    ) -> std::result::Result<JsValue, Thrown> {
        let function: Function = Reflect::get(target, method)
            .map_err(Thrown::from_value)?
            .dyn_into()
            .map_err(|_| Thrown {
                code: None,
                message: format!("{method:?} is not a function"),
            })?;
        let arguments: Array = args.iter().collect();
        // An RPC stub treats every property access as a remote method, so
        // `function.apply(...)` would be sent over the wire as a call to
        // "apply". Reflect.apply invokes the function without touching it.
        let returned = Reflect::apply(&function, target, &arguments).map_err(Thrown::from_value)?;
        // Worker RPC returns its own thenable rather than a Promise, so
        // resolve whatever came back instead of testing its type.
        JsFuture::from(Promise::resolve(&returned))
            .await
            .map_err(Thrown::from_value)
    }

    /// Calls `target.method(...args)`; see [`call_key`].
    pub async fn call(
        target: &JsValue,
        method: &str,
        args: &[JsValue],
    ) -> std::result::Result<JsValue, Thrown> {
        call_key(target, &method.into(), args).await
    }
}
