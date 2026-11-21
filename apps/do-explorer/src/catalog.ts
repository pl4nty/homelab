// Microsoft Update Catalog. It has no JSON API, so this scrapes the pages the website uses.
// Ported from apps/winget-proxy/src/WinGet.RestSource/Updates/UpdateCatalog.cs.

const BASE = 'https://www.catalog.update.microsoft.com/';

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(
      /&(amp|lt|gt|quot|nbsp|#39);/g,
      (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" })[e as string]!,
    )
    .replace(/\s+/g, ' ')
    .trim();

export async function searchCatalog(query: string) {
  const res = await fetch(`${BASE}Search.aspx?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Update Catalog search: HTTP ${res.status}`);
  const html = await res.text();
  return [
    ...html.matchAll(/<tr id="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_R\d+">([\s\S]*?)<\/tr>/gi),
  ].map(([, id, row]) => {
    const cells = Object.fromEntries(
      [...row.matchAll(/<td[^>]*id="[0-9a-f-]{36}_C(\d+)_R\d+"[^>]*>([\s\S]*?)<\/td>/gi)].map(([, c, v]) => [
        c,
        text(v),
      ]),
    );
    return {
      updateId: id.toLowerCase(),
      title: cells[1],
      products: cells[2],
      classification: cells[3],
      lastUpdated: cells[4],
      size: cells[6],
    };
  });
}

// Large cumulative updates often carry only the base64 SHA-1 digest, with an empty sha256.
export async function catalogFiles(updateId: string) {
  const res = await fetch(`${BASE}DownloadDialog.aspx`, {
    method: 'POST',
    body: new URLSearchParams({
      updateIDs: JSON.stringify([{ size: 0, languages: '', uidInfo: updateId, updateID: updateId }]),
    }),
  });
  if (!res.ok) throw new Error(`Update Catalog download dialog: HTTP ${res.status}`);
  const files = new Map<string, Record<string, string>>();
  for (const [, i, key, value] of (await res.text()).matchAll(
    /files\[(\d+)\]\.(url|fileName|sha256|digest) = '([^']*)'/g,
  )) {
    files.set(i, { ...files.get(i), [key]: value });
  }
  return [...files.values()]
    .filter((f) => f.url)
    .map((f) => ({
      url: f.url,
      name: f.fileName || f.url.split('/').pop()!,
      sha256: f.sha256 || undefined,
      sha1: f.digest || undefined,
    }));
}
