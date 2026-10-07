//! Reading the archives packages arrive as: a `.nupkg` is a zip (read with
//! the CRC-32 the Composer zips are written with), a `.gem` is a tar
//! holding gzipped files. Only what a registry needs is read: the entries'
//! names, and the bytes of the few it asks for, each up to a limit.

use crate::composer::crc32;

/// One file in a zip, as its central directory lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZipEntry {
    pub name: String,
    method: u16,
    crc: u32,
    compressed: u64,
    pub size: u64,
    offset: u64,
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// The files a zip holds, from its central directory.
pub fn zip_entries(bytes: &[u8]) -> Result<Vec<ZipEntry>, String> {
    const END: u32 = 0x0605_4b50;
    const CENTRAL: u32 = 0x0201_4b50;
    let not_zip = || "The file is not a zip archive.".to_owned();
    if bytes.len() < 22 {
        return Err(not_zip());
    }
    // The end record is the last 22 bytes, before a comment of up to 64 KB.
    let earliest = bytes.len().saturating_sub(22 + 0xFFFF);
    let end = (earliest..=bytes.len() - 22).rev().find(|&at| u32_at(bytes, at) == Some(END)).ok_or_else(not_zip)?;
    let count = u16_at(bytes, end + 10).ok_or_else(not_zip)?;
    let mut at = u32_at(bytes, end + 16).ok_or_else(not_zip)? as usize;
    if count == 0xFFFF || at == 0xFFFF_FFFF_usize {
        return Err("The archive is a zip64 archive, which is not read here.".to_owned());
    }
    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        if u32_at(bytes, at) != Some(CENTRAL) {
            return Err("The zip's directory is damaged.".to_owned());
        }
        let field16 = |offset: usize| u16_at(bytes, at + offset).ok_or_else(not_zip);
        let field32 = |offset: usize| u32_at(bytes, at + offset).ok_or_else(not_zip);
        let (name_len, extra_len, comment_len) = (field16(28)? as usize, field16(30)? as usize, field16(32)? as usize);
        let name = bytes.get(at + 46..at + 46 + name_len).ok_or_else(not_zip)?;
        entries.push(ZipEntry {
            name: String::from_utf8_lossy(name).into_owned(),
            method: field16(10)?,
            crc: field32(16)?,
            compressed: u64::from(field32(20)?),
            size: u64::from(field32(24)?),
            offset: u64::from(field32(42)?),
        });
        at += 46 + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

/// The bytes of one entry, inflated and checked against its CRC-32. An
/// entry larger than `limit` is refused.
pub fn zip_read(bytes: &[u8], entry: &ZipEntry, limit: usize) -> Result<Vec<u8>, String> {
    const LOCAL: u32 = 0x0403_4b50;
    let damaged = || format!("{} is damaged in the archive.", entry.name);
    if entry.size > limit as u64 {
        return Err(format!("{} is larger than {} KB.", entry.name, limit / 1024));
    }
    let at = entry.offset as usize;
    if u32_at(bytes, at) != Some(LOCAL) {
        return Err(damaged());
    }
    let start = at + 30 + u16_at(bytes, at + 26).ok_or_else(damaged)? as usize + u16_at(bytes, at + 28).ok_or_else(damaged)? as usize;
    let body = bytes.get(start..start + entry.compressed as usize).ok_or_else(damaged)?;
    let data = match entry.method {
        0 => body.to_vec(),
        8 => miniz_oxide::inflate::decompress_to_vec_with_limit(body, limit).map_err(|_| damaged())?,
        other => return Err(format!("{} is compressed with method {other}, which is not read here.", entry.name)),
    };
    if data.len() as u64 != entry.size || crc32(&data) != entry.crc {
        return Err(damaged());
    }
    Ok(data)
}

/// `data`, gzipped: what RubyGems' full index files are.
pub fn gzip(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];
    out.extend_from_slice(&miniz_oxide::deflate::compress_to_vec(data, 6));
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out
}

