// Typed search in binary data: integers and floats in a given width and endianness, strings in an
// encoding, and hex byte patterns with `??` wildcards. Pure, so it is unit-tested directly.

export interface Needle {
  bytes: Uint8Array;
  /** Bytes that must match; a wildcard has mask 0. */
  mask?: Uint8Array;
  label: string;
}

const INT = /^([us])(1|2|4|8)(le|be)?$/;
const FLOAT = /^f(4|8)(le|be)?$/;

/**
 * Parses a query:
 * - `u4le 1234`, `s2be -1`, `u8 0x10` (endianness defaults to `defaultEndian`)
 * - `f4 1.5`, `f8be 3.14`
 * - `"text"` (UTF-8), `utf-16le "text"`, `ascii "text"`
 * - `89 50 4e 47`, `ff??d8`, `0xFFD8`
 */
export function parseNeedle(query: string, defaultEndian: 'le' | 'be' = 'le'): Needle | string {
  const q = query.trim();
  const typed = /^(\S+)\s+(.+)$/.exec(q);
  if (typed) {
    const [, type, value] = typed;
    const t = type.toLowerCase();
    let m = INT.exec(t);
    if (m) {
      const size = Number(m[2]);
      const le = (m[3] ?? defaultEndian) === 'le';
      let n: bigint;
      try {
        const v = value.trim();
        n = v.startsWith('-') ? -BigInt(v.slice(1)) : BigInt(v);
      } catch {
        return `Not an integer: ${value}`;
      }
      const bits = BigInt(size * 8);
      const min = m[1] === 's' ? -(1n << (bits - 1n)) : 0n;
      const max = m[1] === 's' ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
      if (n < min || n > max) return `${value} does not fit in ${t}`;
      if (n < 0) n += 1n << bits;
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[le ? i : size - 1 - i] = Number((n >> BigInt(8 * i)) & 0xffn);
      return { bytes, label: `${t}${m[3] ? '' : defaultEndian} ${value.trim()}` };
    }
    m = FLOAT.exec(t);
    if (m) {
      const size = Number(m[1]);
      const le = (m[2] ?? defaultEndian) === 'le';
      const f = Number(value);
      if (Number.isNaN(f) && value.trim().toLowerCase() !== 'nan') return `Not a number: ${value}`;
      const bytes = new Uint8Array(size);
      const dv = new DataView(bytes.buffer);
      if (size === 4) dv.setFloat32(0, f, le);
      else dv.setFloat64(0, f, le);
      return { bytes, label: `${t}${m[2] ? '' : defaultEndian} ${value.trim()}` };
    }
    const str = /^(["'])(.*)\1$/s.exec(value.trim());
    if (str) {
      const enc = t.replace(/[-_]/g, '');
      if (enc === 'utf16le' || enc === 'utf16be') {
        const s = unescapeText(str[2]);
        const bytes = new Uint8Array(s.length * 2);
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          bytes[2 * i + (enc === 'utf16le' ? 0 : 1)] = c & 0xff;
          bytes[2 * i + (enc === 'utf16le' ? 1 : 0)] = c >> 8;
        }
        return { bytes, label: `${type} ${value.trim()}` };
      }
      if (enc === 'utf8' || enc === 'ascii')
        return { bytes: new TextEncoder().encode(unescapeText(str[2])), label: `${type} ${value.trim()}` };
      return `Unsupported encoding: ${type}`;
    }
  }
  const str = /^(["'])(.*)\1$/s.exec(q);
  if (str) return { bytes: new TextEncoder().encode(unescapeText(str[2])), label: q };
  const hex = q.replace(/^0x/i, '').replace(/[\s,]+/g, '');
  if (/^([0-9a-f]{2}|\?\?)+$/i.test(hex)) {
    const n = hex.length / 2;
    const bytes = new Uint8Array(n);
    const mask = new Uint8Array(n);
    let wild = false;
    for (let i = 0; i < n; i++) {
      const pair = hex.slice(2 * i, 2 * i + 2);
      if (pair === '??') wild = true;
      else {
        bytes[i] = Number.parseInt(pair, 16);
        mask[i] = 0xff;
      }
    }
    return { bytes, mask: wild ? mask : undefined, label: q };
  }
  return 'Use e.g. u4le 1234, f4 1.5, "text", utf-16le "text", or hex bytes like 89 50 ?? 47';
}

function unescapeText(s: string) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|n|r|t|0|\\|"|')/g, (_, e: string) =>
    e[0] === 'x'
      ? String.fromCharCode(Number.parseInt(e.slice(1), 16))
      : (({ n: '\n', r: '\r', t: '\t', '0': '\0' } as Record<string, string>)[e] ?? e),
  );
}

/** Offsets of all matches (overlapping allowed), up to `limit`. */
export function findAll(data: Uint8Array, needle: Needle, limit = 1000, from = 0): number[] {
  const { bytes, mask } = needle;
  const n = bytes.length;
  const out: number[] = [];
  if (!n) return out;
  const first = mask ? -1 : bytes[0];
  outer: for (let i = from; i + n <= data.length; i++) {
    if (first >= 0) {
      i = data.indexOf(first, i);
      if (i < 0 || i + n > data.length) break;
    }
    for (let j = first >= 0 ? 1 : 0; j < n; j++) {
      if (mask ? (data[i + j] & mask[j]) !== bytes[j] : data[i + j] !== bytes[j]) continue outer;
    }
    out.push(i);
    if (out.length >= limit) break;
  }
  return out;
}
