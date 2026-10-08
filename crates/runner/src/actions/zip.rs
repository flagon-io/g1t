//! Artifacts as ZIP files, as `actions/upload-artifact` makes them and
//! `actions/download-artifact` reads them: each file deflated (or stored,
//! at level 0) with its CRC-32, UTF-8 names, unix modes and times.
//!
//! Each local header is written before its file and then filled in by
//! seeking back, so there are no data descriptors and the ZIP unpacks as
//! it streams. Sizes, offsets and counts too large for the classic fields
//! go in ZIP64 extra fields and ZIP64 end records. Files are streamed in
//! and out; none is held in memory whole.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use flate2::Compression;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;

const LOCAL: u32 = 0x0403_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const END: u32 = 0x0605_4b50;
const END64: u32 = 0x0606_4b50;
const LOCATOR64: u32 = 0x0706_4b50;
/// Names are UTF-8 (general purpose flag bit 11).
const UTF8: u16 = 1 << 11;
/// Made by unix (3), to version 4.5 of the specification.
const MADE_BY: u16 = (3 << 8) | 45;
/// A file at least this big gets a ZIP64 local header, leaving room for
/// deflate to come out a little larger than what went in.
const LOCAL64_FROM: u64 = 0xF000_0000;
const MAX32: u64 = 0xFFFF_FFFF;

/// What packing wrote.
#[derive(Debug)]
pub(crate) struct Packed {
    pub(crate) files: usize,
    /// The ZIP file's size.
    pub(crate) size: u64,
}

/// One file in the central directory.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Entry {
    pub(crate) name: String,
    pub(crate) method: u16,
    pub(crate) crc: u32,
    pub(crate) compressed: u64,
    pub(crate) size: u64,
    pub(crate) offset: u64,
    pub(crate) time: u16,
    pub(crate) date: u16,
    /// The unix mode, when the entry has one.
    pub(crate) mode: Option<u32>,
}

/// Counts what goes through to the file, for the compressed size.
struct Counted<'a, W: Write> {
    inner: &'a mut W,
    count: u64,
}

impl<W: Write> Write for Counted<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.count += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Packs `files`, each a name in the ZIP and the file on disk, into the
/// ZIP file `out`, deflated at `level` (0 to 9; 0 stores them as they are).
pub(crate) fn write(out: &Path, files: &[(String, PathBuf)], level: u32) -> io::Result<Packed> {
    let mut zip = BufWriter::new(File::create(out)?);
    let mut entries = Vec::with_capacity(files.len());
    let mut buffer = vec![0u8; 64 * 1024];
    for (name, path) in files {
        let meta = std::fs::metadata(path)?;
        let (time, date) = dos_time(meta.modified().unwrap_or(SystemTime::UNIX_EPOCH));
        let method = if level == 0 { 0 } else { 8 };
        let offset = zip.stream_position()?;
        let large = meta.len() >= LOCAL64_FROM;
        let mut entry = Entry { name: name.clone(), method, crc: 0, compressed: 0, size: 0, offset, time, date, mode: Some(mode(&meta)) };
        zip.write_all(&local_header(&entry, large))?;
        let data_start = zip.stream_position()?;
        let mut crc = crc32fast::Hasher::new();
        let mut size = 0u64;
        let mut input = File::open(path)?;
        let mut counted = Counted { inner: &mut zip, count: 0 };
        if method == 0 {
            loop {
                let n = input.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                crc.update(&buffer[..n]);
                size += n as u64;
                counted.write_all(&buffer[..n])?;
            }
        } else {
            let mut encoder = DeflateEncoder::new(&mut counted, Compression::new(level.min(9)));
            loop {
                let n = input.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                crc.update(&buffer[..n]);
                size += n as u64;
                encoder.write_all(&buffer[..n])?;
            }
            encoder.finish()?;
        }
        entry.compressed = counted.count;
        entry.size = size;
        entry.crc = crc.finalize();
        if !large && (entry.size > MAX32 || entry.compressed > MAX32) {
            return Err(io::Error::other(format!("{name} grew past 4 GB while it was packed")));
        }
        let end = zip.stream_position()?;
        debug_assert_eq!(end, data_start + entry.compressed);
        zip.seek(SeekFrom::Start(offset))?;
        zip.write_all(&local_header(&entry, large))?;
        zip.seek(SeekFrom::Start(end))?;
        entries.push(entry);
    }
    let directory = zip.stream_position()?;
    for entry in &entries {
        zip.write_all(&central_header(entry))?;
    }
    let directory_size = zip.stream_position()? - directory;
    zip.write_all(&end_records(entries.len() as u64, directory_size, directory))?;
    let size = zip.stream_position()?;
    zip.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    Ok(Packed { files: entries.len(), size })
}

