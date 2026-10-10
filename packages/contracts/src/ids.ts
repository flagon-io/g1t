const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type IdPrefix = "usr" | "ses" | "tok" | "key" | "rep" | "int" | "att" | "evt" | "dpl" | "prj" | "dom" | "dep" | "dst" | "chn" | "msg" | "agt" | "arp" | "asn" | "mem" | "rtn" | "drf" | "spc" | "pag" | "ver" | "thr" | "cmt" | "sug" | "tpl" | "fil" | "rds" | "fol" | "prp" | "ins" | "skl" | "ska" | "abr" | "mcp";

let lastMs = 0;
let lastCounter = 0;

/**
 * A new id in TypeID format (https://github.com/jetify-com/typeid): a type
 * prefix, then a UUIDv7 in lowercase Crockford base32, such as
 * `att_01jb2k7x9hfq0b3zj0f5s2m8ra`. Sorting ids as strings sorts them by
 * creation time. Must stay identical to `new_id` in crates/contracts.
 */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  // Ids made in the same millisecond count up in the 12-bit rand_a field.
  const counter =
    now === lastMs
      ? (lastCounter + 1) & 0x0fff
      : ((bytes[6] << 8) | bytes[7]) & 0x07ff;
  lastMs = now;
  lastCounter = counter;

  const time = BigInt(now);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((time >> BigInt(40 - 8 * i)) & 0xffn);
  }
  bytes[6] = 0x70 | (counter >> 8); // version 7
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // RFC 9562 variant

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let suffix = "";
  // 128 bits in 26 characters of 5 bits; the first carries only 3.
  for (let i = 0; i < 26; i++) {
    suffix += ALPHABET[Number((value >> BigInt(125 - 5 * i)) & 31n)];
  }
  return `${prefix}_${suffix}`;
}
