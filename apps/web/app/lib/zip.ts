/**
 * A zip archive of files, made in memory: each file deflated when that makes
 * it smaller, stored otherwise, with UTF-8 names. Enough for downloading a
 * commit; no zip64, so the archive and each file stay under 4 GB (the caller
 * caps them far below that).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The archive of `files`, in the order given. */
export async function zip(files: { path: string; data: Uint8Array }[]): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // Sixteen files deflating at a time: quicker than one by one, without
  // every file's stream held at once.
  const deflatedAll: Uint8Array[] = new Array(files.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < files.length; index = next++) {
      const data = files[index]!.data;
      deflatedAll[index] = data.length > 0 ? await deflate(data) : data;
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, worker));
  for (const [index, file] of files.entries()) {
    const name = encoder.encode(file.path);
    const crc = crc32(file.data);
    const deflated = deflatedAll[index]!;
    const [method, body] = deflated.length < file.data.length ? [8, deflated] : [0, file.data];
    const header = (central: boolean) => {
      const out = new Uint8Array((central ? 46 : 30) + name.length);
      const view = new DataView(out.buffer);
      let at = 0;
      const u16 = (v: number) => {
        view.setUint16(at, v, true);
        at += 2;
      };
      const u32 = (v: number) => {
        view.setUint32(at, v >>> 0, true);
        at += 4;
      };
      u32(central ? 0x02014b50 : 0x04034b50);
      if (central) u16(0x031e); // made by: Unix, 3.0
      u16(20); // version needed
      u16(0x0800); // UTF-8 names
      u16(method);
      u16(0); // time
      u16(0x0021); // date: 1980-01-01
      u32(crc);
      u32(body.length);
      u32(file.data.length);
      u16(name.length);
      u16(0); // extra
      if (central) {
        u16(0); // comment
        u16(0); // disk
        u16(0); // internal attributes
        u32(0o100644 << 16);
        u32(offset);
      }
      out.set(name, at);
      return out;
    };
    const local = header(false);
    parts.push(local, body);
    central.push(header(true));
    offset += local.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