#[cfg(unix)]
fn mode(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode()
}

#[cfg(not(unix))]
fn mode(meta: &std::fs::Metadata) -> u32 {
    if meta.permissions().readonly() { 0o100_444 } else { 0o100_644 }
}

/// A time as MS-DOS keeps it, in UTC, from 1980 on.
fn dos_time(time: SystemTime) -> (u16, u16) {
    let secs = time.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0).max(315_532_800);
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    // Days since 1970 as a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = (yoe + era * 400 + i64::from(month <= 2)).min(2107);
    let time = ((rest / 3600) << 11) | (((rest % 3600) / 60) << 5) | ((rest % 60) / 2);
    let date = (((year - 1980) as u64) << 9) | ((month as u64) << 5) | day as u64;
    (time as u16, date as u16)
}

fn version_needed(zip64: bool) -> u16 {
    if zip64 { 45 } else { 20 }
}

/// A local file header; with `large`, its sizes in a ZIP64 extra field.
pub(crate) fn local_header(entry: &Entry, large: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(30 + entry.name.len() + 20);
    put32(&mut out, LOCAL);
    put16(&mut out, version_needed(large));
    put16(&mut out, UTF8);
    put16(&mut out, entry.method);
    put16(&mut out, entry.time);
    put16(&mut out, entry.date);
    put32(&mut out, entry.crc);
    let extra = if large { zip64_extra(Some(entry.size), Some(entry.compressed), None) } else { Vec::new() };
    put32(&mut out, if large { MAX32 as u32 } else { entry.compressed as u32 });
    put32(&mut out, if large { MAX32 as u32 } else { entry.size as u32 });
    put16(&mut out, entry.name.len() as u16);
    put16(&mut out, extra.len() as u16);
    out.extend_from_slice(entry.name.as_bytes());
    out.extend_from_slice(&extra);
    out
}

/// A ZIP64 extended information field: the values given, in the
/// specification's order (size, compressed size, offset).
pub(crate) fn zip64_extra(size: Option<u64>, compressed: Option<u64>, offset: Option<u64>) -> Vec<u8> {
    let values: Vec<u64> = [size, compressed, offset].into_iter().flatten().collect();
    let mut out = Vec::with_capacity(4 + values.len() * 8);
    put16(&mut out, 0x0001);
    put16(&mut out, (values.len() * 8) as u16);
    for value in values {
        put64(&mut out, value);
    }
    out
}

/// An entry's header in the central directory, with a ZIP64 extra field
/// for whichever of its sizes and offset do not fit 32 bits.
pub(crate) fn central_header(entry: &Entry) -> Vec<u8> {
    let big = |v: u64| v >= MAX32;
    let extra = if big(entry.size) || big(entry.compressed) || big(entry.offset) {
        zip64_extra(big(entry.size).then_some(entry.size), big(entry.compressed).then_some(entry.compressed), big(entry.offset).then_some(entry.offset))
    } else {
        Vec::new()
    };
    let clip = |v: u64| if big(v) { MAX32 as u32 } else { v as u32 };
    let mut out = Vec::with_capacity(46 + entry.name.len() + extra.len());
    put32(&mut out, CENTRAL);
    put16(&mut out, MADE_BY);
    put16(&mut out, version_needed(!extra.is_empty()));
    put16(&mut out, UTF8);
    put16(&mut out, entry.method);
    put16(&mut out, entry.time);
    put16(&mut out, entry.date);
    put32(&mut out, entry.crc);
    put32(&mut out, clip(entry.compressed));
    put32(&mut out, clip(entry.size));
    put16(&mut out, entry.name.len() as u16);
    put16(&mut out, extra.len() as u16);
    put16(&mut out, 0); // comment
    put16(&mut out, 0); // disk
    put16(&mut out, 0); // internal attributes
    put32(&mut out, entry.mode.unwrap_or(0) << 16);
    put32(&mut out, clip(entry.offset));
    out.extend_from_slice(entry.name.as_bytes());
    out.extend_from_slice(&extra);
    out
}

