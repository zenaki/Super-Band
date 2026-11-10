// Pembaca ZIP (store + deflate), penulis ZIP (store), dan pembaca container .sng.

async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Hasil: [{ name, size, read(): Promise<Uint8Array> }]
export function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('File ZIP tidak valid');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  const utf8 = new TextDecoder('utf-8');
  for (let i = 0; i < count && p + 46 <= bytes.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    out.push({
      name,
      size: usize,
      async read() {
        const ln = dv.getUint16(local + 26, true);
        const le = dv.getUint16(local + 28, true);
        const start = local + 30 + ln + le;
        const data = bytes.subarray(start, start + csize);
        if (method === 0) return data.slice();
        if (method === 8) return inflateRaw(data);
        throw new Error(`Kompresi ZIP metode ${method} tidak didukung`);
      },
    });
  }
  return out;
}

let crcTable = null;
function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Uint8Array }] -> Uint8Array ZIP tanpa kompresi
export function writeZip(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ name: enc.encode(f.name), data: f.data, crc: crc32(f.data) }));
  let size = 22;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  const offsets = [];
  for (const e of entries) {
    offsets.push(p);
    dv.setUint32(p, 0x04034b50, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, 0x0800, true);
    dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.data.length, true);
    dv.setUint32(p + 22, e.data.length, true);
    dv.setUint16(p + 26, e.name.length, true);
    out.set(e.name, p + 30);
    out.set(e.data, p + 30 + e.name.length);
    p += 30 + e.name.length + e.data.length;
  }
  const cdStart = p;
  entries.forEach((e, i) => {
    dv.setUint32(p, 0x02014b50, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, 20, true);
    dv.setUint16(p + 8, 0x0800, true);
    dv.setUint32(p + 16, e.crc, true);
    dv.setUint32(p + 20, e.data.length, true);
    dv.setUint32(p + 24, e.data.length, true);
    dv.setUint16(p + 28, e.name.length, true);
    dv.setUint32(p + 42, offsets[i], true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  });
  dv.setUint32(p, 0x06054b50, true);
  dv.setUint16(p + 8, entries.length, true);
  dv.setUint16(p + 10, entries.length, true);
  dv.setUint32(p + 12, p - cdStart, true);
  dv.setUint32(p + 16, cdStart, true);
  return out;
}

// Container .sng: { meta: {key: value}, files: [{ name, size, read() }] }
export function readSng(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== 'SNGPKG') throw new Error('File .sng tidak valid');
  const mask = bytes.subarray(10, 26);
  const u64 = (o) => Number(dv.getBigUint64(o, true));
  const utf8 = new TextDecoder('utf-8');
  let p = 26;
  p += 8; // panjang section metadata
  const metaCount = u64(p);
  p += 8;
  const meta = {};
  for (let i = 0; i < metaCount; i++) {
    const kl = dv.getInt32(p, true);
    const key = utf8.decode(bytes.subarray(p + 4, p + 4 + kl));
    p += 4 + kl;
    const vl = dv.getInt32(p, true);
    meta[key.toLowerCase()] = utf8.decode(bytes.subarray(p + 4, p + 4 + vl));
    p += 4 + vl;
  }
  p += 8; // panjang section index
  const fileCount = u64(p);
  p += 8;
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const nl = bytes[p];
    const name = utf8.decode(bytes.subarray(p + 1, p + 1 + nl));
    p += 1 + nl;
    const size = u64(p);
    const index = u64(p + 8);
    p += 16;
    files.push({
      name,
      size,
      async read() {
        const out = new Uint8Array(size);
        for (let k = 0; k < size; k++) out[k] = bytes[index + k] ^ mask[k & 15] ^ (k & 0xff);
        return out;
      },
    });
  }
  return { meta, files };
}
