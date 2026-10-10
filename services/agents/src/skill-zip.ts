/**
 * Reading an uploaded skill (docs.g1t.sh/guides/agent-skills/, "Import a
 * skill"): a SKILL.md on its own, or a zip of the skill's folder. A zip
 * holding one folder (`release-notes/SKILL.md`, as zipping a folder makes
 * it) is read as that folder. Stored and deflated entries only, no zip64,
 * and never more than the format's 1 MB once unpacked.
 */
import { SKILL_FILES_MAX, SKILL_FOLDER_MAX_BYTES, type SkillFile } from "../../../packages/contracts/src/skill-format.ts";

/** The largest upload taken: a zip of a 1 MB folder is smaller than this. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export type Unpacked = { ok: true; files: SkillFile[] } | { ok: false; message: string };

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A file's content as text when it is UTF-8 without NUL bytes, else as base64. */
export function asSkillFile(path: string, bytes: Uint8Array): SkillFile {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    if (!text.includes("\u0000")) return { path, content: text, encoding: "utf8" };
  } catch {
    // Not UTF-8: kept as bytes.
  }
  return { path, content: bytesBase64(bytes), encoding: "base64" };
}

async function inflate(data: Uint8Array, size: number): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > Math.max(size, 0) || total > SKILL_FOLDER_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The files in a zip archive, by path; directories and macOS's `__MACOSX` copies left out. */
export async function unzip(bytes: Uint8Array): Promise<Unpacked> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record: the last 22 bytes, or before a comment.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return { ok: false, message: "That file isn't a zip archive." };
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count > SKILL_FILES_MAX * 2) return { ok: false, message: `A skill holds at most ${SKILL_FILES_MAX} files.` };
  const files: SkillFile[] = [];
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return { ok: false, message: "That zip archive is damaged." };
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name)) continue;
    if (flags & 1) return { ok: false, message: `${name} is encrypted. Upload a zip without a password.` };
    if (compressed === 0xffffffff || size === 0xffffffff) return { ok: false, message: "That zip archive is too large for a skill." };
    unpacked += size;
    if (unpacked > SKILL_FOLDER_MAX_BYTES) return { ok: false, message: "A skill's folder is at most 1 MB once unpacked." };
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) return { ok: false, message: "That zip archive is damaged." };
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    let content: Uint8Array;
    if (method === 0) content = data;
    else if (method === 8) {
      try {
        content = await inflate(data, size);
      } catch {
        return { ok: false, message: `${name} couldn't be unpacked.` };
      }
    } else return { ok: false, message: `${name} is packed in a way g1t can't read. Zip it again with standard compression.` };
    files.push(asSkillFile(name, content));
  }
  if (!files.length) return { ok: false, message: "That zip archive is empty." };
  // One folder holding everything: read as that folder.
  const tops = new Set(files.map((f) => (f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/")) : "")));
  if (tops.size === 1 && !tops.has("")) {
    const top = [...tops][0]!;
    return { ok: true, files: files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) })) };
  }
  return { ok: true, files };
}

/** An upload: a zip by its content, else a SKILL.md as text. */
export async function readUpload(filename: string, dataBase64: string): Promise<Unpacked> {
  let bytes: Uint8Array;
  try {
    bytes = base64Bytes(dataBase64);
  } catch {
    return { ok: false, message: "That upload couldn't be read." };
  }
  if (!bytes.length) return { ok: false, message: "That file is empty." };
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, message: "Upload at most 2 MB: a SKILL.md, or a zip of the skill's folder." };
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
  if (isZip) return unzip(bytes);
  if (!/\.(md|markdown|txt)$/i.test(filename) && filename) return { ok: false, message: "Upload a SKILL.md, or a zip of the skill's folder." };
  const file = asSkillFile("SKILL.md", bytes);
  if (file.encoding !== "utf8") return { ok: false, message: "SKILL.md must be text (UTF-8)." };
  return { ok: true, files: [file] };
}
