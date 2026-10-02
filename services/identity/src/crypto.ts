// Workers cap PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;

const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pbkdf2(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      256,
    ),
  );
}

/** Format: `pbkdf2$<iterations>$<salt base64>$<hash base64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const expected = fromBase64(hash);
  const given = await pbkdf2(password, fromBase64(salt), Number(iterations));
  // Constant-time comparison.
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= given[i] ^ expected[i];
  return diff === 0;
}

/**
 * Parses an OpenSSH public key line. The fingerprint matches
 * `ssh-keygen -lf` (SHA256, unpadded base64).
 */
export async function parseSshKey(
  line: string,
): Promise<{ publicKey: string; fingerprint: string; comment: string } | null> {
  const [type, blob, ...comment] = line.trim().split(/\s+/);
  if (!/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521))$/.test(type ?? "")) {
    return null;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(blob ?? "");
    // The blob starts with its own length-prefixed copy of the key type.
    const typeLength = new DataView(bytes.buffer).getUint32(0);
    if (new TextDecoder().decode(bytes.slice(4, 4 + typeLength)) !== type) {
      return null;
    }
  } catch {
    return null;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    publicKey: `${type} ${blob}`,
    fingerprint: `SHA256:${toBase64(digest).replace(/=+$/, "")}`,
    comment: comment.join(" "),
  };
}
