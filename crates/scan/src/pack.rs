//! Reading the objects in a git pack, as a push sends them, so that what a
//! push adds can be looked at before it is stored.
//!
//! A pushed pack is usually thin: some objects are deltas against objects
//! the repository already has. Those are left pending until the caller
//! supplies their bases with [`Pack::supply`].
//!
//! Writing is the small part g1t needs for a merge it makes itself: a pack
//! of whole objects ([`write_pack`]), or one fetched from elsewhere with a
//! few objects added ([`extend_pack`]).

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use miniz_oxide::inflate::TINFLStatus;
use miniz_oxide::inflate::core::{DecompressorOxide, decompress, inflate_flags};
use sha1::{Digest, Sha1};

/// Beyond this much content, counted as each object is in full (a delta
/// as the object it makes), the pack is not read: the work of reading
/// it, not the memory, which stays within [`CACHE_BYTES`] and the pack.
pub const MAX_INFLATED: usize = 512 * 1024 * 1024;
/// Objects kept inflated at a time, as bases for the deltas that follow
/// them. Others are inflated again from the pack when asked for.
const CACHE_BYTES: usize = 24 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectKind {
    Commit,
    Tree,
    Blob,
    Tag,
}

impl ObjectKind {
    fn from_type(code: u8) -> Option<ObjectKind> {
        Some(match code {
            1 => ObjectKind::Commit,
            2 => ObjectKind::Tree,
            3 => ObjectKind::Blob,
            4 => ObjectKind::Tag,
            _ => return None,
        })
    }

    /// The type code a pack gives objects of this kind.
    fn code(self) -> u8 {
        match self {
            ObjectKind::Commit => 1,
            ObjectKind::Tree => 2,
            ObjectKind::Blob => 3,
            ObjectKind::Tag => 4,
        }
    }

    fn name(self) -> &'static str {
        match self {
            ObjectKind::Commit => "commit",
            ObjectKind::Tree => "tree",
            ObjectKind::Blob => "blob",
            ObjectKind::Tag => "tag",
        }
    }
}

