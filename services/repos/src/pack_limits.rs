//! What the git store will not hold, checked before it is asked to: no
//! file over 32 MB, and no repository over about 1 GB. A
//! push that would cross either is declined with a reason git prints,
//! instead of failing inside the store.
//!
//! [`PackSizer`] walks a receive-pack body as it arrives, a chunk at a
//! time, without keeping it: the commands, then each object of the pack,
//! inflated into a small window and thrown away, only to learn its size
//! and where the next one starts. A delta's size is the size of the object
//! it makes, read from the start of the delta. Memory stays at a few tens
//! of kilobytes however large the push.
//!
//! [`Sideband`] does the same for the other direction: it takes an
//! upload-pack answer that used side-band framing a chunk at a time and
//! gives back the pack's bytes, so a pack can go from one repository to
//! another without being held whole (land.rs).

use miniz_oxide::inflate::TINFLStatus;
use miniz_oxide::inflate::core::{DecompressorOxide, decompress, inflate_flags};

/// The largest file or blob the git store holds. Cloudflare documents
/// "32 MB"; decimal megabytes are assumed, so nothing it would refuse gets
/// through.
pub const MAX_OBJECT_BYTES: u64 = 32_000_000;
/// The largest repository the git store holds is 1 GB. Pushes stop a little
/// before it: what g1t counts (`stored_bytes`) is a lower bound.
pub const DEFAULT_REPO_LIMIT_BYTES: u64 = 950_000_000;
/// The largest request body Cloudflare passes on for g1t.sh's plan. A
/// larger push is refused by the network with HTTP 413 before g1t sees it.
pub const PLATFORM_BODY_LIMIT_BYTES: u64 = 100_000_000;

/// Inflate's window must be a power of two of at least 32 KiB.
const WINDOW: usize = 32 * 1024;
/// A delta starts with two sizes, each at most ten bytes.
const DELTA_HEAD: usize = 20;

/// Why a push cannot be stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Violation {
    /// An object larger than the store holds.
    ObjectTooLarge { size: u64 },
    /// The body is not a receive-pack request g1t can read.
    Malformed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// pkt-line commands, until a flush packet.
    Commands,
    /// The rest of one command's payload.
    SkipLine(usize),
    /// After the commands: `PACK`, or push options before it.
    PackHeader,
    /// The pack's version and object count.
    PackCount,
    /// An object's type and size.
    EntryHeader,
    /// The offset that names an ofs-delta's base.
    OffsetBase,
    /// The id that names a ref-delta's base.
    RefBase(usize),
    /// The object's deflated data.
    Inflate,
    /// The pack's checksum, and anything after it.
    Trailer,
}

/// Walks a receive-pack body a chunk at a time; see the module docs.
pub struct PackSizer {
    max_object: u64,
    phase: Phase,
    /// Header bytes not yet complete.
    pending: Vec<u8>,
    objects_left: u32,
    /// The object being inflated: whether it is a delta, and its size.
    delta: bool,
    size: u64,
    inflater: Box<DecompressorOxide>,
    window: Vec<u8>,
    window_at: usize,
    /// The first bytes a delta inflated to.
    head: Vec<u8>,
    /// Objects read in full.
    pub objects: u32,
    /// The largest object seen, inflated.
    pub largest: u64,
    /// Bytes fed so far.
    pub fed: u64,
    /// Where the pack began in the body, once it has.
    pack_start: Option<u64>,
}

impl PackSizer {
    pub fn new(max_object: u64) -> Self {
        PackSizer {
            max_object,
            phase: Phase::Commands,
            pending: Vec::with_capacity(32),
            objects_left: 0,
            delta: false,
            size: 0,
            inflater: Box::default(),
            window: Vec::new(),
            window_at: 0,
            head: Vec::with_capacity(DELTA_HEAD),
            objects: 0,
            largest: 0,
            fed: 0,
            pack_start: None,
        }
    }

    /// Bytes of the pack itself, after the commands, so far.
    pub fn pack_bytes(&self) -> u64 {
        self.pack_start.map_or(0, |start| self.fed - start)
    }

    /// Whether every object the pack said it holds has been read, or the
    /// push carries no pack (it only deletes).
    #[cfg(test)]
    pub fn complete(&self) -> bool {
        match self.phase {
            Phase::Trailer => true,
            Phase::Commands | Phase::PackHeader => self.pack_start.is_none() && self.pending.is_empty(),
            _ => false,
        }
    }

