use serde::de::DeserializeOwned;
use serde::de::value::UnitDeserializer;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    NotFound,
    Forbidden,
    Unauthenticated,
    Conflict,
    Invalid,
    /// The workspace has to pay before this can happen.
    PaymentRequired,
    // Billing's refusals to start compute (`reserve`), each with a message
    // that says what to do. See `g1t_contracts::billing::ReserveArgs`.
    /// No plan, and no trial or pool that pays for this kind of work: a
    /// card check or the g1t plan is needed.
    NotPaid,
    /// The workspace's one trial is spent.
    TrialUsed,
    /// The workspace reached its spend limit or g1t's ceiling.
    Limit,
    /// Compute is paused: a spend spike waiting for an owner, or a hold.
    Paused,
    /// This month's open-source pool, or the repository's share, is spent.
    OssPoolEmpty,
    /// A sensitive change needs the person to prove it is them again: a
    /// recent sign-in, or their password. See `identity::Reauth`.
    ReauthRequired,
}

impl FailureCode {
    pub fn http_status(self) -> u16 {
        match self {
            FailureCode::NotFound => 404,
            FailureCode::Forbidden => 403,
            FailureCode::Unauthenticated => 401,
            FailureCode::Conflict => 409,
            FailureCode::Invalid => 422,
            FailureCode::PaymentRequired
            | FailureCode::NotPaid
            | FailureCode::TrialUsed
            | FailureCode::Limit
            | FailureCode::OssPoolEmpty => 402,
            FailureCode::Paused => 409,
            FailureCode::ReauthRequired => 403,
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
            // `"value": null`, or no value: what `Ok(None)` and `Ok(())` are
            // written as. `Option<Option<T>>` reads a null as the outer
            // `None`, so the value is read from nothing instead: `None` for
            // an `Option`, `()` for a unit, and still malformed for a type
            // that needs a value.
            (true, None, _) => T::deserialize(UnitDeserializer::<D::Error>::new())
                .map(Outcome::Ok)
                .map_err(|_| serde::de::Error::custom("malformed outcome: ok without a value")),
            _ => Err(serde::de::Error::custom("malformed outcome")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip<T: Serialize + DeserializeOwned>(outcome: &Outcome<T>) -> Result<Outcome<T>, String> {
        // As a service replies (`g1t_kit::reply`) and its caller reads it
        // (`g1t_kit::call`).
        let wire = serde_json::to_string(outcome).map_err(|e| e.to_string())?;
        serde_json::from_str(&wire).map_err(|e| e.to_string())
    }

    /// A cache miss is `Ok(None)`, written `{"ok":true,"value":null}`. It
    /// was read back as malformed, so every miss of the toolkit's cache
    /// (sccache's first lookup, `sccache/.sccache_check`) was a 500.
    #[test]
    fn ok_none_and_ok_unit_cross_the_wire() {
        assert_eq!(serde_json::to_string(&Outcome::<Option<u8>>::Ok(None)).unwrap(), r#"{"ok":true,"value":null}"#);
        assert!(matches!(round_trip(&Outcome::<Option<u8>>::Ok(None)), Ok(Outcome::Ok(None))));
        assert!(matches!(round_trip(&Outcome::Ok(Some(7u8))), Ok(Outcome::Ok(Some(7)))));
        assert!(matches!(round_trip(&Outcome::Ok(())), Ok(Outcome::Ok(()))));
        assert!(matches!(serde_json::from_str::<Outcome<Option<u8>>>(r#"{"ok":true}"#), Ok(Outcome::Ok(None))));
        let failed = round_trip(&Outcome::<Option<u8>>::fail(FailureCode::Unauthenticated, "no"));
        assert!(matches!(failed, Ok(Outcome::Fail(Failure { code: FailureCode::Unauthenticated, .. }))));
    }

    #[test]
    fn an_ok_without_the_value_it_needs_is_still_malformed() {
        assert!(serde_json::from_str::<Outcome<u8>>(r#"{"ok":true,"value":null}"#).is_err());
        assert!(serde_json::from_str::<Outcome<String>>(r#"{"ok":true}"#).is_err());
        assert!(serde_json::from_str::<Outcome<u8>>(r#"{"ok":false}"#).is_err());
    }
}