/// The end of central directory record, after a ZIP64 end record and
/// its locator when the count, size or offset needs them.
pub(crate) fn end_records(count: u64, size: u64, offset: u64) -> Vec<u8> {
    let mut out = Vec::new();
    let zip64 = count >= 0xFFFF || size >= MAX32 || offset >= MAX32;
    if zip64 {
        let at = offset + size;
        put32(&mut out, END64);
        put64(&mut out, 44);
        put16(&mut out, MADE_BY);
        put16(&mut out, 45);
        put32(&mut out, 0);
        put32(&mut out, 0);
        put64(&mut out, count);
        put64(&mut out, count);
        put64(&mut out, size);
        put64(&mut out, offset);
        put32(&mut out, LOCATOR64);
        put32(&mut out, 0);
        put64(&mut out, at);
        put32(&mut out, 1);
    }
    put32(&mut out, END);
    put16(&mut out, 0);
    put16(&mut out, 0);
    let count16 = if zip64 { 0xFFFF } else { count as u16 };
    put16(&mut out, count16);
    put16(&mut out, count16);
    put32(&mut out, if zip64 { MAX32 as u32 } else { size as u32 });
    put32(&mut out, if zip64 { MAX32 as u32 } else { offset as u32 });
    put16(&mut out, 0);
    out
}

fn put16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn get16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn get32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}
fn get64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