    /// Reads the next chunk of the body.
    pub fn feed(&mut self, mut input: &[u8]) -> Result<(), Violation> {
        let base = self.fed;
        let length = input.len() as u64;
        self.fed += length;
        while !input.is_empty() {
            match self.phase {
                Phase::Commands => {
                    let taken = self.take(&mut input, 4);
                    if !taken {
                        return Ok(());
                    }
                    let length = std::str::from_utf8(&self.pending)
                        .ok()
                        .and_then(|hex| usize::from_str_radix(hex, 16).ok())
                        .ok_or_else(|| Violation::Malformed("a command is not a pkt-line".into()))?;
                    self.pending.clear();
                    match length {
                        0 => self.phase = Phase::PackHeader,
                        1..=3 => {}
                        _ => self.phase = Phase::SkipLine(length - 4),
                    }
                }
                Phase::SkipLine(left) => {
                    let skipped = left.min(input.len());
                    input = &input[skipped..];
                    self.phase = if skipped == left { Phase::Commands } else { Phase::SkipLine(left - skipped) };
                }
                Phase::PackHeader => {
                    if !self.take(&mut input, 4) {
                        return Ok(());
                    }
                    if self.pending == b"PACK" {
                        self.pack_start = Some(base + length - input.len() as u64 - 4);
                        self.phase = Phase::PackCount;
                        continue;
                    }
                    // Push options come as pkt-lines between the commands
                    // and the pack, ended by another flush.
                    let line = std::str::from_utf8(&self.pending)
                        .ok()
                        .and_then(|hex| usize::from_str_radix(hex, 16).ok())
                        .ok_or_else(|| Violation::Malformed("the push does not carry a pack".into()))?;
                    self.pending.clear();
                    if line >= 4 {
                        self.phase = Phase::SkipLine(line - 4);
                    }
                }
                Phase::PackCount => {
                    if !self.take(&mut input, 12) {
                        return Ok(());
                    }
                    let p = &self.pending;
                    self.objects_left = u32::from_be_bytes([p[8], p[9], p[10], p[11]]);
                    self.pending.clear();
                    self.phase = if self.objects_left == 0 { Phase::Trailer } else { Phase::EntryHeader };
                }
                Phase::EntryHeader => {
                    let byte = input[0];
                    input = &input[1..];
                    self.pending.push(byte);
                    if byte & 0x80 != 0 {
                        if self.pending.len() > 10 {
                            return Err(Violation::Malformed("an object's size is too long".into()));
                        }
                        continue;
                    }
                    let first = self.pending[0];
                    let code = (first >> 4) & 7;
                    let mut size = u64::from(first & 15);
                    for (n, byte) in self.pending[1..].iter().enumerate() {
                        size |= u64::from(byte & 0x7f) << (4 + 7 * n);
                    }
                    self.pending.clear();
                    self.size = size;
                    self.delta = matches!(code, 6 | 7);
                    if !self.delta && size > self.max_object {
                        return Err(Violation::ObjectTooLarge { size });
                    }
                    self.phase = match code {
                        1..=4 => self.start_inflate(),
                        6 => Phase::OffsetBase,
                        7 => Phase::RefBase(20),
                        _ => return Err(Violation::Malformed(format!("an object has an unknown type {code}"))),
                    };
                }
                Phase::OffsetBase => {
                    let byte = input[0];
                    input = &input[1..];
                    if byte & 0x80 == 0 {
                        self.phase = self.start_inflate();
                    }
                }
                Phase::RefBase(left) => {
                    let skipped = left.min(input.len());
                    input = &input[skipped..];
                    self.phase = if skipped == left { self.start_inflate() } else { Phase::RefBase(left - skipped) };
                }
                Phase::Inflate => {
                    let flags = inflate_flags::TINFL_FLAG_PARSE_ZLIB_HEADER
                        | inflate_flags::TINFL_FLAG_HAS_MORE_INPUT
                        | inflate_flags::TINFL_FLAG_IGNORE_ADLER32;
                    let (status, consumed, written) =
                        decompress(&mut self.inflater, input, &mut self.window, self.window_at, flags);
                    if self.delta && self.head.len() < DELTA_HEAD {
                        let wanted = (DELTA_HEAD - self.head.len()).min(written);
                        for n in 0..wanted {
                            self.head.push(self.window[(self.window_at + n) & (WINDOW - 1)]);
                        }
                    }
                    self.window_at = (self.window_at + written) & (WINDOW - 1);
                    input = &input[consumed..];
                    match status {
                        TINFLStatus::Done => self.finish_object()?,
                        TINFLStatus::NeedsMoreInput | TINFLStatus::HasMoreOutput => {
                            if consumed == 0 && written == 0 && !input.is_empty() {
                                return Err(Violation::Malformed("an object stopped inflating".into()));
                            }
                        }
                        other => return Err(Violation::Malformed(format!("an object could not be inflated: {other:?}"))),
                    }
                }
                Phase::Trailer => return Ok(()),
            }
        }
        Ok(())
    }

