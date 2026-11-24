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
  const num = (k: string) => {
    const v = p.get(k);
    if (v === null || v === '') return undefined;
    const n = /^0x[0-9a-f]+$/i.test(v) ? Number.parseInt(v, 16) : /^\d+$/.test(v) ? Number(v) : Number.NaN;
    return n;
  };
  const offset = num('offset');
  const length = num('length');
  if (Number.isNaN(offset) || Number.isNaN(length)) return 'Kaitai link has a bad offset= or length=';
  return { data, ksy: p.get('ksy') || undefined, offset, length };
}