fn bad(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Where the central directory is, from the end of a ZIP file whose last
/// bytes are `tail`, starting at `tail_at` in the file: its entry count,
/// size and offset. When the classic record says to, the ZIP64 end record
/// is read with `read_at`.
pub(crate) fn find_directory(tail: &[u8], tail_at: u64, mut read_at: impl FnMut(u64, usize) -> io::Result<Vec<u8>>) -> io::Result<(u64, u64, u64)> {
    let end = (0..=tail.len().saturating_sub(22)).rev().find(|&i| get32(tail, i) == END).ok_or_else(|| bad("it is not a ZIP file"))?;
    let mut count = u64::from(get16(tail, end + 10));
    let mut size = u64::from(get32(tail, end + 12));
    let mut offset = u64::from(get32(tail, end + 16));
    if count == 0xFFFF || size == MAX32 || offset == MAX32 {
        if end < 20 || get32(tail, end - 20) != LOCATOR64 {
            return Err(bad("its ZIP64 end record is missing"));
        }
        let at = get64(tail, end - 20 + 8);
        let record = if at >= tail_at && (at - tail_at) as usize + 56 <= tail.len() {
            tail[(at - tail_at) as usize..(at - tail_at) as usize + 56].to_vec()
        } else {
            read_at(at, 56)?
        };
        if get32(&record, 0) != END64 {
            return Err(bad("its ZIP64 end record is damaged"));
        }
        count = get64(&record, 32);
        size = get64(&record, 40);
        offset = get64(&record, 48);
    }
    Ok((count, size, offset))
}

/// The entries of a central directory, sizes and offsets from ZIP64 extra
/// fields where the classic ones say to look there.
pub(crate) fn parse_directory(directory: &[u8], count: u64) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    let mut at = 0;
    for _ in 0..count {
        if at + 46 > directory.len() || get32(directory, at) != CENTRAL {
            return Err(bad("its central directory is damaged"));
        }
        let made_by = get16(directory, at + 4);
        let flags = get16(directory, at + 8);
        if flags & 1 != 0 {
            return Err(bad("it is encrypted"));
        }
        let name_len = get16(directory, at + 28) as usize;
        let extra_len = get16(directory, at + 30) as usize;
        let comment_len = get16(directory, at + 32) as usize;
        let next = at + 46 + name_len + extra_len + comment_len;
        if next > directory.len() {
            return Err(bad("its central directory is damaged"));
        }
        let name_bytes = &directory[at + 46..at + 46 + name_len];
        let name = String::from_utf8(name_bytes.to_vec()).unwrap_or_else(|_| name_bytes.iter().map(|&b| b as char).collect());
        let mut entry = Entry {
            name,
            method: get16(directory, at + 10),
            time: get16(directory, at + 12),
            date: get16(directory, at + 14),
            crc: get32(directory, at + 16),
            compressed: u64::from(get32(directory, at + 20)),
            size: u64::from(get32(directory, at + 24)),
            offset: u64::from(get32(directory, at + 42)),
            mode: None,
        };
        let attributes = get32(directory, at + 38) >> 16;
        if made_by >> 8 == 3 && attributes != 0 {
            entry.mode = Some(attributes);
        }
        let mut extra = &directory[at + 46 + name_len..at + 46 + name_len + extra_len];
        while extra.len() >= 4 {
            let id = get16(extra, 0);
            let len = (get16(extra, 2) as usize).min(extra.len() - 4);
            if id == 0x0001 {
                let field = &extra[4..4 + len];
                let mut i = 0;
                for value in [&mut entry.size, &mut entry.compressed, &mut entry.offset] {
                    if *value == MAX32 && i + 8 <= field.len() {
                        *value = get64(field, i);
                        i += 8;
                    }
                }
            }
            extra = &extra[4 + len..];
        }
        entries.push(entry);
        at = next;
    }
    Ok(entries)
}

/// Where an entry may be unpacked under `into`: never an absolute path,
/// a drive, or a `..` part. `None` refuses it.
pub(crate) fn safe_path(into: &Path, name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    if name.starts_with('/') || name.as_bytes().get(1) == Some(&b':') {
        return None;
    }
    let mut out = into.to_path_buf();
    for part in name.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            _ => {
                let path = Path::new(part);
                if path.components().any(|c| !matches!(c, Component::Normal(_))) {
                    return None;
                }
                out.push(part);
            }
        }
    }
    Some(out)
}

/// Checks the CRC of what is written through it.
struct Checked<W: Write> {
    inner: W,
    crc: crc32fast::Hasher,
}