    /// Moves up to `wanted` bytes in all into `pending`; whether it has them.
    fn take(&mut self, input: &mut &[u8], wanted: usize) -> bool {
        let missing = wanted - self.pending.len();
        let taken = missing.min(input.len());
        self.pending.extend_from_slice(&input[..taken]);
        *input = &input[taken..];
        self.pending.len() == wanted
    }

    fn start_inflate(&mut self) -> Phase {
        self.inflater.init();
        if self.window.is_empty() {
            self.window = vec![0; WINDOW];
        }
        self.window_at = 0;
        self.head.clear();
        Phase::Inflate
    }

    fn finish_object(&mut self) -> Result<(), Violation> {
        let size = if self.delta {
            let mut at = 0;
            let _base = varint(&self.head, &mut at);
            varint(&self.head, &mut at).ok_or_else(|| Violation::Malformed("a delta is too short".into()))?
        } else {
            self.size
        };
        if size > self.max_object {
            return Err(Violation::ObjectTooLarge { size });
        }
        self.largest = self.largest.max(size);
        self.objects += 1;
        self.objects_left -= 1;
        self.phase = if self.objects_left == 0 { Phase::Trailer } else { Phase::EntryHeader };
        Ok(())
    }
}

fn varint(data: &[u8], at: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0;
    loop {
        let byte = *data.get(*at)?;
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

/// Bytes as people read them: "31.2 MB".
pub fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_000_000.0)
}

/// Whether a push of `incoming` bytes would take a repository holding
/// `held` past `limit`.
pub fn over_repo_limit(held: u64, incoming: u64, limit: u64) -> bool {
    held.saturating_add(incoming) > limit
}

/// The upload-pack answer's side-band channels: the pack, progress, and a
/// fatal error.
const PACK_BAND: u8 = 1;
const ERROR_BAND: u8 = 3;

/// Takes an upload-pack answer that used side-band framing a chunk at a
/// time and gives back the pack's bytes as they arrive.
#[derive(Default)]
pub struct Sideband {
    /// A packet not yet complete: its length line, then its payload.
    pending: Vec<u8>,
    /// Whether the first pack bytes were `PACK`, once known.
    started: bool,
    /// Bytes of pack given back so far.
    pub pack_bytes: u64,
    done: bool,
}

impl Sideband {
    /// The pack bytes in the next chunk of the answer, or why it failed.
    pub fn feed(&mut self, input: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        self.pending.extend_from_slice(input);
        let mut at = 0;
        while !self.done && self.pending.len() >= at + 4 {
            let length = std::str::from_utf8(&self.pending[at..at + 4])
                .ok()
                .and_then(|hex| usize::from_str_radix(hex, 16).ok())
                .ok_or_else(|| "the source did not answer in pkt-lines".to_owned())?;
            if length < 4 {
                // Flush and delimiter packets carry nothing. A flush after
                // the pack ends the answer.
                at += 4;
                if length == 0 && self.started {
                    self.done = true;
                }
                continue;
            }
            if self.pending.len() < at + length {
                break;
            }
            let payload = &self.pending[at + 4..at + length];
            match payload.first() {
                Some(&PACK_BAND) => {
                    let data = &payload[1..];
                    if !self.started && !data.is_empty() {
                        if !(data.starts_with(b"PACK") || (self.pack_bytes == 0 && b"PACK".starts_with(data))) {
                            return Err(format!("the source did not send a pack: {}", String::from_utf8_lossy(data)));
                        }
                        self.started = true;
                    }
                    self.pack_bytes += data.len() as u64;
                    out.extend_from_slice(data);
                }
                Some(&ERROR_BAND) => {
                    return Err(format!("the source refused the fetch: {}", String::from_utf8_lossy(&payload[1..])));
                }
                // ACK and NAK lines, and progress.
                _ => {}
            }
            at += length;
        }
        self.pending.drain(..at);
        Ok(out)
    }

