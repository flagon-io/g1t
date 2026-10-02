use std::cell::Cell;

const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

thread_local! {
    /// The millisecond and counter of the last id made, to keep ids made in
    /// the same millisecond in order.
    static LAST: Cell<(u64, u16)> = const { Cell::new((0, 0)) };
}

/// A new id in [TypeID](https://github.com/jetify-com/typeid) format: a type
/// prefix, then a UUIDv7 in lowercase Crockford base32, such as
/// `att_01jb2k7x9hfq0b3zj0f5s2m8ra`.
///
/// - The prefix says what the id refers to, so ids cannot be mixed up.
/// - Sorting ids as strings sorts them by creation time, which also keeps
///   inserts at the end of the primary-key index.
/// - The suffix decodes to a standard UUIDv7 for systems that want one.
///
/// Ids made in the same millisecond by one process increase monotonically:
/// the UUID's 12-bit `rand_a` field is used as a counter.
pub fn new_id(prefix: &str, now_ms: u64) -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("no source of randomness");

    let counter = LAST.with(|last| {
        let (last_ms, last_counter) = last.get();
        let counter = if now_ms == last_ms {
            last_counter.wrapping_add(1) & 0x0fff
        } else {
            // Start in the lower half so there is room to count up.
            u16::from_be_bytes([bytes[6], bytes[7]]) & 0x07ff
        };
        last.set((now_ms, counter));
        counter
    });

    bytes[..6].copy_from_slice(&now_ms.to_be_bytes()[2..]);
    bytes[6] = 0x70 | (counter >> 8) as u8; // version 7
    bytes[7] = counter as u8;
    bytes[8] = 0x80 | (bytes[8] & 0x3f); // RFC 9562 variant

    let value = u128::from_be_bytes(bytes);
    let mut id = String::with_capacity(prefix.len() + 27);
    id.push_str(prefix);
    id.push('_');
    // 128 bits in 26 characters of 5 bits; the first carries only 3.
    for index in 0..26 {
        let shift = 125 - 5 * index;
        id.push(ALPHABET[((value >> shift) & 31) as usize] as char);
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_prefix_and_26_character_suffix() {
        let id = new_id("att", 1_790_000_000_000);
        let (prefix, suffix) = id.split_once('_').unwrap();
        assert_eq!(prefix, "att");
        assert_eq!(suffix.len(), 26);
        assert!(suffix.bytes().all(|byte| ALPHABET.contains(&byte)));
        // A 128-bit value never needs more than 3 bits in the first character.
        assert!(suffix.as_bytes()[0] <= b'7');
    }

    #[test]
    fn sorts_by_time_then_by_order_made() {
        let earlier = new_id("evt", 1_790_000_000_000);
        let later = new_id("evt", 1_790_000_000_001);
        assert!(earlier < later);

        let same_ms: Vec<String> = (0..100).map(|_| new_id("evt", 1_790_000_000_002)).collect();
        assert!(same_ms.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
