// Reads the bits of a .ksy that the gallery needs and resolves import paths. No vscode imports.
import { parse } from 'yaml';

export interface SpecMeta {
  id?: string;
  title?: string;
  fileExtensions: string[];
  /** meta/imports exactly as written (without `.ksy`). */
  imports: string[];
}

const asStrings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
    .filter((x) => x !== null && x !== undefined)
    .map(String);

/** Extracts meta fields. Never throws: a broken spec gives empty meta. */
export function readMeta(text: string): SpecMeta {
  let doc: unknown;
  try {
    doc = parse(text, { uniqueKeys: false });
  } catch {
    return { fileExtensions: [], imports: [] };
  }
  const meta = (doc as { meta?: Record<string, unknown> } | null)?.meta;
  if (!meta || typeof meta !== 'object') return { fileExtensions: [], imports: [] };
  return {
    id: typeof meta.id === 'string' ? meta.id : undefined,
    title: typeof meta.title === 'string' ? meta.title : undefined,
    fileExtensions: asStrings(meta['file-extension']).map((e) => e.replace(/^\./, '').toLowerCase()),
    imports: asStrings(meta.imports),
  };
}

/** Normalises `a/./b/../c` to `a/c`. Returns undefined if the path climbs above the root. */
export function normalizePath(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/**
 * Resolves an import of the spec at `fromPath` (repo-relative, with `.ksy`) to a repo-relative path with `.ksy`.
 * Absolute imports (`/common/x`) resolve from the repo root, relative ones from the importing file's folder.
 */
export function resolveImport(fromPath: string, name: string): string | undefined {
  const base = name.startsWith('/') ? name : `${fromPath.split('/').slice(0, -1).join('/')}/${name}`;
  const norm = normalizePath(base);
  return norm ? `${norm}.ksy` : undefined;
}

/** The repo-relative path of `uri.path` when it lies under `rootPath` (both `/`-separated). */
export function relativeTo(rootPath: string, path: string): string | undefined {
  const root = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  return path.startsWith(root) ? path.slice(root.length) : undefined;
}
