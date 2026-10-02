use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    NotFound,
    Forbidden,
    Unauthenticated,
    Conflict,
    Invalid,
}

impl FailureCode {
    pub fn http_status(self) -> u16 {
        match self {
            FailureCode::NotFound => 404,
            FailureCode::Forbidden => 403,
            FailureCode::Unauthenticated => 401,
            FailureCode::Conflict => 409,
            FailureCode::Invalid => 422,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Failure {
    pub code: FailureCode,
    pub message: String,
}

/// The result of a service call. Expected failures cross service boundaries
/// as values, so callers have to handle them.
///
/// On the wire: `{"ok": true, "value": …}` or `{"ok": false, "error": …}`.
#[derive(Clone, Debug)]
pub enum Outcome<T> {
    Ok(T),
    Fail(Failure),
}

impl<T> Outcome<T> {
    pub fn fail(code: FailureCode, message: impl Into<String>) -> Self {
        Outcome::Fail(Failure {
            code,
            message: message.into(),
        })
    }

    pub fn into_result(self) -> Result<T, Failure> {
        match self {
            Outcome::Ok(value) => Ok(value),
            Outcome::Fail(failure) => Err(failure),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(bound(serialize = "T: Serialize", deserialize = "T: DeserializeOwned"))]
struct Wire<T> {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<T>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<Failure>,
}

impl<T: Serialize> Serialize for Outcome<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Outcome::Ok(value) => Wire {
                ok: true,
                value: Some(value),
                error: None,
            },
            Outcome::Fail(failure) => Wire {
                ok: false,
                value: None,
                error: Some(failure.clone()),
            },
        }
        .serialize(serializer)
    }
}

impl<'de, T: DeserializeOwned> Deserialize<'de> for Outcome<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = Wire::<T>::deserialize(deserializer)?;
        match (wire.ok, wire.value, wire.error) {
            (true, Some(value), _) => Ok(Outcome::Ok(value)),
            (false, _, Some(error)) => Ok(Outcome::Fail(error)),
            _ => Err(serde::de::Error::custom("malformed outcome")),
        }
    }
}
