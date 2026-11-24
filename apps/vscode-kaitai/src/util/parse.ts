// Pure parsers for user input. No vscode import, so they are unit-tested directly.

/** Parses `16` or `0x10`. Anything else is NaN. */
export function parseUint(text: string): number {
  return /^(0x[0-9a-f]+|\d+)$/i.test(text) ? Number(text) : Number.NaN;
}

/** Parses `0x10`, `16`, `0x10-0x20` (inclusive end), `0x10+16` (length). End is exclusive. */
export function parseRange(text: string, size: number): { start: number; end: number } | undefined {
  const m = /^([^-+]+)(?:([-+])(.+))?$/.exec(text);
  if (!m) return undefined;
  const start = parseUint(m[1].trim());
  const operand = m[2] ? parseUint(m[3].trim()) : 0;
  const end = m[2] === '-' ? operand + 1 : start + operand;
  // NaN fails every comparison.
  return start <= end && end <= size ? { start, end } : undefined;
}

export const INVALID = Symbol('invalid');

/** Parses a param value typed by the user, guided by the param's declared type. */
export function parseParamValue(text: string, type?: string): unknown {
  const t = text.trim();
  if (type === 'bool' || t === 'true' || t === 'false') return t === 'true' ? true : t === 'false' ? false : INVALID;
  if (/^\[.*\]$/s.test(t)) {
    const bytes = t
      .slice(1, -1)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map(parseUint);
    return bytes.every((b) => b <= 255) ? new Uint8Array(bytes) : INVALID;
  }
  if (/^(["']).*\1$/s.test(t)) return t.slice(1, -1);
  if (type === 'str' || type === 'strz') return t;
  if (/^-?(0x[0-9a-f]+|\d+)$/i.test(t)) {
    const neg = t.startsWith('-');
    const big = BigInt(neg ? t.slice(1) : t) * (neg ? -1n : 1n);
    // The JS runtime reads u8/s8 as Number when safe, so pass Numbers where possible.
    return Number.isSafeInteger(Number(big)) ? Number(big) : big;
  }
  if (/^-?\d*\.\d+(e-?\d+)?$/i.test(t)) return Number(t);
  return INVALID;
}
