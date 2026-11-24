// Format gallery listing: endpoints, response parsers and grouping. No vscode imports (unit-tested).

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

/** Folders that hold no user-facing formats. */
const IGNORED_PREFIXES = ['_', '.'];

export function gitTreeUrl(repo: string, ref: string) {
  return `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
}

export function jsdelivrListUrl(repo: string, ref: string) {
  return `https://data.jsdelivr.com/v1/packages/gh/${repo}@${encodeURIComponent(ref)}?structure=flat`;
}

export function rawUrls(repo: string, ref: string, path: string): string[] {
  const p = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return [`https://raw.githubusercontent.com/${repo}/${ref}/${p}`, `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${p}`];
}

/** Turns repo-relative paths into sorted entries, keeping only `.ksy` files outside hidden/underscore folders. */
export function toEntries(paths: Iterable<string>): GalleryEntry[] {
  const seen = new Set<string>();
  const out: GalleryEntry[] = [];
  for (const raw of paths) {
    const path = raw.replace(/^\/+/, '');
    if (!path.toLowerCase().endsWith('.ksy') || seen.has(path)) continue;
    const parts = path.split('/');
    if (parts.some((p) => IGNORED_PREFIXES.some((x) => p.startsWith(x)))) continue;
    seen.add(path);
    const file = parts[parts.length - 1];
    out.push({ path, category: parts.length > 1 ? parts[0] : '', name: file.slice(0, -4) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Parses `GET /repos/{repo}/git/trees/{ref}?recursive=1`. Throws on an unexpected shape. */
export function parseGitTree(json: unknown): { entries: GalleryEntry[]; truncated: boolean } {
  const tree = (json as { tree?: unknown })?.tree;
  if (!Array.isArray(tree)) {
    const message = (json as { message?: unknown })?.message;
    throw new Error(typeof message === 'string' ? message : 'Unexpected response from the GitHub tree API');
  }
  const paths = tree
    .filter((t): t is { path: string; type: string } => typeof t?.path === 'string' && t.type === 'blob')
    .map((t) => t.path);
  return { entries: toEntries(paths), truncated: !!(json as { truncated?: boolean }).truncated };
}

/** Parses jsDelivr `GET /v1/packages/gh/{repo}@{ref}?structure=flat` (`files[].name` start with `/`). */
export function parseJsdelivrFlat(json: unknown): GalleryEntry[] {
  const files = (json as { files?: unknown })?.files;
  if (!Array.isArray(files)) {
    const message = (json as { message?: unknown })?.message;
    throw new Error(typeof message === 'string' ? message : 'Unexpected response from jsDelivr');
  }
  return toEntries(files.filter((f) => typeof f?.name === 'string').map((f: { name: string }) => f.name));
}

/** Groups entries by top-level folder; root-level files go into a category named ''. */
export function groupByCategory(entries: readonly GalleryEntry[]): GalleryCategory[] {
  const map = new Map<string, GalleryEntry[]>();
  for (const e of entries) {
    let list = map.get(e.category);
    if (!list) map.set(e.category, (list = []));
    list.push(e);
  }
  return [...map]
    .map(([name, list]) => ({
      name,
      entries: list.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface CachedListing {
  repo: string;
  ref: string;
  /** ms since epoch. */
  fetchedAt: number;
  paths: string[];
  source: 'github' | 'jsdelivr';
}

export const LISTING_TTL_MS = 24 * 60 * 60 * 1000;

export function isFresh(cache: CachedListing | undefined, repo: string, ref: string, now: number) {
  return !!cache && cache.repo === repo && cache.ref === ref && now - cache.fetchedAt < LISTING_TTL_MS;
}
