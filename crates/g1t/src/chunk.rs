//! Sizes, chunk plans and the range headers of a chunked upload.

pub const MIB: u64 = 1024 * 1024;
/// What a chunk is unless `--chunk-size` says otherwise.
pub const DEFAULT_CHUNK: u64 = 90 * MIB;
/// The largest chunk: well under the 100 MB a request to g1t.sh may carry.
pub const MAX_CHUNK: u64 = 95 * MIB;
/// The smallest: every chunk but the last becomes a part in storage.
pub const MIN_CHUNK: u64 = 5 * MIB;

/// Reads a size like `90MB`, `90MiB`, `90M`, `512K` or `94371840`. K, M and
/// G count in 1,024s, with or without a trailing `B` or `iB`.
pub fn parse_size(text: &str) -> Result<u64, String> {
    let text = text.trim();
    let split = text
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let number: f64 = number
        .parse()
        .map_err(|_| format!("`{text}` is not a size, like 90MB"))?;
    let unit = unit.trim().to_ascii_lowercase();
    let unit = unit
        .strip_suffix("ib")
        .or_else(|| unit.strip_suffix('b'))
        .unwrap_or(&unit);
    let scale = match unit {
        "" => 1,
        "k" => 1024,
        "m" => MIB,
        "g" => 1024 * MIB,
        _ => return Err(format!("`{text}` is not a size, like 90MB")),
    };
    Ok((number * scale as f64) as u64)
}

/// Checks a chunk size against the limits.
pub fn check_chunk(size: u64) -> Result<u64, String> {
    if size > MAX_CHUNK {
        return Err(format!(
            "A chunk may be at most 95MiB ({MAX_CHUNK} bytes), to stay under the 100 MB a request may carry."
        ));
    }
    if size < MIN_CHUNK {
        return Err(format!(
            "A chunk must be at least 5MiB ({MIN_CHUNK} bytes)."
        ));
    }
    Ok(size)
}

/// The chunks that send bytes `from..total`: `(start, length)` each.
pub fn plan(total: u64, chunk: u64, from: u64) -> Vec<(u64, u64)> {
    let mut chunks = Vec::new();
    let mut start = from;
    while start < total {
        let length = chunk.min(total - start);
        chunks.push((start, length));
        start += length;
    }
    chunks
}

/// How many chunks a blob of `total` bytes takes.
pub fn count(total: u64, chunk: u64) -> u64 {
    total.div_ceil(chunk).max(1)
}

/// A PATCH's `Content-Range`: `<first byte>-<last byte>`.
pub fn content_range(start: u64, length: u64) -> String {
    format!("{start}-{}", start + length.max(1) - 1)
}

/// The offset an upload's `Range` header (`0-<last byte>`) says comes next.
/// `0-0` reads as nothing received yet: registries say it before the first
/// byte, and a one-byte upload that was in fact received is caught by the
/// registry refusing the resent byte.
pub fn next_offset(range: &str) -> Option<u64> {
    let text = range.trim();
    let text = text
        .strip_prefix("bytes=")
        .or_else(|| text.strip_prefix("bytes "))
        .unwrap_or(text);
    let (start, end) = text.split_once('-')?;
    let (start, end): (u64, u64) = (start.trim().parse().ok()?, end.trim().parse().ok()?);
    if start != 0 {
        return None;
    }
    Some(if end == 0 { 0 } else { end + 1 })
}

/// A size for people: `612 B`, `3.5 MiB`.
pub fn human(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KiB", "MiB", "GiB", "TiB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_read_in_1024s_with_any_suffix() {
        assert_eq!(parse_size("90MB"), Ok(90 * MIB));
        assert_eq!(parse_size("90MiB"), Ok(90 * MIB));
        assert_eq!(parse_size("90m"), Ok(90 * MIB));
        assert_eq!(parse_size("512K"), Ok(512 * 1024));
        assert_eq!(parse_size("94371840"), Ok(94_371_840));
        assert_eq!(parse_size("1.5G"), Ok(1536 * MIB));
        assert!(parse_size("ninety").is_err());
        assert!(parse_size("90XB").is_err());
    }

    #[test]
    fn chunks_stay_between_5_and_95_mib() {
        assert_eq!(check_chunk(95 * MIB), Ok(95 * MIB));
        assert!(check_chunk(95 * MIB + 1).is_err());
        assert!(check_chunk(100_000_000).is_err());
        assert!(check_chunk(MIN_CHUNK - 1).is_err());
    }

    #[test]
    fn a_plan_covers_every_byte_once() {
        let total = 150_000_000 + 4_096;
        let chunks = plan(total, DEFAULT_CHUNK, 0);
        assert_eq!(
            chunks,
            vec![(0, DEFAULT_CHUNK), (DEFAULT_CHUNK, total - DEFAULT_CHUNK)]
        );
        assert_eq!(chunks.iter().map(|c| c.1).sum::<u64>(), total);
        assert_eq!(count(total, DEFAULT_CHUNK), 2);
    }

    #[test]
    fn a_plan_on_an_exact_multiple_has_no_empty_tail() {
        let chunks = plan(3 * MIB * 10, 10 * MIB, 0);
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|c| c.1 == 10 * MIB));
    }

    #[test]
    fn a_plan_resumes_from_an_offset() {
        let chunks = plan(25 * MIB, 10 * MIB, 10 * MIB);
        assert_eq!(chunks, vec![(10 * MIB, 10 * MIB), (20 * MIB, 5 * MIB)]);
        assert!(plan(25 * MIB, 10 * MIB, 25 * MIB).is_empty());
    }

    #[test]
    fn small_and_empty_blobs_are_one_chunk_or_none() {
        assert_eq!(plan(612, DEFAULT_CHUNK, 0), vec![(0, 612)]);
        assert!(plan(0, DEFAULT_CHUNK, 0).is_empty());
        assert_eq!(count(0, DEFAULT_CHUNK), 1);
    }

    #[test]
    fn content_ranges_name_the_first_and_last_byte() {
        assert_eq!(content_range(0, 1024), "0-1023");
        assert_eq!(
            content_range(DEFAULT_CHUNK, 10),
            format!("{}-{}", DEFAULT_CHUNK, DEFAULT_CHUNK + 9)
        );
    }

    #[test]
    fn upload_ranges_give_the_next_offset() {
        assert_eq!(next_offset("0-0"), Some(0));
        assert_eq!(next_offset("0-94371839"), Some(94_371_840));
        assert_eq!(next_offset("bytes=0-1023"), Some(1024));
        assert_eq!(next_offset("5-10"), None);
        assert_eq!(next_offset("junk"), None);
    }

    #[test]
    fn sizes_print_for_people() {
        assert_eq!(human(612), "612 B");
        assert_eq!(human(150_000_000), "143.1 MiB");
    }
}
