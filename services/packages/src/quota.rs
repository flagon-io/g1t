//! How much a free workspace's packages may hold.
//!
//! Billing says, per workspace, whether it is on the plan and how much
//! public and private package storage is free (`entitlements`). On the plan
//! nothing is refused: storage past the free amounts is charged. Without
//! it, a push that would take the workspace's public or private packages
//! past their free amount is refused before anything is kept. What a
//! workspace holds is `workspace_blobs`: each file once, so a layer it
//! already has adds nothing.

use serde::Deserialize;

/// What billing allows a workspace, as far as packages go.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Allowance {
    #[serde(default)]
    pub has_plan: bool,
    #[serde(default)]
    pub package_public_free_bytes: i64,
    #[serde(default)]
    pub package_private_free_bytes: i64,
}

/// A push refused for storage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub public: bool,
    pub limit: u64,
    pub used: u64,
    pub adding: u64,
}

/// Whether `adding` more bytes may go into the workspace's public (or
/// private) packages, which hold `used` now. A free amount of 0 is billing
/// not saying (an older billing), and refuses nothing.
pub fn decide(allowance: &Allowance, public: bool, used: u64, adding: u64) -> Result<(), Refusal> {
    if allowance.has_plan || adding == 0 {
        return Ok(());
    }
    let free = if public { allowance.package_public_free_bytes } else { allowance.package_private_free_bytes };
    if free <= 0 {
        return Ok(());
    }
    let limit = free as u64;
    if used.saturating_add(adding) > limit {
        return Err(Refusal { public, limit, used, adding });
    }
    Ok(())
}

/// Bytes for people: `512 KB`, `480.3 MB`, `10 GB`.
pub fn bytes(n: u64) -> String {
    const UNITS: [(&str, u64); 3] = [("GB", 1_000_000_000), ("MB", 1_000_000), ("KB", 1_000)];
    for (unit, size) in UNITS {
        if n >= size {
            let value = n as f64 / size as f64;
            return if (value - value.round()).abs() < 0.05 {
                format!("{} {unit}", value.round() as u64)
            } else {
                format!("{value:.1} {unit}")
            };
        }
    }
    format!("{n} bytes")
}

/// What the refusal says: the limit, what is used, and what lifts it.
pub fn message(workspace: &str, refusal: &Refusal) -> String {
    let kind = if refusal.public { "public" } else { "private" };
    format!(
        "{workspace}'s {kind} packages may hold {} without the g1t plan; they hold {} and this push adds {}. \
         The g1t plan lifts the limit: https://g1t.sh/{workspace}/-/billing",
        bytes(refusal.limit),
        bytes(refusal.used),
        bytes(refusal.adding)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const FREE: Allowance = Allowance {
        has_plan: false,
        package_public_free_bytes: 10_000_000_000,
        package_private_free_bytes: 500_000_000,
    };

    #[test]
    fn a_free_workspace_is_refused_past_each_free_amount() {
        assert_eq!(decide(&FREE, false, 400_000_000, 100_000_000), Ok(()), "exactly at the limit is allowed");
        let refused = decide(&FREE, false, 400_000_000, 100_000_001).unwrap_err();
        assert_eq!(refused, Refusal { public: false, limit: 500_000_000, used: 400_000_000, adding: 100_000_001 });
        assert_eq!(decide(&FREE, true, 400_000_000, 100_000_001), Ok(()), "public has its own amount");
        assert!(decide(&FREE, true, 9_999_000_000, 2_000_000).is_err());
    }

    #[test]
    fn the_plan_and_what_adds_nothing_are_never_refused() {
        let plan = Allowance { has_plan: true, ..FREE };
        assert_eq!(decide(&plan, false, u64::MAX / 2, u64::MAX / 4), Ok(()));
        assert_eq!(decide(&FREE, false, 900_000_000, 0), Ok(()), "a layer already held adds nothing");
        assert_eq!(decide(&Allowance::default(), false, 900_000_000, 1), Ok(()), "billing not saying refuses nothing");
    }

    #[test]
    fn the_refusal_names_the_limit_the_use_and_the_way_out() {
        let refusal = Refusal { public: false, limit: 500_000_000, used: 480_300_000, adding: 30_000_000 };
        assert_eq!(
            message("acme", &refusal),
            "acme's private packages may hold 500 MB without the g1t plan; they hold 480.3 MB and this push adds 30 MB. \
             The g1t plan lifts the limit: https://g1t.sh/acme/-/billing"
        );
        assert_eq!(bytes(999), "999 bytes");
        assert_eq!(bytes(1_500), "1.5 KB");
        assert_eq!(bytes(10_000_000_000), "10 GB");
    }

    #[test]
    fn billings_answer_is_read_for_the_three_fields_only() {
        let read: Allowance = serde_json::from_value(serde_json::json!({
            "workspace": "acme", "plan": "free", "hasPlan": false,
            "packagePublicFreeBytes": 10, "packagePrivateFreeBytes": 5,
        }))
        .unwrap();
        assert_eq!(read, Allowance { has_plan: false, package_public_free_bytes: 10, package_private_free_bytes: 5 });
        let older: Allowance = serde_json::from_value(serde_json::json!({ "workspace": "acme" })).unwrap();
        assert_eq!(older, Allowance::default());
    }
}
