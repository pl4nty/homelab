// Reads the bits of a .ksy that the gallery needs and resolves import paths. No vscode imports.
import { parse } from 'yaml';

export interface SpecMeta {
  title?: string;
  /** meta/file-extension, lower case and without the dot. */
  fileExtensions: string[];
  /** meta/imports exactly as written (without `.ksy`). */
  imports: string[];
}

const asStrings = (v: unknown): string[] =>
  [v ?? []]
    .flat()
    .filter((x) => x != null)
    .map(String);

/** Extracts meta fields. Never throws: a broken spec gives empty meta. */
export function readMeta(text: string): SpecMeta {
  let meta: Record<string, unknown> | undefined;
  try {
    meta = parse(text, { uniqueKeys: false })?.meta;
  } catch {
    // broken YAML
  }
  if (!meta || typeof meta !== 'object') return { fileExtensions: [], imports: [] };
  return {
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
    if (part !== '..') out.push(part);
    else if (!out.pop()) return undefined;
  }
  return out.join('/');
}

/** Folder of a repo-relative path ('' for the root). */
export function dirname(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

/**
 * Resolves an import of the spec at `fromPath` (repo-relative, with `.ksy`) to a repo-relative path with `.ksy`.
 * Absolute imports (`/common/x`) resolve from the repo root, relative ones from the importing file's folder.
 */
export function resolveImport(fromPath: string, name: string): string | undefined {
  const norm = normalizePath(name.startsWith('/') ? name : `${dirname(fromPath)}/${name}`);
  return norm ? `${norm}.ksy` : undefined;
}
