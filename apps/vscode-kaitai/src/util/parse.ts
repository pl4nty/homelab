// Pure parsers for user input. No vscode import, so they are unit-tested directly.

/** Parses `0x10`, `16`, `0x10-0x20` (inclusive end), `0x10+16` (length). End is exclusive. */
export function parseRange(text: string, size: number): { start: number; end: number } | undefined {
  const num = (s: string) => {
    s = s.trim();
    if (!s) return Number.NaN;
    return /^0x[0-9a-f]+$/i.test(s) ? Number.parseInt(s, 16) : /^\d+$/.test(s) ? Number(s) : Number.NaN;
  };
  const m = /^\s*([^-+]+?)\s*(?:([-+])\s*(.+))?$/.exec(text);
  if (!m) return undefined;
  const start = num(m[1]);
  if (!Number.isFinite(start) || start < 0 || start > size) return undefined;
  if (!m[2]) return { start, end: start };
  const v = num(m[3]);
  if (!Number.isFinite(v)) return undefined;
  const end = m[2] === '+' ? start + v : v + 1;
  if (end < start || end > size) return undefined;
  return { start, end };
}

export const INVALID = Symbol('invalid');

/** Parses a param value typed by the user, guided by the param's declared type. */
export function parseParamValue(text: string, type?: string): unknown {
  const t = text.trim();
  if (type === 'bool' || t === 'true' || t === 'false') return t === 'true' ? true : t === 'false' ? false : INVALID;
  if (/^\[.*\]$/s.test(t)) {
    const parts = t
      .slice(1, -1)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const bytes = parts.map((x) =>
      /^0x[0-9a-f]+$/i.test(x) ? Number.parseInt(x, 16) : /^\d+$/.test(x) ? Number(x) : Number.NaN,
    );
    return bytes.every((b) => b >= 0 && b <= 255) ? new Uint8Array(bytes) : INVALID;
  }
  if (/^(["']).*\1$/s.test(t)) return t.slice(1, -1);
  if (type === 'str' || type === 'strz') return t;
  if (/^-?0x[0-9a-f]+$/i.test(t) || /^-?\d+$/.test(t)) {
    const neg = t.startsWith('-');
    const big = BigInt(neg ? t.slice(1) : t) * (neg ? -1n : 1n);
    // The JS runtime reads u8/s8 as Number when safe, so pass Numbers where possible.
    return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
  }
  if (/^-?\d*\.\d+(e-?\d+)?$/i.test(t)) return Number(t);
  return INVALID;
}
