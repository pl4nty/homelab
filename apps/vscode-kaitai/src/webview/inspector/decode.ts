// Value inspector decoding: bytes at the caret -> table rows. Pure (no DOM, no vscode), unit-tested.

export const MISSING = '-';

export interface Row {
  label: string;
  /** Little- and big-endian interpretations, or one value for byte-order independent rows. */
  le?: string;
  be?: string;
  value?: string;
}

/** Reads the first `n` bytes in both byte orders, if there are that many. */
function both(bytes: Uint8Array, n: number, read: (v: DataView, le: boolean) => unknown): { le: string; be: string } {
  if (bytes.length < n) return { le: MISSING, be: MISSING };
  const v = new DataView(bytes.buffer, bytes.byteOffset, n);
  return { le: String(read(v, true)), be: String(read(v, false)) };
}

export function formatFloat(x: number): string {
  return Object.is(x, -0) ? '-0' : String(x);
}

/** Seconds since the Unix epoch as an ISO 8601 UTC string, or `invalid` outside the Date range. */
export function formatUnixTime(seconds: number | bigint): string {
  const ms = Number(seconds) * 1000;
  return Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString().replace('.000Z', 'Z') : 'invalid';
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
  92: '\\\\',
};
const escapeCode = (c: number) =>
  NAMED[c] ?? (c > 0xff ? `\\u${c.toString(16)}` : `\\x${c.toString(16).padStart(2, '0')}`);

/** Escapes C0, DEL and C1 control characters, the line and paragraph separators and the backslash. */
export function escapeControls(s: string): string {
  return s.replace(/[\\\p{Cc}\u2028\u2029]/gu, (ch) => escapeCode(ch.charCodeAt(0)));
}

/** ASCII preview: printable bytes as is, the rest escaped. */
export function asciiPreview(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => (b >= 0x20 && b < 0x7f && b !== 0x5c ? String.fromCharCode(b) : escapeCode(b))).join(
    '',
  );
}

export function textPreview(bytes: Uint8Array, encoding: 'utf-8' | 'utf-16le' | 'utf-16be'): string {
  const n = encoding === 'utf-8' ? bytes.length : bytes.length & ~1;
  return n ? escapeControls(new TextDecoder(encoding).decode(bytes.subarray(0, n))) : MISSING;
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
    { label: 'u16', ...both(bytes, 2, (v, le) => v.getUint16(0, le)) },
    { label: 'i16', ...both(bytes, 2, (v, le) => v.getInt16(0, le)) },
    { label: 'u32', ...both(bytes, 4, (v, le) => v.getUint32(0, le)) },
    { label: 'i32', ...both(bytes, 4, (v, le) => v.getInt32(0, le)) },
    { label: 'u64', ...both(bytes, 8, (v, le) => v.getBigUint64(0, le)) },
    { label: 'i64', ...both(bytes, 8, (v, le) => v.getBigInt64(0, le)) },
    { label: 'f32', ...both(bytes, 4, (v, le) => formatFloat(v.getFloat32(0, le))) },
    { label: 'f64', ...both(bytes, 8, (v, le) => formatFloat(v.getFloat64(0, le))) },
    { label: 'unix u32', ...both(bytes, 4, (v, le) => formatUnixTime(v.getUint32(0, le))) },
    { label: 'unix i64', ...both(bytes, 8, (v, le) => formatUnixTime(v.getBigInt64(0, le))) },
    { label: 'ASCII', value: bytes.length ? asciiPreview(bytes) : MISSING },
    { label: 'UTF-8', value: textPreview(bytes, 'utf-8') },
    { label: 'UTF-16', le: textPreview(bytes, 'utf-16le'), be: textPreview(bytes, 'utf-16be') },
    { label: 'binary', value: binary(b0) },
    { label: 'selection', value: lengthText(selectionLength) },
  ];
}