/// A git object's id: the SHA-1 of its header and content, in hex.
pub fn object_id(kind: ObjectKind, data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{} {}\0", kind.name(), data.len()).as_bytes());
    hasher.update(data);
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

enum Base {
    /// An earlier entry in the pack, by its index.
    Entry(usize),
    /// Any object, by id.
    Id(String),
}

enum State {
    /// Read, with its id known.
    Known(ObjectKind),
    /// A delta whose base is not known yet.
    Waiting,
    /// A delta that does not apply, or whose base is gone: dropped.
    Dropped,
}

/// An object read: its kind and its content, shared with the cache.
pub type Object = (ObjectKind, Rc<[u8]>);

/// One entry of the pack, read in place.
struct Entry {
    /// Where its compressed data starts.
    data: usize,
    /// Its inflated size: for a delta, the delta's.
    size: usize,
    base: Option<Base>,
    state: State,
}

/// Objects inflated lately, by entry, up to [`CACHE_BYTES`]; the first
/// kept is the first let go.
#[derive(Default)]
struct Cache {
    objects: HashMap<usize, Rc<[u8]>>,
    order: VecDeque<usize>,
    bytes: usize,
    budget: usize,
}

impl Cache {
    fn get(&self, entry: usize) -> Option<Rc<[u8]>> {
        self.objects.get(&entry).cloned()
    }

    fn keep(&mut self, entry: usize, data: Rc<[u8]>) {
        if data.len() > self.budget || self.objects.contains_key(&entry) {
            return;
        }
        while self.bytes + data.len() > self.budget {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some(gone) = self.objects.remove(&oldest) {
                self.bytes -= gone.len();
            }
        }
        self.bytes += data.len();
        self.order.push_back(entry);
        self.objects.insert(entry, data);
    }
}

/// The objects of a pack, by id. The pack is kept as it came, compressed,
/// and an object is inflated (its deltas applied) when it is asked for:
/// what is held inflated at once stays within [`CACHE_BYTES`], however
/// much the pack holds.
#[derive(Default)]
pub struct Pack {
    pack: Vec<u8>,
    entries: Vec<Entry>,
    /// Each object's entry, by id.
    ids: HashMap<String, usize>,
    /// Bases the repository supplied for a thin pack.
    supplied: HashMap<String, Object>,
    /// Commits, in the order they were read.
    commits: Vec<String>,
    cache: RefCell<Cache>,
}

/// Where the pack starts in a receive-pack request: after the commands
/// and anything else sent as pkt-lines.
pub fn pack_start(body: &[u8]) -> Option<usize> {
    let mut at = 0;
    loop {
        if body.get(at..at + 4) == Some(b"PACK") {
            return Some(at);
        }
        let length = std::str::from_utf8(body.get(at..at + 4)?)
            .ok()
            .and_then(|hex| usize::from_str_radix(hex, 16).ok())?;
        // A flush packet is four bytes; any other line counts its own length.
        at += if length == 0 { 4 } else { length.max(4) };
    }
}

fn inflate(input: &[u8], size: usize) -> Result<(Vec<u8>, usize), String> {
    let mut out = vec![0u8; size.max(1)];
    let mut state = DecompressorOxide::new();
    let flags = inflate_flags::TINFL_FLAG_PARSE_ZLIB_HEADER | inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF;
    let (status, consumed, written) = decompress(&mut state, input, &mut out, 0, flags);
    match status {
        TINFLStatus::Done => {
            out.truncate(written);
            if written != size {
                return Err(format!("an object inflated to {written} bytes, not {size}"));
            }
            Ok((out, consumed))
        }
        other => Err(format!("an object could not be inflated: {other:?}")),
    }
}

fn varint(data: &[u8], at: &mut usize) -> Option<usize> {
    let (mut value, mut shift) = (0usize, 0);
    loop {
        let byte = *data.get(*at)?;
        *at += 1;
        value |= ((byte & 0x7f) as usize) << shift;
        shift += 7;
        if byte & 0x80 == 0 || shift > 56 {
            return Some(value);
        }
    }
}

/// An entry's header in a pack: its type and its inflated size.
fn header(code: u8, size: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut byte = (code << 4) | (size & 15) as u8;
    let mut rest = size >> 4;
    while rest > 0 {
        out.push(byte | 0x80);
        byte = (rest & 0x7f) as u8;
        rest >>= 7;
    }
    out.push(byte);
    out
}

fn write_entries(pack: &mut Vec<u8>, objects: &[(ObjectKind, Vec<u8>)]) {
    for (kind, data) in objects {
        pack.extend(header(kind.code(), data.len()));
        pack.extend(miniz_oxide::deflate::compress_to_vec_zlib(data, 6));
    }
}

fn seal(mut pack: Vec<u8>) -> Vec<u8> {
    let checksum = Sha1::digest(&pack);
    pack.extend_from_slice(&checksum);
    pack
}

/// A version 2 pack holding `objects` whole, with no deltas: what git's
/// receive-pack takes, when the objects are few and new.
pub fn write_pack(objects: &[(ObjectKind, Vec<u8>)]) -> Vec<u8> {
    let mut pack = b"PACK".to_vec();
    pack.extend_from_slice(&2u32.to_be_bytes());
    pack.extend_from_slice(&(objects.len() as u32).to_be_bytes());
    write_entries(&mut pack, objects);
    seal(pack)
}

/// `pack` with `objects` added after its own, as one pack. Its entries keep
/// their offsets, since the header stays the same length, so its deltas
/// still find their bases. `pack` must not be thin.
pub fn extend_pack(pack: &[u8], objects: &[(ObjectKind, Vec<u8>)]) -> Result<Vec<u8>, String> {
    if pack.len() < 32 || &pack[..4] != b"PACK" {
        return Err("not a pack".into());
    }
    let (body, trailer) = pack.split_at(pack.len() - 20);
    if Sha1::digest(body).as_slice() != trailer {
        return Err("the pack's checksum does not match".into());
    }
    let count = u32::from_be_bytes([pack[8], pack[9], pack[10], pack[11]]) as usize;
    let total = u32::try_from(count + objects.len()).map_err(|_| "the pack is too large")?;
    let mut out = body.to_vec();
    out[8..12].copy_from_slice(&total.to_be_bytes());
    write_entries(&mut out, objects);
    Ok(seal(out))
}

/// Applies a git delta to its base.
pub fn apply_delta(base: &[u8], delta: &[u8]) -> Result<Vec<u8>, String> {
    let mut at = 0;
    let bad = || "a delta is malformed".to_owned();
    let source = varint(delta, &mut at).ok_or_else(bad)?;
    if source != base.len() {
        return Err("a delta does not fit its base".into());
    }
    let target = varint(delta, &mut at).ok_or_else(bad)?;
    let mut out = Vec::with_capacity(target);
    while at < delta.len() {
        let op = delta[at];
        at += 1;
        if op & 0x80 != 0 {
            let mut offset = 0usize;
            let mut size = 0usize;
            for bit in 0..4 {
                if op & (1 << bit) != 0 {
                    offset |= (*delta.get(at).ok_or_else(bad)? as usize) << (8 * bit);
                    at += 1;
                }
            }
            for bit in 0..3 {
                if op & (0x10 << bit) != 0 {
                    size |= (*delta.get(at).ok_or_else(bad)? as usize) << (8 * bit);
                    at += 1;
                }
            }
            if size == 0 {
                size = 0x10000;
            }
            out.extend_from_slice(base.get(offset..offset + size).ok_or_else(bad)?);
        } else if op != 0 {
            out.extend_from_slice(delta.get(at..at + op as usize).ok_or_else(bad)?);
            at += op as usize;
        } else {
            return Err(bad());
        }
    }
    if out.len() != target {
        return Err(bad());
    }
    Ok(out)
}

impl Pack {
    /// Reads every object in `pack`, resolving the deltas whose bases are
    /// in it.
    pub fn parse(pack: &[u8]) -> Result<Pack, String> {
        Pack::parse_within(pack, CACHE_BYTES)
    }

    /// [`Pack::parse`], holding at most `cache` bytes inflated.
    fn parse_within(pack: &[u8], cache: usize) -> Result<Pack, String> {
        if pack.len() < 12 || &pack[..4] != b"PACK" {
            return Err("not a pack".into());
        }
        let count = u32::from_be_bytes([pack[8], pack[9], pack[10], pack[11]]) as usize;
        let cache = RefCell::new(Cache { budget: cache, ..Cache::default() });
        let mut result = Pack { pack: pack.to_vec(), cache, ..Pack::default() };
        let mut at_offset: HashMap<usize, usize> = HashMap::new();
        let mut at = 12;
        let mut inflated = 0usize;
        for index in 0..count {
            let start = at;
            let mut byte = *pack.get(at).ok_or("the pack ends early")?;
            at += 1;
            let code = (byte >> 4) & 7;
            let mut size = (byte & 15) as usize;
            let mut shift = 4;
            while byte & 0x80 != 0 {
                byte = *pack.get(at).ok_or("the pack ends early")?;
                at += 1;
                size |= ((byte & 0x7f) as usize) << shift;
                shift += 7;
            }
            let base = match code {
                6 => {
                    let mut byte = *pack.get(at).ok_or("the pack ends early")?;
                    at += 1;
                    let mut offset = (byte & 0x7f) as usize;
                    while byte & 0x80 != 0 {
                        byte = *pack.get(at).ok_or("the pack ends early")?;
                        at += 1;
                        offset = ((offset + 1) << 7) | (byte & 0x7f) as usize;
                    }
                    let base = start.checked_sub(offset).ok_or("a delta points before the pack")?;
                    Some(Base::Entry(*at_offset.get(&base).ok_or("a delta points between objects")?))
                }
                7 => {
                    let id = pack.get(at..at + 20).ok_or("the pack ends early")?;
                    at += 20;
                    Some(Base::Id(id.iter().map(|byte| format!("{byte:02x}")).collect()))
                }
                _ => None,
            };
            let state = match base {
                Some(_) => State::Waiting,
                None => State::Known(ObjectKind::from_type(code).ok_or("an object has an unknown type")?),
            };
            let (data, consumed) = inflate(&pack[at..], size)?;
            result.entries.push(Entry { data: at, size, base, state });
            at_offset.insert(start, index);
            at += consumed;
            // Named now, while it is at hand: a whole object, or a delta
            // whose base is known; a delta whose base is not, once it is.
            inflated += match result.entries[index].state {
                State::Known(kind) => {
                    let size = data.len();
                    result.name(index, kind, data.into());
                    size
                }
                _ => result.resolve_one(index, Some(data)).unwrap_or(0),
            };
            if inflated > MAX_INFLATED {
                return Err("the pack is too large to read".into());
            }
        }
        if inflated + result.resolve() > MAX_INFLATED {
            return Err("the pack is too large to read".into());
        }
        Ok(result)
    }

    /// Records `entry` as the object `data` of `kind`, kept for the deltas
    /// that may follow it.
    fn name(&mut self, entry: usize, kind: ObjectKind, data: Rc<[u8]>) {
        let id = object_id(kind, &data);
        if kind == ObjectKind::Commit {
            self.commits.push(id.clone());
        }
        self.entries[entry].state = State::Known(kind);
        self.ids.entry(id).or_insert(entry);
        self.cache.get_mut().keep(entry, data);
    }

    /// Names the waiting delta at `entry` (inflated already when `delta`
    /// is given) if its base is known by now, and says how large the
    /// object it makes is; drops it if it does not apply. `None` while it
    /// waits.
    fn resolve_one(&mut self, entry: usize, delta: Option<Vec<u8>>) -> Option<usize> {
        match self.base_of(entry)? {
            Ok((kind, base)) => match delta.map_or_else(|| self.inflate_entry(entry), Ok).and_then(|delta| apply_delta(&base, &delta)) {
                Ok(data) => {
                    let size = data.len();
                    self.name(entry, kind, data.into());
                    Some(size)
                }
                Err(_) => {
                    self.entries[entry].state = State::Dropped;
                    Some(0)
                }
            },
            Err(()) => {
                self.entries[entry].state = State::Dropped;
                Some(0)
            }
        }
    }

    /// The base of the delta at `entry`: `None` while it is not known,
    /// `Err` when it was dropped.
    fn base_of(&self, entry: usize) -> Option<Result<Object, ()>> {
        let base = match self.entries[entry].base.as_ref()? {
            Base::Entry(base) => *base,
            Base::Id(id) => match self.supplied.get(id) {
                Some((kind, data)) => return Some(Ok((*kind, data.clone()))),
                None => *self.ids.get(id)?,
            },
        };
        match self.entries[base].state {
            State::Known(_) => Some(self.object_at(base).ok_or(())),
            State::Waiting => None,
            State::Dropped => Some(Err(())),
        }
    }

    /// Resolves every waiting delta whose base is known by now, and says
    /// how much they made.
    fn resolve(&mut self) -> usize {
        let mut made = 0;
        loop {
            let mut progress = false;
            for entry in 0..self.entries.len() {
                if matches!(self.entries[entry].state, State::Waiting)
                    && let Some(size) = self.resolve_one(entry, None)
                {
                    made += size;
                    progress = true;
                }
            }
            if !progress {
                return made;
            }
        }
    }

    /// The stored data of `entry`, inflated: for a delta, the delta.
    fn inflate_entry(&self, entry: usize) -> Result<Vec<u8>, String> {
        let entry = &self.entries[entry];
        inflate(&self.pack[entry.data..], entry.size).map(|(data, _)| data)
    }

    /// The object at a known `entry`, from the cache or inflated again
    /// from the pack: down its chain of deltas to an object at hand, then
    /// each delta applied on the way back up.
    fn object_at(&self, entry: usize) -> Option<Object> {
        let State::Known(kind) = self.entries[entry].state else { return None };
        let mut chain = Vec::new();
        let mut at = entry;
        let mut data = loop {
            if let Some(data) = self.cache.borrow().get(at) {
                break data;
            }
            match self.entries[at].base.as_ref() {
                None => break Rc::from(self.inflate_entry(at).ok()?),
                Some(base) => {
                    chain.push(at);
                    match base {
                        Base::Entry(base) => at = *base,
                        Base::Id(id) => match self.supplied.get(id) {
                            Some((_, data)) => break data.clone(),
                            None => at = *self.ids.get(id)?,
                        },
                    }
                }
            }
        };
        while let Some(delta) = chain.pop() {
            data = apply_delta(&data, &self.inflate_entry(delta).ok()?).ok()?.into();
            self.cache.borrow_mut().keep(delta, data.clone());
        }
        Some((kind, data))
    }

    /// Objects the pack's deltas are based on that it does not hold: what
    /// the repository has to supply.
    pub fn missing_bases(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .entries
            .iter()
            .filter(|entry| matches!(entry.state, State::Waiting))
            .filter_map(|entry| match &entry.base {
                Some(Base::Id(id)) if !self.contains(id) => Some(id.clone()),
                _ => None,
            })
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Supplies a base object from the repository, and resolves what
    /// depends on it.
    pub fn supply(&mut self, id: &str, kind: ObjectKind, data: Vec<u8>) {
        self.supplied.insert(id.to_owned(), (kind, data.into()));
        let _ = self.resolve();
    }

    /// Deltas still unresolved.
    pub fn unresolved(&self) -> usize {
        self.entries.iter().filter(|entry| matches!(entry.state, State::Waiting)).count()
    }

    pub fn get(&self, id: &str) -> Option<Object> {
        if let Some((kind, data)) = self.supplied.get(id) {
            return Some((*kind, data.clone()));
        }
        self.object_at(*self.ids.get(id)?)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.ids.contains_key(id) || self.supplied.contains_key(id)
    }

    /// The commits in the pack: what the push adds.
    pub fn commits(&self) -> &[String] {
        &self.commits
    }

    pub fn commit(&self, id: &str) -> Option<CommitInfo> {
        match self.get(id)? {
            (ObjectKind::Commit, data) => Some(parse_commit(&data)),
            _ => None,
        }
    }

    pub fn tree(&self, id: &str) -> Option<Vec<TreeItem>> {
        match self.get(id)? {
            (ObjectKind::Tree, data) => Some(parse_tree(&data)),
            _ => None,
        }
    }

    pub fn blob(&self, id: &str) -> Option<Rc<[u8]>> {
        match self.get(id)? {
            (ObjectKind::Blob, data) => Some(data),
            _ => None,
        }
    }

    /// What the pack's own commits and trees say the objects they name
    /// are: a commit's tree and parents, a tree's entries (submodules
    /// left out). How a missing base can be asked for as what it is.
    pub fn named_kinds(&self) -> HashMap<String, ObjectKind> {
        let mut kinds = HashMap::new();
        let read = self.ids.values().filter(|entry| matches!(self.entries[**entry].state, State::Known(ObjectKind::Commit | ObjectKind::Tree)));
        let objects = read.filter_map(|entry| self.object_at(*entry)).chain(self.supplied.values().cloned());
        for (kind, data) in objects {
            let data = &data[..];
            match kind {
                ObjectKind::Commit => {
                    let commit = parse_commit(data);
                    kinds.insert(commit.tree, ObjectKind::Tree);
                    kinds.extend(commit.parents.into_iter().map(|parent| (parent, ObjectKind::Commit)));
                }
                ObjectKind::Tree => {
                    for item in parse_tree(data) {
                        if item.is_tree() {
                            kinds.insert(item.id, ObjectKind::Tree);
                        } else if item.mode != "160000" {
                            kinds.insert(item.id, ObjectKind::Blob);
                        }
                    }
                }
                _ => {}
            }
        }
        kinds
    }
}

/// What a commit says about its place in history, and whose it is.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CommitInfo {
    pub tree: String,
    pub parents: Vec<String>,
    /// The address on the `author` line, as written.
    pub author_email: Option<String>,
    /// The address on the `committer` line, as written.
    pub committer_email: Option<String>,
}

/// The address in a signature line's value: `Name <address> 1700000000 +0000`.
fn signature_email(value: &str) -> Option<String> {
    let start = value.rfind('<')?;
    let end = start + value[start..].find('>')?;
    Some(value[start + 1..end].trim().to_owned())
}

pub fn parse_commit(data: &[u8]) -> CommitInfo {
    let text = String::from_utf8_lossy(data);
    let mut info = CommitInfo::default();
    for line in text.lines() {
        if line.is_empty() {
            break;
        }
        if let Some(tree) = line.strip_prefix("tree ") {
            info.tree = tree.trim().to_owned();
        } else if let Some(parent) = line.strip_prefix("parent ") {
            info.parents.push(parent.trim().to_owned());
        } else if let Some(author) = line.strip_prefix("author ") {
            info.author_email = signature_email(author);
        } else if let Some(committer) = line.strip_prefix("committer ") {
            info.committer_email = signature_email(committer);
        }
    }
    info
}

/// One entry of a tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeItem {
    /// `100644`, `100755`, `120000`, `40000` or `160000`.
    pub mode: String,
    pub name: String,
    pub id: String,
}

