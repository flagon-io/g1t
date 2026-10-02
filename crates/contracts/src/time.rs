//! Timestamps. Everywhere in g1t, in storage and on the wire, a time is an
//! RFC 3339 string in UTC with millisecond precision, such as
//! `2026-10-02T05:16:19.000Z`. Strings in this one fixed format sort and
//! compare as text, so they need no parsing to be ordered.

/// SQLite's expression for the current time in g1t's format.
pub const SQL_NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/// SQLite's expression for a time `seconds` from now, in g1t's format.
pub fn sql_after(seconds: u64) -> String {
    format!("strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+{seconds} seconds')")
}

/// Milliseconds since the Unix epoch as an RFC 3339 UTC timestamp.
pub fn rfc3339(ms: u64) -> String {
    let (seconds, millis) = (ms / 1000, ms % 1000);
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let (hour, minute, second) = (rest / 3600, rest % 3600 / 60, rest % 60);

    // Days since the epoch to a calendar date, after Howard Hinnant's
    // civil_from_days. The era arithmetic starts years in March.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(rfc3339(1_790_918_179_123), "2026-10-02T05:16:19.123Z");
        assert_eq!(rfc3339(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
    }

    #[test]
    fn later_times_sort_later_as_text() {
        let times: Vec<String> = [0, 999, 1000, 86_399_999, 86_400_000, 1_790_918_179_123]
            .into_iter()
            .map(rfc3339)
            .collect();
        assert!(times.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