/// The bytes of a gzip file, inflated, up to `limit`.
pub fn gunzip(bytes: &[u8], limit: usize) -> Result<Vec<u8>, String> {
    let bad = || "The file is not gzipped.".to_owned();
    if bytes.len() < 18 || bytes[0] != 0x1f || bytes[1] != 0x8b || bytes[2] != 8 {
        return Err(bad());
    }
    let flags = bytes[3];
    let mut at = 10;
    if flags & 4 != 0 {
        at += 2 + u16_at(bytes, at).ok_or_else(bad)? as usize;
    }
    for flag in [8u8, 16] {
        if flags & flag != 0 {
            at += bytes.get(at..).ok_or_else(bad)?.iter().position(|b| *b == 0).ok_or_else(bad)? + 1;
        }
    }
    if flags & 2 != 0 {
        at += 2;
    }
    let body = bytes.get(at..bytes.len() - 8).ok_or_else(bad)?;
    miniz_oxide::inflate::decompress_to_vec_with_limit(body, limit).map_err(|_| "The gzipped file is damaged or too large.".to_owned())
}

/// The regular files of a tar, as name and bytes.
pub fn tar_files(bytes: &[u8]) -> Result<Vec<(String, &[u8])>, String> {
    let mut files = Vec::new();
    let mut at = 0;
    while at + 512 <= bytes.len() {
        let header = &bytes[at..at + 512];
        if header.iter().all(|b| *b == 0) {
            break;
        }
        let text = |range: std::ops::Range<usize>| {
            let field = &header[range];
            let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
            String::from_utf8_lossy(&field[..end]).into_owned()
        };
        let size = u64::from_str_radix(text(124..136).trim(), 8).map_err(|_| "The tar's header is damaged.".to_owned())? as usize;
        let mut name = text(0..100);
        if &header[257..262] == b"ustar" {
            let prefix = text(345..500);
            if !prefix.is_empty() {
                name = format!("{prefix}/{name}");
            }
        }
        let start = at + 512;
        let data = bytes.get(start..start + size).ok_or("The tar ends early.")?;
        if matches!(header[156], 0 | b'0') {
            files.push((name, data));
        }
        at = start + size.div_ceil(512) * 512;
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zip_written_here_reads_back() {
        let files = vec![
            ("Acme.Web.nuspec".to_owned(), b"<package/>".to_vec()),
            ("lib/net8.0/Acme.Web.dll".to_owned(), "MZ".repeat(500).into_bytes()),
        ];
        let zip = crate::composer::zip(&files);
        let entries = zip_entries(&zip).unwrap();
        assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Acme.Web.nuspec", "lib/net8.0/Acme.Web.dll"]);
        assert_eq!(zip_read(&zip, &entries[0], 1024).unwrap(), b"<package/>");
        assert_eq!(zip_read(&zip, &entries[1], 4096).unwrap(), "MZ".repeat(500).into_bytes(), "deflated");
        assert!(zip_read(&zip, &entries[1], 100).is_err(), "over the limit");
        let mut damaged = zip.clone();
        damaged[30 + "Acme.Web.nuspec".len() + 2] ^= 0xFF;
        assert!(zip_read(&damaged, &entries[0], 1024).is_err(), "the CRC catches it");
        assert!(zip_entries(b"not a zip at all, but long enough").is_err());
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut out = vec![0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 3];
        out.extend_from_slice(b"metadata\0");
        out.extend_from_slice(&miniz_oxide::deflate::compress_to_vec(data, 6));
        out.extend_from_slice(&crc32(data).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out
    }

    pub fn tar(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, data) in files {
            let mut header = [0u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            let size = format!("{:011o}\0", data.len());
            header[124..136].copy_from_slice(size.as_bytes());
            header[156] = b'0';
            header[257..262].copy_from_slice(b"ustar");
            out.extend_from_slice(&header);
            out.extend_from_slice(data);
            out.resize(out.len().div_ceil(512) * 512, 0);
        }
        out.extend_from_slice(&[0; 1024]);
        out
    }

    #[test]
    fn a_gem_is_a_tar_of_gzipped_files() {
        let metadata = gzip(b"--- !ruby/object:Gem::Specification\nname: hello\n");
        let gem = tar(&[("metadata.gz", &metadata), ("data.tar.gz", b"data")]);
        let files = tar_files(&gem).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "metadata.gz");
        assert_eq!(files[1].1, b"data");
        assert_eq!(gunzip(files[0].1, 1024).unwrap(), b"--- !ruby/object:Gem::Specification\nname: hello\n");
        assert!(gunzip(b"plain text, not gzip at all", 1024).is_err());
        assert_eq!(gunzip(&super::gzip(b"specs"), 1024).unwrap(), b"specs");
        assert!(tar_files(&gem[..1538]).is_err(), "cut short");
    }
}