impl TreeItem {
    pub fn is_tree(&self) -> bool {
        self.mode == "40000"
    }

    /// A regular or executable file; not a link or a submodule.
    pub fn is_file(&self) -> bool {
        self.mode.starts_with("100")
    }
}

pub fn parse_tree(data: &[u8]) -> Vec<TreeItem> {
    let mut items = Vec::new();
    let mut at = 0;
    while at < data.len() {
        let Some(space) = data[at..].iter().position(|byte| *byte == b' ') else {
            break;
        };
        let Some(nul) = data[at + space..].iter().position(|byte| *byte == 0) else {
            break;
        };
        let mode = String::from_utf8_lossy(&data[at..at + space]).into_owned();
        let name = String::from_utf8_lossy(&data[at + space + 1..at + space + nul]).into_owned();
        let id_at = at + space + nul + 1;
        let Some(id) = data.get(id_at..id_at + 20) else {
            break;
        };
        items.push(TreeItem { mode, name, id: id.iter().map(|byte| format!("{byte:02x}")).collect() });
        at = id_at + 20;
    }
    items
}

/// A tree's bytes from its entries, as git writes them: what a delta
/// against a tree the repository has needs as its base.
pub fn encode_tree(items: &[TreeItem]) -> Vec<u8> {
    let mut out = Vec::new();
    for item in items {
        out.extend_from_slice(item.mode.as_bytes());
        out.push(b' ');
        out.extend_from_slice(item.name.as_bytes());
        out.push(0);
        for pair in item.id.as_bytes().chunks(2) {
            out.push(u8::from_str_radix(std::str::from_utf8(pair).unwrap_or("00"), 16).unwrap_or(0));
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use miniz_oxide::deflate::compress_to_vec_zlib;

    /// A pack of whole objects, plus ref-deltas given as (base id, delta).
    pub fn build_pack(objects: &[(ObjectKind, Vec<u8>)], ref_deltas: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut pack = b"PACK".to_vec();
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&((objects.len() + ref_deltas.len()) as u32).to_be_bytes());
        for (kind, data) in objects {
            pack.extend(header(kind.code(), data.len()));
            pack.extend(compress_to_vec_zlib(data, 6));
        }
        for (base, delta) in ref_deltas {
            pack.extend(header(7, delta.len()));
            for pair in base.as_bytes().chunks(2) {
                pack.push(u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap());
            }
            pack.extend(compress_to_vec_zlib(delta, 6));
        }
        pack.extend_from_slice(&[0u8; 20]);
        pack
    }

    /// A delta that keeps the first `keep` bytes of `base` and appends `tail`.
    pub fn delta(base: &[u8], keep: usize, tail: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let put = |mut value: usize, out: &mut Vec<u8>| loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        };
        put(base.len(), &mut out);
        put(keep + tail.len(), &mut out);
        // Copy from offset 0, `keep` bytes (one size byte).
        out.push(0x80 | 0x10);
        out.push(keep as u8);
        out.push(tail.len() as u8);
        out.extend_from_slice(tail);
        out
    }

    #[test]
    fn ids_match_git() {
        assert_eq!(object_id(ObjectKind::Blob, b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
        assert_eq!(object_id(ObjectKind::Blob, b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
    }

    #[test]
    fn whole_objects_and_deltas_are_read() {
        let base = b"first line\n".to_vec();
        let base_id = object_id(ObjectKind::Blob, &base);
        let pack = build_pack(&[(ObjectKind::Blob, base.clone())], &[(base_id.clone(), delta(&base, base.len(), b"second\n"))]);
        let parsed = Pack::parse(&pack).unwrap();
        let grown = b"first line\nsecond\n";
        assert_eq!(parsed.blob(&object_id(ObjectKind::Blob, grown)).as_deref(), Some(&grown[..]));
        assert!(parsed.missing_bases().is_empty());
    }

    #[test]
    fn a_chain_of_deltas_is_read_again_from_the_pack_once_let_go() {
        // Each version a delta on the one before; nothing stays cached, so
        // every read inflates the chain down to the whole object again.
        let mut versions = vec![b"v0\n".to_vec()];
        let mut deltas = Vec::new();
        for n in 1..6 {
            let before = versions.last().unwrap().clone();
            deltas.push((object_id(ObjectKind::Blob, &before), delta(&before, before.len(), format!("v{n}\n").as_bytes())));
            versions.push([before, format!("v{n}\n").into_bytes()].concat());
        }
        let pack = Pack::parse_within(&build_pack(&[(ObjectKind::Blob, versions[0].clone())], &deltas), 0).unwrap();
        assert_eq!(pack.unresolved(), 0);
        assert!(pack.cache.borrow().objects.is_empty());
        for version in versions.iter().rev() {
            assert_eq!(pack.blob(&object_id(ObjectKind::Blob, version)).as_deref(), Some(&version[..]));
        }
    }

    #[test]
    fn the_cache_lets_the_oldest_go_first() {
        let mut cache = Cache { budget: 8, ..Cache::default() };
        cache.keep(0, Rc::from(&b"abcd"[..]));
        cache.keep(1, Rc::from(&b"efgh"[..]));
        cache.keep(2, Rc::from(&b"ij"[..]));
        assert!(cache.get(0).is_none() && cache.get(1).is_some() && cache.get(2).is_some());
        assert_eq!(cache.bytes, 6);
        // Larger than the whole budget: not kept, nothing let go for it.
        cache.keep(3, Rc::from(&b"0123456789"[..]));
        assert!(cache.get(3).is_none() && cache.get(1).is_some());
    }

    #[test]
    fn a_thin_pack_waits_for_its_base() {
        let base = b"kept in the repository\n".to_vec();
        let base_id = object_id(ObjectKind::Blob, &base);
        let pack = build_pack(&[], &[(base_id.clone(), delta(&base, 4, b" and more\n"))]);
        let mut parsed = Pack::parse(&pack).unwrap();
        assert_eq!(parsed.missing_bases(), vec![base_id.clone()]);
        parsed.supply(&base_id, ObjectKind::Blob, base);
        assert_eq!(parsed.unresolved(), 0);
        assert!(parsed.blob(&object_id(ObjectKind::Blob, b"kept and more\n")).is_some());
    }

    #[test]
    fn a_pack_says_what_the_objects_it_names_are() {
        let blob_id = object_id(ObjectKind::Blob, b"x");
        let sub_id = "1".repeat(40);
        let module_id = "2".repeat(40);
        let tree = encode_tree(&[
            TreeItem { mode: "100644".into(), name: "a.txt".into(), id: blob_id.clone() },
            TreeItem { mode: "40000".into(), name: "src".into(), id: sub_id.clone() },
            TreeItem { mode: "160000".into(), name: "vendor".into(), id: module_id.clone() },
        ]);
        let tree_id = object_id(ObjectKind::Tree, &tree);
        let parent = "3".repeat(40);
        let commit = format!("tree {tree_id}\nparent {parent}\nauthor A <a@x> 1 +0000\n\nm\n");
        let pack = Pack::parse(&build_pack(&[(ObjectKind::Tree, tree), (ObjectKind::Commit, commit.into_bytes())], &[])).unwrap();
        let kinds = pack.named_kinds();
        assert_eq!(kinds.get(&blob_id), Some(&ObjectKind::Blob));
        assert_eq!(kinds.get(&sub_id), Some(&ObjectKind::Tree));
        assert_eq!(kinds.get(&tree_id), Some(&ObjectKind::Tree));
        assert_eq!(kinds.get(&parent), Some(&ObjectKind::Commit));
        // A submodule's commit lives in another repository.
        assert_eq!(kinds.get(&module_id), None);
    }

    #[test]
    fn commits_and_trees_are_parsed_and_trees_rebuilt() {
        let blob_id = object_id(ObjectKind::Blob, b"x");
        let tree = encode_tree(&[
            TreeItem { mode: "100644".into(), name: "a.txt".into(), id: blob_id.clone() },
            TreeItem { mode: "40000".into(), name: "src".into(), id: blob_id.clone() },
        ]);
        let items = parse_tree(&tree);
        assert_eq!(items.len(), 2);
        assert!(items[0].is_file() && items[1].is_tree());
        assert_eq!(encode_tree(&items), tree);
        let commit = format!("tree {}\nparent aaaa\nparent bbbb\nauthor x\n\nmessage\nparent no\n", object_id(ObjectKind::Tree, &tree));
        let info = parse_commit(commit.as_bytes());
        assert_eq!(info.parents, ["aaaa", "bbbb"]);
        assert_eq!(info.tree.len(), 40);
        assert_eq!(info.author_email, None);
        let signed = parse_commit(
            b"tree t
author Ada L <Ada@Example.com> 1700000000 +0000
committer Bot <bot@x.io> 1700000000 +0000

author <no@x.io>
",
        );
        assert_eq!(signed.author_email.as_deref(), Some("Ada@Example.com"));
        assert_eq!(signed.committer_email.as_deref(), Some("bot@x.io"));
        let pack = build_pack(&[(ObjectKind::Commit, commit.into_bytes())], &[]);
        assert_eq!(Pack::parse(&pack).unwrap().commits().len(), 1);
    }

    #[test]
    fn the_pack_is_found_after_the_commands() {
        let line = b"old new refs/heads/PACKAGING\0report-status\n";
        let commands = [format!("{:04x}", line.len() + 4).into_bytes(), line.to_vec(), b"0000".to_vec()].concat();
        let body = [commands.clone(), b"PACK\0\0\0\x02".to_vec()].concat();
        assert_eq!(pack_start(&body), Some(commands.len()));
        assert_eq!(pack_start(&commands), None);
        assert!(Pack::parse(b"nope").is_err());
    }

    #[test]
    fn written_packs_are_sealed_and_extend() {
        let blob = b"hello
".to_vec();
        let pack = write_pack(&[(ObjectKind::Blob, blob.clone())]);
        let (body, trailer) = pack.split_at(pack.len() - 20);
        assert_eq!(Sha1::digest(body).as_slice(), trailer);
        let more = extend_pack(&pack, &[(ObjectKind::Blob, b"more
".to_vec())]).unwrap();
        assert_eq!(&more[8..12], &2u32.to_be_bytes());
        let read = Pack::parse(&more).unwrap();
        assert!(read.blob("ce013625030ba8dba906f756967f9e9ca394464a").is_some());
        assert!(read.blob(&object_id(ObjectKind::Blob, b"more
")).is_some());
        let mut broken = pack.clone();
        broken[12] ^= 1;
        assert!(extend_pack(&broken, &[]).is_err());
    }
}
