/**
 * A gzipped tar archive of files, made in memory, as `git archive` makes
 * one: POSIX ustar headers, a pax global header carrying the commit
 * (`comment=<sha>`, which `git get-tar-commit-id` reads), a directory
 * entry before each folder's files, executable files and symlinks kept as
 * they are in git, and a pax extended header for a path or link target too
 * long for ustar. Everything is owned by root and dated by the commit.
 * Enough for downloading a commit: each file stays under 8 GB (the caller
 * caps them far below that).
 */

export type TarEntry = {
  /** The path in the archive, folders separated by `/`. */
  path: string;
  /** The file's bytes; for a symlink, where it points. */
  data: Uint8Array;
  kind?: "blob" | "exec" | "symlink";
};

export type TarOptions = {
  /** Seconds since the epoch, what every entry is dated. */
  mtime: number;
  /** The commit, kept in a pax global header as `git archive` keeps it. */
  comment?: string;
};

const BLOCK = 512;
const encoder = new TextEncoder();

/** `git archive`'s modes, with its default umask of 002. */
const MODES = { blob: 0o664, exec: 0o775, symlink: 0o777, dir: 0o775 } as const;

/** `value` in octal, zero-padded to fill `width` bytes with a NUL at the end. */
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function put(header: Uint8Array, at: number, width: number, value: string | Uint8Array) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  header.set(bytes.subarray(0, width), at);
}

/**
 * `path` as ustar's `name` (100 bytes) and `prefix` (155), split at a
 * slash; null when it does not fit.
 */
export function splitPath(path: Uint8Array): { name: Uint8Array; prefix: Uint8Array } | null {
  if (path.length <= 100) return { name: path, prefix: new Uint8Array() };
  // The last slash that leaves at most 100 bytes after it and 155 before.
  for (let at = Math.min(path.length - 1, 155); at > 0; at--) {
    if (path[at] !== 0x2f) continue;
    if (path.length - at - 1 > 100) return null;
    if (path.length - at - 1 === 0) continue;
    return { name: path.subarray(at + 1), prefix: path.subarray(0, at) };
  }
  return null;
}

type Header = { name: Uint8Array; prefix?: Uint8Array; mode: number; size: number; mtime: number; type: string; link?: Uint8Array };

function header(entry: Header): Uint8Array {
  const out = new Uint8Array(BLOCK);
  put(out, 0, 100, entry.name);
  put(out, 100, 8, octal(entry.mode, 8));
  put(out, 108, 8, octal(0, 8));
  put(out, 116, 8, octal(0, 8));
  put(out, 124, 12, octal(entry.size, 12));
  put(out, 136, 12, octal(entry.mtime, 12));
  put(out, 148, 8, "        ");
  put(out, 156, 1, entry.type);
  if (entry.link) put(out, 157, 100, entry.link);
  put(out, 257, 6, "ustar\0");
  put(out, 263, 2, "00");
  put(out, 265, 32, "root");
  put(out, 297, 32, "root");
  put(out, 329, 8, octal(0, 8));
  put(out, 337, 8, octal(0, 8));
  if (entry.prefix) put(out, 345, 155, entry.prefix);
  let sum = 0;
  for (const byte of out) sum += byte;
  put(out, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return out;
}

/** One pax record, `<length> <key>=<value>\n`, its length counting itself. */
export function paxRecord(key: string, value: Uint8Array): Uint8Array {
  const rest = encoder.encode(` ${key}=`).length + value.length + 1;
  let length = rest + String(rest).length;
  if (String(length).length !== String(rest).length) length = rest + String(length).length;
  const out = new Uint8Array(length);
  const head = encoder.encode(`${length} ${key}=`);
  out.set(head);
  out.set(value, head.length);
  out[length - 1] = 0x0a;
  return out;
}

function padded(data: Uint8Array): Uint8Array[] {
  const rest = data.length % BLOCK;
  return rest === 0 ? [data] : [data, new Uint8Array(BLOCK - rest)];
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The tar archive of `entries` (uncompressed), each folder's entry before its files. */
export function tar(entries: TarEntry[], options: TarOptions): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const mtime = Math.max(0, Math.floor(options.mtime));
  if (options.comment) {
    const record = paxRecord("comment", encoder.encode(options.comment));
    parts.push(header({ name: encoder.encode("pax_global_header"), mode: 0o666, size: record.length, mtime, type: "g" }), ...padded(record));
  }
  const add = (path: string, kind: "blob" | "exec" | "symlink" | "dir", data: Uint8Array) => {
    const fullPath = encoder.encode(kind === "dir" ? `${path}/` : path);
    const link = kind === "symlink" ? data : undefined;
    const body = kind === "blob" || kind === "exec" ? data : new Uint8Array();
    const split = splitPath(fullPath);
    const records: Uint8Array[] = [];
    if (!split) records.push(paxRecord("path", fullPath));
    if (link && link.length > 100) records.push(paxRecord("linkpath", link));
    if (records.length > 0) {
      const pax = concat(records);
      const name = encoder.encode("././@PaxHeader");
      parts.push(header({ name, mode: 0o666, size: pax.length, mtime, type: "x" }), ...padded(pax));
    }
    const type = kind === "dir" ? "5" : kind === "symlink" ? "2" : "0";
    parts.push(
      header({
        name: split?.name ?? fullPath.subarray(0, 100),
        prefix: split?.prefix,
        mode: MODES[kind],
        size: body.length,
        mtime,
        type,
        link: link && link.length <= 100 ? link : link?.subarray(0, 100),
      }),
    );
    if (body.length > 0) parts.push(...padded(body));
  };
  const folders = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    for (let depth = 1; depth < segments.length; depth++) {
      const folder = segments.slice(0, depth).join("/");
      if (folders.has(folder)) continue;
      folders.add(folder);
      add(folder, "dir", new Uint8Array());
    }
    add(segments.join("/"), entry.kind ?? "blob", entry.data);
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return concat(parts);
}

/** {@link tar}, gzipped. */
export async function tarGz(entries: TarEntry[], options: TarOptions): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([tar(entries, options)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
