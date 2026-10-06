//! Content digests, and a SHA-256 whose progress can be kept between
//! requests.
//!
//! A layer arrives in as many requests as the client likes. Its digest is
//! worked out as the bytes pass, and the hasher's state is written to the
//! upload's row after each request, so finishing an upload never reads
//! the stored bytes back.

use sha2::compress256;
use sha2::digest::generic_array::GenericArray;

const BLOCK: usize = 64;
const INITIAL: [u32; 8] = [
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19,
];

/// A `sha256:<hex>` digest. Only SHA-256 is accepted: it is what every
/// client sends.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Digest(String);

impl Digest {
    pub fn parse(text: &str) -> Option<Digest> {
        let hex = text.strip_prefix("sha256:")?;
        (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            .then(|| Digest(text.to_owned()))
    }

    pub fn of(bytes: &[u8]) -> Digest {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hasher.finish()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn hex(&self) -> &str {
        &self.0["sha256:".len()..]
    }

    /// Where a blob of this digest is kept when it is stored whole.
    pub fn object_key(&self) -> String {
        format!("blobs/sha256/{}", self.hex())
    }
}

impl std::fmt::Display for Digest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// SHA-256, from its state words up, so the state can be written out
/// part way and read back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sha256 {
    state: [u32; 8],
    /// Bytes not yet a whole block.
    pending: Vec<u8>,
    /// Bytes hashed so far, `pending` included.
    length: u64,
}

impl Default for Sha256 {
    fn default() -> Self {
        Sha256::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Sha256 {
            state: INITIAL,
            pending: Vec::with_capacity(BLOCK),
            length: 0,
        }
    }

    pub fn length(&self) -> u64 {
        self.length
    }

    pub fn update(&mut self, mut bytes: &[u8]) {
        self.length += bytes.len() as u64;
        if !self.pending.is_empty() {
            let take = (BLOCK - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.pending.len() < BLOCK {
                return;
            }
            let block = GenericArray::clone_from_slice(&self.pending);
            compress256(&mut self.state, &[block]);
            self.pending.clear();
        }
        let whole = bytes.len() / BLOCK * BLOCK;
        if whole > 0 {
            let blocks: Vec<GenericArray<u8, _>> =
                bytes[..whole].as_chunks::<BLOCK>().0.iter().map(|block| GenericArray::clone_from_slice(block)).collect();
            compress256(&mut self.state, &blocks);
        }
        self.pending.extend_from_slice(&bytes[whole..]);
    }

    pub fn finish(mut self) -> Digest {
        let bits = self.length.wrapping_mul(8);
        let mut tail = std::mem::take(&mut self.pending);
        tail.push(0x80);
        while tail.len() % BLOCK != BLOCK - 8 {
            tail.push(0);
        }
        tail.extend_from_slice(&bits.to_be_bytes());
        let blocks: Vec<GenericArray<u8, _>> =
            tail.as_chunks::<BLOCK>().0.iter().map(|block| GenericArray::clone_from_slice(block)).collect();
        compress256(&mut self.state, &blocks);
        let hex: String = self.state.iter().map(|word| format!("{word:08x}")).collect();
        Digest(format!("sha256:{hex}"))
    }

    /// The state as text, for the upload's row: the eight words, the bytes
    /// pending, and the length, separated by `.`.
    pub fn save(&self) -> String {
        let words: String = self.state.iter().map(|word| format!("{word:08x}")).collect();
        format!("{words}.{}.{}", hex::encode(&self.pending), self.length)
    }

    /// The state [`save`](Self::save) wrote, or `None` if it is not one.
    pub fn restore(text: &str) -> Option<Sha256> {
        let mut parts = text.split('.');
        let (words, pending, length) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() || words.len() != 64 {
            return None;
        }
        let mut state = [0u32; 8];
        for (i, word) in state.iter_mut().enumerate() {
            *word = u32::from_str_radix(words.get(i * 8..i * 8 + 8)?, 16).ok()?;
        }
        let pending = hex::decode(pending).ok()?;
        let length: u64 = length.parse().ok()?;
        (pending.len() < BLOCK && length % BLOCK as u64 == pending.len() as u64).then_some(Sha256 {
            state,
            pending,
            length,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest as _;

    fn reference(bytes: &[u8]) -> String {
        format!("sha256:{}", hex::encode(sha2::Sha256::digest(bytes)))
    }

    #[test]
    fn matches_sha2_for_every_length_around_a_block() {
        for length in [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000] {
            let bytes: Vec<u8> = (0..length).map(|i| (i * 7 % 251) as u8).collect();
            assert_eq!(Digest::of(&bytes).as_str(), reference(&bytes), "{length}");
        }
        assert_eq!(
            Digest::of(b"").as_str(),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn the_state_survives_being_written_out_between_chunks() {
        let bytes: Vec<u8> = (0..10_000u32).map(|i| (i % 256) as u8).collect();
        let mut hasher = Sha256::new();
        for chunk in bytes.chunks(333) {
            hasher.update(chunk);
            let saved = hasher.save();
            hasher = Sha256::restore(&saved).expect("restores");
            assert_eq!(hasher.save(), saved);
        }
        assert_eq!(hasher.length(), 10_000);
        assert_eq!(hasher.finish().as_str(), reference(&bytes));
    }

    #[test]
    fn a_broken_state_is_refused() {
        assert!(Sha256::restore("").is_none());
        assert!(Sha256::restore("zz.00.1").is_none());
        let saved = Sha256::new().save();
        assert!(Sha256::restore(&saved).is_some());
        assert!(Sha256::restore(&saved.replace(".0", ".5")).is_none(), "length and pending bytes disagree");
    }

    #[test]
    fn digests_are_sha256_in_lowercase_hex() {
        let hex = "a".repeat(64);
        let digest = Digest::parse(&format!("sha256:{hex}")).unwrap();
        assert_eq!(digest.hex(), hex);
        assert_eq!(digest.object_key(), format!("blobs/sha256/{hex}"));
        assert!(Digest::parse(&format!("sha256:{}", "A".repeat(64))).is_none());
        assert!(Digest::parse(&format!("sha512:{hex}")).is_none());
        assert!(Digest::parse("sha256:abc").is_none());
    }
}
