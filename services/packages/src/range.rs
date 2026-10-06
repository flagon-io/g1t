//! Byte ranges: the `Content-Range` a chunk of an upload names, the
//! `Range` an upload's replies say it holds, and the `Range` a download
//! asks for.

/// The bytes a chunk says it holds, `start` to `end` inclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkRange {
    pub start: u64,
    pub end: u64,
}

/// A chunk's `Content-Range`: `<start>-<end>`, as the Distribution spec
/// writes it, or the HTTP form `bytes <start>-<end>/<total or *>`.
pub fn parse_content_range(header: &str) -> Option<ChunkRange> {
    let text = header.trim();
    let text = text.strip_prefix("bytes ").unwrap_or(text).trim();
    let text = text.split_once('/').map_or(text, |(range, _)| range);
    let (start, end) = text.split_once('-')?;
    let (start, end) = (start.trim().parse().ok()?, end.trim().parse().ok()?);
    (start <= end).then_some(ChunkRange { start, end })
}

/// What an upload's replies say it holds so far: `0-<last byte>`, and
/// `0-0` before the first byte, as clients expect.
pub fn upload_range(offset: u64) -> String {
    format!("0-{}", offset.saturating_sub(1))
}

/// A part of a blob a download asks for, resolved against its size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Wanted {
    pub offset: u64,
    pub length: u64,
}

impl Wanted {
    /// `bytes <first>-<last>/<size>`.
    pub fn content_range(&self, size: u64) -> String {
        format!("bytes {}-{}/{size}", self.offset, self.offset + self.length - 1)
    }
}

/// What a download's `Range` header asks for, against a blob of `size`
/// bytes. `Ok(None)`: the whole blob (no header, or one this does not
/// read, such as several ranges). `Err(())`: nothing of the blob is in it,
/// which is answered 416.
pub fn parse_range(header: Option<&str>, size: u64) -> Result<Option<Wanted>, ()> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Ok(None);
    };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return Ok(None);
    };
    let (first, last) = (first.trim(), last.trim());
    let wanted = if first.is_empty() {
        let Ok(suffix) = last.parse::<u64>() else { return Ok(None) };
        if suffix == 0 || size == 0 {
            return Err(());
        }
        let length = suffix.min(size);
        Wanted { offset: size - length, length }
    } else {
        let Ok(offset) = first.parse::<u64>() else { return Ok(None) };
        if offset >= size {
            return Err(());
        }
        let end = if last.is_empty() {
            size - 1
        } else {
            match last.parse::<u64>() {
                Ok(end) if end >= offset => end.min(size - 1),
                _ => return Ok(None),
            }
        };
        Wanted { offset, length: end - offset + 1 }
    };
    Ok(Some(wanted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chunk_names_its_range_either_way() {
        assert_eq!(parse_content_range("0-1023"), Some(ChunkRange { start: 0, end: 1023 }));
        assert_eq!(parse_content_range("bytes 1024-2047/*"), Some(ChunkRange { start: 1024, end: 2047 }));
        assert_eq!(parse_content_range(" 5-5 "), Some(ChunkRange { start: 5, end: 5 }));
        assert_eq!(parse_content_range("9-3"), None);
        assert_eq!(parse_content_range("x-3"), None);
        assert_eq!(parse_content_range(""), None);
    }

    #[test]
    fn an_upload_says_what_it_holds() {
        assert_eq!(upload_range(0), "0-0");
        assert_eq!(upload_range(1), "0-0");
        assert_eq!(upload_range(1024), "0-1023");
    }

    #[test]
    fn a_download_range_is_resolved_against_the_size() {
        let w = |offset, length| Ok(Some(Wanted { offset, length }));
        assert_eq!(parse_range(None, 100), Ok(None));
        assert_eq!(parse_range(Some("bytes=0-9"), 100), w(0, 10));
        assert_eq!(parse_range(Some("bytes=90-"), 100), w(90, 10));
        assert_eq!(parse_range(Some("bytes=90-500"), 100), w(90, 10));
        assert_eq!(parse_range(Some("bytes=-10"), 100), w(90, 10));
        assert_eq!(parse_range(Some("bytes=-500"), 100), w(0, 100));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(parse_range(Some("bytes=-0"), 100), Err(()));
        assert_eq!(parse_range(Some("bytes=0-1,5-9"), 100), Ok(None));
        assert_eq!(parse_range(Some("items=0-1"), 100), Ok(None));
        assert_eq!(parse_range(Some("bytes=9-3"), 100), Ok(None));
        assert_eq!(Wanted { offset: 90, length: 10 }.content_range(100), "bytes 90-99/100");
    }
}
