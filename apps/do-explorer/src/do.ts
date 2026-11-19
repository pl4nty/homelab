// Delivery Optimization services, called the way doclient.dll 10.0.26100.6 calls them (README.md has the evidence).

const GEO = 'https://geo.prod.do.dsp.mp.microsoft.com/geo';
const CP = 'https://cp801.prod.do.dsp.mp.microsoft.com/content/';
const DISC = 'https://disc801.prod.do.dsp.mp.microsoft.com/content/';
// KV Discovery_MaxPartitionId; the client sends partitionId = clientHash % 21
export const PARTITIONS = 21;
// CAnnounceInfo::SetScopeAndGroupId: download mode 3 (Internet) = 1, 1 (LAN) = 2, 2 (Group) = 6
export const SCOPES: Record<string, number> = { internet: 1, lan: 2, group: 6 };

const json = async (res: Response) => {
  if (!res.ok) throw new Error(`${new URL(res.url).host}: HTTP ${res.status}`);
  return res.json();
};

const withQuery = (url: string, query: Record<string, string | undefined>) => {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v) u.searchParams.set(k, v);
  return u.toString();
};

export async function geo() {
  const g = await json(await fetch(GEO));
  return { geo: g, kv: await json(await fetch(g.KeyValue_EndpointFullUri)) };
}

// DO strips the query string before using a URL as AltCatalogId. The services key filestreamingservice
// files by the tlu URL FE3 hands out: the same file as a dl. or catalog.sf. URL gets an empty content
// policy or FailureReason 0x0001 from the array.
export function altCatalogId(url: string) {
  const guid = url.match(/^https?:\/\/[^/]+\/filestreamingservice\/files\/([0-9a-f-]{36})(?:[/?]|$)/i)?.[1];
  return guid
    ? `http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/${guid.toLowerCase()}`
    : url.replace(/[?#].*$/, '');
}

// CBackgroundCopyJob::_InternalCreateDownload: without a caller ContentId, the ID is SHA1(url) hex encoded
export const urlContentId = (url: string) => new Bun.CryptoHasher('sha1').update(url).digest('hex');

export const contentPolicy = (contentId: string, alt?: string) =>
  fetch(withQuery(`${CP}${encodeURIComponent(contentId)}/contentpolicy`, { altCatalogId: alt })).then(json);

export const discovery = (contentId: string, partitionId: number, alt?: string) =>
  fetch(
    withQuery(`${DISC}${encodeURIComponent(contentId)}`, { partitionId: String(partitionId), altCatalogId: alt }),
  ).then(json) as Promise<{ CollectiveArray: string; Weight: number }[]>;

export type Peer = {
  PeerId: string;
  Type: number;
  Ip: string;
  Port: number;
  Ipv6: string;
  InternalIp: string;
  ExternalIp: string;
  Ipv6Port: number;
  InternalPort: number;
  ExternalPort: number;
};

// CAnnounceInfo::ToJson. Without the dialect version (CSwarm::GetAnnounceInfo sets 10.1.0.13) the array
// answers FailureReason 0x0001. Left > 0 announces a peer that still downloads, so the array returns peers
// that have the content. JoinRequestEvent 2, sent when the swarm stops, leaves the swarm again.
const announce = (contentId: string, peerId: string, event: 1 | 2, scope: number, size: number, alt: string) =>
  JSON.stringify({
    ContentId: contentId,
    AltCatalogId: alt,
    PeerId: peerId,
    ReportedIp: '192.168.0.2',
    SubnetMask: '255.255.255.0',
    Ipv6: '',
    ClientDialectVersionMajor: 10,
    ClientDialectVersionMinor: 1,
    ClientDialectVersionBuild: 0,
    ClientDialectVersionRevision: 13,
    Uploaded: 0,
    Downloaded: 0,
    DownloadedCdn: 0,
    DownloadedDoinc: 0,
    Left: Math.max(size, 1),
    JoinRequestEvent: event,
    RestrictedUpload: 1,
    PeersWanted: 50,
    GroupId: '',
    Scope: scope,
    UploadedBPS: 0,
    DownloadedBPS: 0,
    Profile: 1,
    ReportedPort: 7680,
    Seq: event === 1 ? 0 : 1,
  });

export async function join(array: string, contentId: string, scope: number, size: number, alt: string) {
  // peer IDs in array responses are 16 random bytes then 4 zero bytes, hex encoded
  const peerId = `${crypto.randomUUID().replace(/-/g, '')}00000000`;
  const post = (event: 1 | 2) =>
    fetch(new URL('join/', array), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Microsoft-Delivery-Optimization/10.1' },
      body: announce(contentId, peerId, event, scope, size, alt),
    }).then(json);
  const response = await post(1);
  await post(2).catch(() => undefined);
  return { peerId, ...response } as { peerId: string; FailureReason: string | null; Peers: Peer[] | null };
}

// filestreamingservice files have a pieceshash beside them, whose HashOfHashes is the service's ContentId
export async function piecesHash(alt: string) {
  if (!alt.startsWith('http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/')) return undefined;
  const res = await fetch(
    `http://dl.delivery.mp.microsoft.com/filestreamingservice/files/${alt.split('/').pop()}/pieceshash`,
  );
  if (!res.ok) return undefined;
  const { Pieces, ...summary } = await res.json();
  return { ...summary, PieceCount: Pieces?.length };
}

// The client's order: content policy (which maps AltCatalogId to the service's ContentId), discovery
// (which picks the array for the partition), then the array's join, which returns the peer list.
export async function explore(opts: {
  url?: string;
  contentId?: string;
  partition: number;
  scope: number;
  size: number;
}) {
  const alt = opts.url ? altCatalogId(opts.url) : '';
  const requested = opts.contentId || (alt ? urlContentId(alt) : '');
  if (!requested) throw new Error('give a URL or a ContentId');
  const steps: Record<string, unknown> = { altCatalogId: alt || undefined, requestedContentId: requested };
  const policy = await contentPolicy(requested, alt || undefined);
  steps.contentPolicy = policy;
  const contentId: string = policy.ContentId || requested;
  steps.contentId = contentId;
  if (alt) steps.piecesHash = await piecesHash(alt).catch(() => undefined);
  try {
    steps.discovery = await discovery(contentId, opts.partition, alt || undefined);
  } catch (e) {
    return { ...steps, error: `discovery: ${(e as Error).message} (the service does not know this content)` };
  }
  const array = (steps.discovery as { CollectiveArray: string }[])[0]?.CollectiveArray;
  if (!array) return { ...steps, error: 'discovery returned no array' };
  const { Peers, ...announce } = await join(array, contentId, opts.scope, opts.size, alt);
  return { ...steps, array, announce, peers: Peers ?? [] };
}