    /// Whether a pack arrived.
    pub fn finish(&self) -> Result<(), String> {
        if self.started { Ok(()) } else { Err("the source did not send a pack".to_owned()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_scan::pack::{ObjectKind, write_pack};
    use miniz_oxide::deflate::compress_to_vec_zlib;

    fn pkt(payload: &str) -> Vec<u8> {
        format!("{:04x}{payload}", payload.len() + 4).into_bytes()
    }

    fn push(pack: &[u8]) -> Vec<u8> {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        [pkt(&format!("{old} {new} refs/heads/main\0 report-status side-band-64k\n")), b"0000".to_vec(), pack.to_vec()].concat()
    }

    /// Feeds `body` in chunks of `size` bytes.
    fn walk(body: &[u8], size: usize, max: u64) -> Result<PackSizer, Violation> {
        let mut sizer = PackSizer::new(max);
        for chunk in body.chunks(size) {
            sizer.feed(chunk)?;
        }
        Ok(sizer)
    }

    fn noise(len: usize, seed: u32) -> Vec<u8> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                (state >> 16) as u8
            })
            .collect()
    }

    #[test]
    fn every_object_is_walked_whatever_the_chunks() {
        let objects = vec![
            (ObjectKind::Blob, noise(70_000, 1)),
            (ObjectKind::Blob, b"small\n".to_vec()),
            (ObjectKind::Blob, vec![b'a'; 200_000]),
            (ObjectKind::Tree, Vec::new()),
        ];
        let body = push(&write_pack(&objects));
        for size in [1, 3, 7, 64, 1000, 65_536, body.len()] {
            let sizer = walk(&body, size, MAX_OBJECT_BYTES).unwrap();
            assert_eq!(sizer.objects, 4, "chunks of {size}");
            assert_eq!(sizer.largest, 200_000);
            assert!(sizer.complete());
            assert_eq!(sizer.fed, body.len() as u64);
            assert_eq!(sizer.pack_bytes(), body.len() as u64 - (body.windows(4).position(|w| w == b"PACK").unwrap() as u64));
        }
    }

    #[test]
    fn an_object_over_the_limit_is_found_from_its_header() {
        let objects = vec![(ObjectKind::Blob, vec![b'x'; 5_000]), (ObjectKind::Blob, vec![b'y'; 50])];
        let body = push(&write_pack(&objects));
        assert_eq!(walk(&body, 13, 4_999).err(), Some(Violation::ObjectTooLarge { size: 5_000 }));
        assert!(walk(&body, 13, 5_000).is_ok());
    }

    /// A pack entry for a ref-delta against `base` that makes an object of
    /// `target` bytes.
    fn ref_delta(base_len: usize, target: usize) -> Vec<u8> {
        fn put(mut value: usize, out: &mut Vec<u8>) {
            loop {
                let byte = (value & 0x7f) as u8;
                value >>= 7;
                if value == 0 {
                    out.push(byte);
                    return;
                }
                out.push(byte | 0x80);
            }
        }
        let mut delta = Vec::new();
        put(base_len, &mut delta);
        put(target, &mut delta);
        // Copy the base's first `target` bytes, in one instruction of up to
        // 0x10000 per copy.
        let mut copied = 0;
        while copied < target {
            let size = (target - copied).min(0xffff);
            delta.extend_from_slice(&[0x80 | 0x01 | 0x02 | 0x10 | 0x20, (copied & 0xff) as u8, ((copied >> 8) & 0xff) as u8, (size & 0xff) as u8, ((size >> 8) & 0xff) as u8]);
            copied += size;
        }
        let mut entry = Vec::new();
        let mut size = delta.len();
        let mut byte = (7u8 << 4) | (size & 15) as u8;
        size >>= 4;
        while size > 0 {
            entry.push(byte | 0x80);
            byte = (size & 0x7f) as u8;
            size >>= 7;
        }
        entry.push(byte);
        entry.extend_from_slice(&[0xab; 20]);
        entry.extend(compress_to_vec_zlib(&delta, 6));
        entry
    }

