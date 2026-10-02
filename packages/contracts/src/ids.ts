const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type IdPrefix = "usr" | "ses" | "tok" | "key" | "rep" | "int" | "att" | "evt";

/**
 * A prefixed, time-sortable id such as `att_01jb2…`: 48 bits of millisecond
 * timestamp then 80 random bits, in lowercase Crockford base32. Sorting ids
 * as strings sorts them by creation time.
 */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  let time = "";
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) {
    time = ALPHABET[t % 32] + time;
  }
  let random = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    random += ALPHABET[byte % 32];
  }
  return `${prefix}_${time}${random}`;
}
