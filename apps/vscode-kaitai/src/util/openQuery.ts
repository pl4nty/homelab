import { parseUint } from './parse.ts';

export interface OpenQuery {
  data: string;
  ksy?: string;
  offset?: number;
  length?: number;
}

/** Parses the query of an `/open` link. Returns an error message on bad input. */
export function parseOpenQuery(query: string): OpenQuery | string {
  const p = new URLSearchParams(query);
  const data = p.get('data');
  if (!data) return 'Kaitai link has no data= parameter';
  const num = (key: string) => (p.get(key) ? parseUint(p.get(key) as string) : undefined);
  const offset = num('offset');
  const length = num('length');
  if (Number.isNaN(offset) || Number.isNaN(length)) return 'Kaitai link has a bad offset= or length=';
  return { data, ksy: p.get('ksy') || undefined, offset, length };
}