    #[test]
    fn a_delta_is_measured_by_the_object_it_makes() {
        let mut pack = b"PACK".to_vec();
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&1u32.to_be_bytes());
        pack.extend(ref_delta(60_000, 60_000));
        pack.extend_from_slice(&[0u8; 20]);
        let body = push(&pack);
        for size in [1, 5, 4096] {
            let sizer = walk(&body, size, MAX_OBJECT_BYTES).unwrap();
            assert_eq!((sizer.objects, sizer.largest), (1, 60_000));
        }
        // The delta itself is a few bytes; the object it makes is not.
        assert_eq!(walk(&body, 7, 59_999).err(), Some(Violation::ObjectTooLarge { size: 60_000 }));
    }

    #[test]
    fn a_push_that_only_deletes_has_no_pack() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let body = [pkt(&format!("{old} 0000000000000000000000000000000000000000 refs/heads/gone\0 report-status delete-refs\n")), b"0000".to_vec()].concat();
        let sizer = walk(&body, 5, MAX_OBJECT_BYTES).unwrap();
        assert_eq!(sizer.objects, 0);
        assert!(sizer.complete());
        assert_eq!(sizer.pack_bytes(), 0);
    }

    #[test]
    fn push_options_before_the_pack_are_skipped() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        let pack = write_pack(&[(ObjectKind::Blob, b"hi\n".to_vec())]);
        let body = [
            pkt(&format!("{old} {new} refs/heads/main\0 report-status push-options\n")),
            b"0000".to_vec(),
            pkt("ci.skip\n"),
            b"0000".to_vec(),
            pack.clone(),
        ]
        .concat();
        for size in [1, 6, body.len()] {
            let sizer = walk(&body, size, MAX_OBJECT_BYTES).unwrap();
            assert_eq!(sizer.objects, 1);
            assert_eq!(sizer.pack_bytes(), pack.len() as u64);
        }
    }

    #[test]
    fn a_body_that_is_not_a_push_is_malformed() {
        assert!(matches!(walk(b"zzzz", 4, 10), Err(Violation::Malformed(_))));
        assert!(matches!(walk(&push(b"NOPE\0\0\0\x02\0\0\0\x01"), 4, 10), Err(Violation::Malformed(_))));
        // A pack cut short is not complete.
        let body = push(&write_pack(&[(ObjectKind::Blob, noise(10_000, 3))]));
        let cut = walk(&body[..body.len() / 2], 100, MAX_OBJECT_BYTES).unwrap();
        assert!(!cut.complete());
    }

    #[test]
    fn the_repository_limit_counts_what_it_holds_and_what_arrives() {
        assert!(!over_repo_limit(900_000_000, 50_000_000, DEFAULT_REPO_LIMIT_BYTES));
        assert!(over_repo_limit(900_000_000, 50_000_001, DEFAULT_REPO_LIMIT_BYTES));
        assert!(!over_repo_limit(0, 0, 0));
        assert_eq!(megabytes(31_200_000), "31.2 MB");
    }

    fn band(channel: u8, data: &[u8]) -> Vec<u8> {
        let mut out = format!("{:04x}", data.len() + 5).into_bytes();
        out.push(channel);
        out.extend_from_slice(data);
        out
    }

    #[test]
    fn a_side_band_answer_gives_back_its_pack_whatever_the_chunks() {
        let pack = write_pack(&[(ObjectKind::Blob, noise(30_000, 9))]);
        let mut answer = pkt("NAK\n");
        answer.extend(band(2, b"Counting objects\n"));
        for part in pack.chunks(65_515) {
            answer.extend(band(1, part));
        }
        answer.extend_from_slice(b"0000");
        for size in [1, 3, 1000, answer.len()] {
            let mut demux = Sideband::default();
            let mut out = Vec::new();
            for chunk in answer.chunks(size) {
                out.extend(demux.feed(chunk).unwrap());
            }
            demux.finish().unwrap();
            assert_eq!(out, pack, "chunks of {size}");
            assert_eq!(demux.pack_bytes, pack.len() as u64);
        }
    }

    #[test]
    fn a_side_band_error_or_no_pack_fails() {
        let mut demux = Sideband::default();
        let answer = [pkt("NAK\n"), band(3, b"upload-pack: not our ref")].concat();
        assert!(demux.feed(&answer).unwrap_err().contains("not our ref"));
        let mut empty = Sideband::default();
        empty.feed(&[pkt("NAK\n"), b"0000".to_vec()].concat()).unwrap();
        assert!(empty.finish().is_err());
    }
}
