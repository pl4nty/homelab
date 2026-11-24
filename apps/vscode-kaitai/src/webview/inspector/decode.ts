// Value inspector decoding: bytes at the caret -> table rows. Pure (no DOM, no vscode), unit-tested.

export const MISSING = '-';

export interface Row {
  label: string;
  /** Little- and big-endian interpretations, or one value for byte-order independent rows. */
  le?: string;
  be?: string;
  value?: string;
  /** Monospace and left aligned (strings, bits) rather than numbers. */
  text?: boolean;
}

function view(bytes: Uint8Array, n: number): DataView | undefined {
  return bytes.length >= n ? new DataView(bytes.buffer, bytes.byteOffset, n) : undefined;
}

function both(bytes: Uint8Array, n: number, read: (v: DataView, le: boolean) => string): { le: string; be: string } {
  const v = view(bytes, n);
  return v ? { le: read(v, true), be: read(v, false) } : { le: MISSING, be: MISSING };
}

export function formatFloat(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Number.POSITIVE_INFINITY) return 'Infinity';
  if (x === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(x, -0)) return '-0';
  return String(x);
}

/** Seconds since the Unix epoch as an ISO 8601 UTC string, or `invalid` outside the Date range. */
export function formatUnixTime(seconds: number | bigint): string {
  const s = Number(seconds);
  if (!Number.isFinite(s) || Math.abs(s) > 8.64e12) return 'invalid';
  return new Date(s * 1000).toISOString().replace('.000Z', 'Z');
}

const NAMED: Record<number, string> = {
  0: '\\0',
  7: '\\a',
  8: '\\b',
  9: '\\t',
  10: '\\n',
  11: '\\v',
  12: '\\f',
  13: '\\r',
  27: '\\e',
};
const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** Escapes C0, DEL and C1 control characters and the backslash. */
export function escapeControls(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x5c) out += '\\\\';
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0)) out += NAMED[c] ?? `\\x${hex2(c)}`;
    else if (c === 0x2028 || c === 0x2029) out += `\\u${c.toString(16)}`;
    else out += ch;
  }
  return out;
}

/** ASCII preview: printable bytes as is, the rest escaped. */
export function asciiPreview(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes)
    out += b >= 0x20 && b < 0x7f ? (b === 0x5c ? '\\\\' : String.fromCharCode(b)) : (NAMED[b] ?? `\\x${hex2(b)}`);
  return out;
}

export function textPreview(bytes: Uint8Array, encoding: 'utf-8' | 'utf-16le' | 'utf-16be'): string {
  const n = encoding === 'utf-8' ? bytes.length : bytes.length & ~1;
  if (!n) return MISSING;
  return escapeControls(new TextDecoder(encoding, { fatal: false }).decode(bytes.subarray(0, n)));
}

export function binary(b: number | undefined): string {
  if (b === undefined) return MISSING;
  const s = b.toString(2).padStart(8, '0');
  return `${s.slice(0, 4)} ${s.slice(4)}`;
}

export function lengthText(n: number): string {
  return `0x${n.toString(16).toUpperCase()} (${n})`;
}

/** Builds the inspector table for `bytes` (starting at the caret) and the selection length. */
export function decode(bytes: Uint8Array, selectionLength: number): Row[] {
  const b0 = bytes.length ? bytes[0] : undefined;
  return [
    { label: 'u8', value: b0 === undefined ? MISSING : String(b0) },
    { label: 'i8', value: b0 === undefined ? MISSING : String((b0 << 24) >> 24) },
    { label: 'u16', ...both(bytes, 2, (v, le) => String(v.getUint16(0, le))) },
    { label: 'i16', ...both(bytes, 2, (v, le) => String(v.getInt16(0, le))) },
    { label: 'u32', ...both(bytes, 4, (v, le) => String(v.getUint32(0, le))) },
    { label: 'i32', ...both(bytes, 4, (v, le) => String(v.getInt32(0, le))) },
    { label: 'u64', ...both(bytes, 8, (v, le) => v.getBigUint64(0, le).toString()) },
    { label: 'i64', ...both(bytes, 8, (v, le) => v.getBigInt64(0, le).toString()) },
    { label: 'f32', ...both(bytes, 4, (v, le) => formatFloat(v.getFloat32(0, le))) },
    { label: 'f64', ...both(bytes, 8, (v, le) => formatFloat(v.getFloat64(0, le))) },
    { label: 'unix u32', ...both(bytes, 4, (v, le) => formatUnixTime(v.getUint32(0, le))) },
    { label: 'unix i64', ...both(bytes, 8, (v, le) => formatUnixTime(v.getBigInt64(0, le))) },
    { label: 'ASCII', value: bytes.length ? asciiPreview(bytes) : MISSING, text: true },
    { label: 'UTF-8', value: textPreview(bytes, 'utf-8'), text: true },
    { label: 'UTF-16', le: textPreview(bytes, 'utf-16le'), be: textPreview(bytes, 'utf-16be'), text: true },
    { label: 'binary', value: binary(b0), text: true },
    { label: 'selection', value: lengthText(selectionLength) },
  ];
}
