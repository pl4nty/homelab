// Whois over RDAP. rdap.org redirects to the RIR (ARIN, RIPE, APNIC, LACNIC, AFRINIC) that holds the IP.

type Entity = { roles?: string[]; vcardArray?: [string, [string, object, string, unknown][]]; entities?: Entity[] };
type Network = {
  handle?: string;
  name?: string;
  country?: string;
  startAddress?: string;
  endAddress?: string;
  cidr0_cidrs?: { v4prefix?: string; v6prefix?: string; length: number }[];
  entities?: Entity[];
  port43?: string;
};

const vcard = (e: Entity, key: string) => e.vcardArray?.[1].find(([k]) => k === key)?.[3];

// registrant, else the first entity with a name; ARIN networks carry the country only on the org's address
function org(entities: Entity[] = []) {
  const all = entities.flatMap((e) => [e, ...(e.entities ?? [])]);
  const e = all.find((x) => x.roles?.includes('registrant')) ?? all.find((x) => vcard(x, 'fn'));
  if (!e) return {};
  const adr = e.vcardArray?.[1].find(([k]) => k === 'adr');
  const label = (adr?.[1] as { label?: string } | undefined)?.label;
  return { org: vcard(e, 'fn') as string | undefined, address: label?.replace(/\s*\n\s*/g, ', ') };
}

// ARIN and LACNIC give only the org's postal address, ending in the country's English name or code
const names = new Intl.DisplayNames(['en'], { type: 'region' });
const codes = new Map<string, string>();
for (let a = 65; a <= 90; a++)
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    const name = names.of(code);
    if (name && name !== code) codes.set(name.toLowerCase(), code);
  }

const cache = new Map<string, Promise<unknown>>();

export function whois(ip: string) {
  if (!/^[0-9a-f.:]+$/i.test(ip)) return Promise.reject(new Error('not an IP address'));
  let hit = cache.get(ip);
  if (!hit) {
    hit = fetch(`https://rdap.org/ip/${ip}`, { headers: { Accept: 'application/rdap+json' } }).then(async (res) => {
      if (!res.ok) throw new Error(`RDAP: HTTP ${res.status}`);
      const n: Network = await res.json();
      const c = n.cidr0_cidrs?.[0];
      const { org: name, address } = org(n.entities);
      const last = address?.split(', ').pop() ?? '';
      return {
        ip,
        network: n.name,
        handle: n.handle,
        range: c ? `${c.v4prefix ?? c.v6prefix}/${c.length}` : `${n.startAddress} - ${n.endAddress}`,
        country: n.country ?? (/^[A-Z]{2}$/.test(last) ? last : codes.get(last.toLowerCase())),
        org: name,
        address,
        source: n.port43 ?? new URL(res.url).host,
      };
    });
    hit.catch(() => cache.delete(ip));
    if (cache.size > 10000) cache.clear();
    cache.set(ip, hit);
  }
  return hit;
}
