// Minimal tar reader/writer (ustar + PAX + GNU long names). No Node APIs, so it
// runs in the web extension host.

export type TarType = 'file' | 'hardlink' | 'symlink' | 'char' | 'block' | 'dir' | 'fifo';

export interface TarEntry {
  path: string; // normalised: no leading "./" or "/", no trailing "/"
  type: TarType;
  mode: number;
  uid: number;
  gid: number;
  uname?: string;
  gname?: string;
  mtime: number; // seconds since epoch
  linkname?: string;
  devmajor?: number;
  devminor?: number;
  data?: Uint8Array; // only for type "file"
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const typeByFlag: Record<string, TarType> = {
  '0': 'file', '\0': 'file', '7': 'file',
  '1': 'hardlink', '2': 'symlink', '3': 'char', '4': 'block', '5': 'dir', '6': 'fifo',
};
const flagByType: Record<TarType, string> = {
  file: '0', hardlink: '1', symlink: '2', char: '3', block: '4', dir: '5', fifo: '6',
};

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function readString(buf: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && buf[end] !== 0) end++;
  return dec.decode(buf.subarray(off, end));
}

function readNumber(buf: Uint8Array, off: number, len: number): number {
  if (buf[off] & 0x80) {
    // GNU base-256 encoding (positive values only).
    let n = buf[off] & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + buf[off + i];
    return n;
  }
  const s = readString(buf, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    const len = parseInt(dec.decode(data.subarray(i, sp)), 10);
    if (!len || Number.isNaN(len)) break;
    const record = dec.decode(data.subarray(sp + 1, i + len - 1));
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

function isZeroBlock(buf: Uint8Array, off: number): boolean {
  for (let i = off; i < off + 512; i++) if (buf[i] !== 0) return false;
  return true;
}

/** Parse an uncompressed tar archive. File data is copied out of `buf`. */
export function parseTar(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;

  while (off + 512 <= buf.length) {
    if (isZeroBlock(buf, off)) break;
    const h = buf.subarray(off, off + 512);
    const flag = String.fromCharCode(h[156]);
    const size = pax.size !== undefined ? Number(pax.size) : readNumber(h, 124, 12);
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (flag === 'x') { pax = { ...pax, ...parsePax(data) }; continue; }
    if (flag === 'g') continue; // global headers carry nothing we need
    if (flag === 'L') { longName = readString(data, 0, data.length); continue; }
    if (flag === 'K') { longLink = readString(data, 0, data.length); continue; }

    const magic = readString(h, 257, 6);
    let name = readString(h, 0, 100);
    if (magic.startsWith('ustar')) {
      const prefix = readString(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    name = pax.path ?? longName ?? name;
    const type = typeByFlag[flag] ?? 'file';
    const entry: TarEntry = {
      path: normalizePath(name),
      type,
      mode: readNumber(h, 100, 8) & 0o7777,
      uid: pax.uid !== undefined ? Number(pax.uid) : readNumber(h, 108, 8),
      gid: pax.gid !== undefined ? Number(pax.gid) : readNumber(h, 116, 8),
      uname: pax.uname ?? (readString(h, 265, 32) || undefined),
      gname: pax.gname ?? (readString(h, 297, 32) || undefined),
      mtime: pax.mtime !== undefined ? Math.floor(Number(pax.mtime)) : readNumber(h, 136, 12),
    };
    if (type === 'symlink' || type === 'hardlink') {
      entry.linkname = pax.linkpath ?? longLink ?? readString(h, 157, 100);
    }
    if (type === 'char' || type === 'block') {
      entry.devmajor = readNumber(h, 329, 8);
      entry.devminor = readNumber(h, 337, 8);
    }
    if (type === 'file') entry.data = data.slice();
    if (entry.path !== '') entries.push(entry);
    pax = {};
    longName = longLink = undefined;
  }
  return entries;
}

function writeString(h: Uint8Array, off: number, len: number, s: string): void {
  h.set(enc.encode(s).subarray(0, len), off);
}

function writeOctal(h: Uint8Array, off: number, len: number, n: number): void {
  writeString(h, off, len, n.toString(8).padStart(len - 1, '0') + '\0');
}

function paxRecord(key: string, value: string): string {
  // "<len> key=value\n" where <len> counts its own digits.
  const body = ` ${key}=${value}\n`;
  const bodyLen = enc.encode(body).length;
  let digits = 1;
  while (String(bodyLen + digits).length !== digits) digits++;
  return `${bodyLen + digits}${body}`;
}

function header(name: string, flag: string, size: number, e: Partial<TarEntry>): Uint8Array {
  const h = new Uint8Array(512);
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, e.mode ?? 0o644);
  writeOctal(h, 108, 8, e.uid ?? 0);
  writeOctal(h, 116, 8, e.gid ?? 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, e.mtime ?? 0);
  h.fill(0x20, 148, 156); // checksum placeholder
  h[156] = flag.charCodeAt(0);
  writeString(h, 157, 100, e.linkname ?? '');
  writeString(h, 257, 6, 'ustar\0');
  writeString(h, 263, 2, '00');
  writeString(h, 265, 32, e.uname ?? '');
  writeString(h, 297, 32, e.gname ?? '');
  writeOctal(h, 329, 8, e.devmajor ?? 0);
  writeOctal(h, 337, 8, e.devminor ?? 0);
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

function pad(size: number): Uint8Array {
  return new Uint8Array((512 - (size % 512)) % 512);
}

/** Serialise entries as an uncompressed tar archive. */
export function writeTar(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    let name = e.type === 'dir' ? `${e.path}/` : e.path;
    const link = e.linkname ?? '';
    const records: string[] = [];
    if (enc.encode(name).length > 100) records.push(paxRecord('path', name));
    if (enc.encode(link).length > 100) records.push(paxRecord('linkpath', link));
    if (records.length) {
      const body = enc.encode(records.join(''));
      chunks.push(header('PaxHeader', 'x', body.length, { mode: 0o644, mtime: e.mtime }), body, pad(body.length));
      name = name.slice(0, 100);
    }
    const data = e.type === 'file' ? e.data ?? new Uint8Array() : new Uint8Array();
    chunks.push(header(name, flagByType[e.type], data.length, { ...e, linkname: link.slice(0, 100) }), data, pad(data.length));
  }
  chunks.push(new Uint8Array(1024));
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