impl<W: Write> Write for Checked<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.crc.update(&buf[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Unpacks the ZIP file `zip` into the folder `into`; how many files it
/// held. Refuses, before writing anything, a ZIP with an entry that would
/// land outside `into`.
pub(crate) fn extract(zip: &Path, into: &Path) -> io::Result<usize> {
    let mut file = File::open(zip)?;
    let len = file.metadata()?.len();
    let tail_len = len.min(65_535 + 22 + 20 + 56);
    let tail_at = len - tail_len;
    let mut tail = vec![0u8; tail_len as usize];
    file.seek(SeekFrom::Start(tail_at))?;
    file.read_exact(&mut tail)?;
    let (count, size, offset) = find_directory(&tail, tail_at, |at, n| {
        let mut buf = vec![0u8; n];
        file.seek(SeekFrom::Start(at))?;
        file.read_exact(&mut buf)?;
        Ok(buf)
    })?;
    if offset.checked_add(size).is_none_or(|end| end > len) {
        return Err(bad("its central directory is past its end"));
    }
    let mut directory = vec![0u8; size as usize];
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut directory)?;
    let entries = parse_directory(&directory, count)?;
    let mut targets = Vec::with_capacity(entries.len());
    for entry in &entries {
        let target = safe_path(into, &entry.name).ok_or_else(|| bad(format!("it has an entry outside its folder: {}", entry.name)))?;
        targets.push(target);
    }
    std::fs::create_dir_all(into)?;
    let mut files = 0;
    for (entry, target) in entries.iter().zip(targets) {
        if entry.name.ends_with('/') || entry.name.ends_with('\\') {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut header = [0u8; 30];
        file.seek(SeekFrom::Start(entry.offset))?;
        file.read_exact(&mut header)?;
        if get32(&header, 0) != LOCAL {
            return Err(bad(format!("{} has no local header", entry.name)));
        }
        let data = entry.offset + 30 + u64::from(get16(&header, 26)) + u64::from(get16(&header, 28));
        file.seek(SeekFrom::Start(data))?;
        let mut raw = BufReader::new((&mut file).take(entry.compressed));
        let _ = std::fs::remove_file(&target);
        let mut out = Checked { inner: BufWriter::new(File::create(&target)?), crc: crc32fast::Hasher::new() };
        let written = match entry.method {
            0 => io::copy(&mut raw, &mut out)?,
            8 => io::copy(&mut DeflateDecoder::new(raw), &mut out)?,
            other => return Err(bad(format!("{} is compressed with method {other}, which g1t does not read", entry.name))),
        };
        out.inner.flush()?;
        if written != entry.size || out.crc.finalize() != entry.crc {
            return Err(bad(format!("{} is damaged: its size or CRC does not check", entry.name)));
        }
        #[cfg(unix)]
        if let Some(mode) = entry.mode {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode & 0o7777));
        }
        files += 1;
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("g1t-zip-{label}-{}-{}", std::process::id(), super::super::rand_id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(dir: &Path) -> Vec<(String, PathBuf)> {
        let mut big = Vec::new();
        for i in 0..100_000u32 {
            big.extend_from_slice(&(i.wrapping_mul(2_654_435_761)).to_le_bytes()[..1 + (i % 3) as usize]);
        }
        let files: Vec<(&str, Vec<u8>)> = vec![
            ("a.txt", b"hello\n".to_vec()),
            ("nested/deeper/b.txt", b"bee".repeat(1000)),
            ("empty", Vec::new()),
            ("big.bin", big),
            ("ünïcødé/文件.txt", "unicode".as_bytes().to_vec()),
        ];
        files
            .into_iter()
            .map(|(name, bytes)| {
                let path = dir.join(name);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, bytes).unwrap();
                (name.to_owned(), path)
            })
            .collect()
    }

    fn round_trip(level: u32) {
        let dir = scratch(&format!("level{level}"));
        let source = dir.join("src");
        let files = sample(&source);
        let zip = dir.join("a.zip");
        let packed = write(&zip, &files, level).unwrap();
        assert_eq!(packed.files, files.len());
        assert_eq!(packed.size, std::fs::metadata(&zip).unwrap().len());
        assert!(files.iter().any(|(_, p)| std::fs::metadata(p).unwrap().len() > 64 * 1024));
        let out = dir.join("out");
        assert_eq!(extract(&zip, &out).unwrap(), files.len());
        for (name, path) in &files {
            assert_eq!(std::fs::read(out.join(name)).unwrap(), std::fs::read(path).unwrap(), "{name}");
        }
        // Other tools read it too, where they are installed.
        if Command::new("unzip").arg("-v").output().is_ok_and(|o| o.status.success()) {
            let status = Command::new("unzip").arg("-tq").arg(&zip).status().unwrap();
            assert!(status.success(), "unzip -t failed");
        }
        let check = "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()))";
        for python in ["python3", "python"] {
            if let Ok(output) = Command::new(python).args(["-c", check]).arg(&zip).output()
                && output.status.success()
            {
                assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), files.len().to_string());
                break;
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deflated_zips_round_trip() {
        round_trip(9);
        round_trip(6);
    }

    #[test]
    fn stored_zips_round_trip() {
        round_trip(0);
    }

    #[test]
    fn a_damaged_crc_is_caught() {
        let dir = scratch("crc");
        let files = sample(&dir.join("src"));
        let zip = dir.join("a.zip");
        write(&zip, &files[..1], 0).unwrap();
        let mut bytes = std::fs::read(&zip).unwrap();
        // The stored content of a.txt starts after its 30-byte header and name.
        bytes[30 + "a.txt".len()] ^= 0xFF;
        std::fs::write(&zip, bytes).unwrap();
        assert!(extract(&zip, &dir.join("out")).unwrap_err().to_string().contains("CRC"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip64_records_carry_large_values() {
        let entry = Entry {
            name: "huge.bin".into(),
            method: 8,
            crc: 0xDEAD_BEEF,
            compressed: 5 << 30,
            size: 6 << 30,
            offset: 7 << 30,
            time: 1,
            date: 2,
            mode: Some(0o100_644),
        };
        let header = central_header(&entry);
        assert_eq!(get32(&header, 20), u32::MAX);
        assert_eq!(get16(&header, 30), 4 + 24);
        assert_eq!(parse_directory(&header, 1).unwrap(), vec![entry.clone()]);
        // Only the offset too large: only it goes in the extra field.
        let small = Entry { compressed: 10, size: 20, ..entry.clone() };
        let header = central_header(&small);
        assert_eq!(get16(&header, 30), 4 + 8);
        assert_eq!(parse_directory(&header, 1).unwrap(), vec![small]);
        let local = local_header(&entry, true);
        assert_eq!(get32(&local, 18), u32::MAX);
        assert_eq!(get64(&local, 30 + 8 + 4), 6 << 30);
        assert_eq!(get64(&local, 30 + 8 + 12), 5 << 30);

        // The end records, as if the directory sat past 4 GB with 70,000 entries.
        let (count, size, offset) = (70_000u64, 9 << 20, 5u64 << 30);
        let tail = end_records(count, size, offset);
        assert_eq!(tail.len(), 56 + 20 + 22);
        let found = find_directory(&tail, offset + size, |_, _| panic!("the record is in the tail")).unwrap();
        assert_eq!(found, (count, size, offset));
        let plain = end_records(3, 100, 2000);
        assert_eq!(plain.len(), 22);
        assert_eq!(find_directory(&plain, 2100, |_, _| unreachable!()).unwrap(), (3, 100, 2000));
    }

    #[test]
    fn dos_times_count_from_1980() {
        // 2024-02-29 13:45:30 UTC.
        let (time, date) = dos_time(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_709_214_330));
        assert_eq!(date, ((2024 - 1980) << 9) | (2 << 5) | 29);
        assert_eq!(time, (13 << 11) | (45 << 5) | 15);
        assert_eq!(dos_time(SystemTime::UNIX_EPOCH).1, (1 << 5) | 1);
    }

    #[test]
    fn entries_outside_the_folder_are_refused() {
        let into = Path::new("/w/out");
        assert!(safe_path(into, "../x").is_none());
        assert!(safe_path(into, "a/../../x").is_none());
        assert!(safe_path(into, "/etc/passwd").is_none());
        assert!(safe_path(into, "\\abs").is_none());
        assert!(safe_path(into, "C:/x").is_none());
        assert!(safe_path(into, "a\\..\\..\\x").is_none());
        assert_eq!(safe_path(into, "./a/b.txt").unwrap(), into.join("a").join("b.txt"));

        // A whole ZIP holding such an entry writes nothing.
        let dir = scratch("evil");
        let zip = dir.join("evil.zip");
        let file = dir.join("x");
        std::fs::write(&file, "x").unwrap();
        for name in ["../x", "/abs/x"] {
            write(&zip, &[("ok.txt".into(), file.clone()), (name.into(), file.clone())], 6).unwrap();
            let error = extract(&zip, &dir.join("out")).unwrap_err().to_string();
            assert!(error.contains("outside"), "{error}");
            assert!(!dir.join("out").join("ok.txt").exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
