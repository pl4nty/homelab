// Format gallery listing: endpoints, response parsing and grouping. No vscode imports (unit-tested).

/** A .ksy file in the gallery repository. `path` is relative to the repo root, with `.ksy`. */
export interface GalleryEntry {
  path: string;
  /** Top-level folder, or '' for files in the repo root. */
  category: string;
  /** File name without `.ksy`. */
  name: string;
}

export interface GalleryCategory {
  name: string;
  entries: GalleryEntry[];
}

export function gitTreeUrl(repo: string, ref: string) {
  return `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
}

export function rawUrl(repo: string, ref: string, path: string) {
  return `https://raw.githubusercontent.com/${repo}/${ref}/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
}

/** Same file through the contents API, which vscode.dev's CSP allows (raw.githubusercontent.com is blocked there). */
export function contentsUrl(repo: string, ref: string, path: string) {
  const file = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`;
}

/**
 * Downloads a repository file: raw.githubusercontent.com first (no rate limit), then the contents API when the raw
 * request fails before a response (CSP or network block). Undefined on 404.
 */
export async function fetchRepoFile(repo: string, ref: string, path: string, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(rawUrl(repo, ref, path), { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    res = await fetch(contentsUrl(repo, ref, path), { headers: { Accept: 'application/vnd.github.raw' }, signal });
  }
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Turns repo-relative paths into sorted entries, keeping only `.ksy` files outside hidden/underscore folders. */
export function toEntries(paths: Iterable<string>): GalleryEntry[] {
  const out = new Map<string, GalleryEntry>();
  for (const raw of paths) {
    const path = raw.replace(/^\/+/, '');
    // Folders starting with `_` or `.` hold no user-facing formats.
    if (!/\.ksy$/i.test(path) || /(^|\/)[_.]/.test(path)) continue;
    const parts = path.split('/');
    out.set(path, { path, category: parts.length > 1 ? parts[0] : '', name: parts[parts.length - 1].slice(0, -4) });
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Parses `GET /repos/{repo}/git/trees/{ref}?recursive=1`. Throws (with the API's message, if any) on another shape. */
export function parseGitTree(json: unknown): { entries: GalleryEntry[]; truncated: boolean } {
  const { tree, truncated, message } = (json ?? {}) as { tree?: unknown; truncated?: unknown; message?: unknown };
  if (!Array.isArray(tree)) {
    throw new Error(typeof message === 'string' ? message : 'Unexpected response from the GitHub tree API');
  }
  const paths = tree.filter((t) => typeof t?.path === 'string' && t.type === 'blob').map((t) => t.path as string);
  return { entries: toEntries(paths), truncated: !!truncated };
}

/** Lists the repository through the GitHub tree API (CORS-enabled; 60 requests an hour per IP without a token). */
export async function fetchGitTree(repo: string, ref: string, token?: string, signal?: AbortSignal) {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(gitTreeUrl(repo, ref), { headers, signal });
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok && typeof (json as { message?: unknown } | undefined)?.message !== 'string') {
    throw new Error(`HTTP ${res.status}`);
  }
  return parseGitTree(json);
}

/** Groups entries by top-level folder; root-level files go into a category named ''. */
export function groupByCategory(entries: readonly GalleryEntry[]): GalleryCategory[] {
  const map = new Map<string, GalleryEntry[]>();
  for (const e of entries) {
    const list = map.get(e.category);
    if (list) list.push(e);
    else map.set(e.category, [e]);
  }
  return [...map]
    .map(([name, list]) => ({
      name,
      entries: list.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
