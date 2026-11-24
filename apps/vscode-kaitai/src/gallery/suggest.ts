// Suggests gallery specs for a file extension. No vscode imports (unit-tested).
import { EXTENSIONS } from './extensions.ts';
import type { GalleryEntry } from './listing.ts';

/** Lower-case extension of a file name or path, without the dot. */
export function extensionOf(path: string): string | undefined {
  const name = path.split('/').pop() ?? path;
  const m = /\.([^.]+)$/.exec(name);
  return m && m.index > 0 ? m[1].toLowerCase() : undefined;
}

/**
 * Spec paths for `ext`: the bundled extension map, file-extension meta of specs fetched since, and entries named
 * after the extension. When `entries` is non-empty, only paths in it are kept (the configured repo may differ).
 */
export function suggestFor(
  ext: string | undefined,
  entries: readonly GalleryEntry[],
  fetchedExtensions: ReadonlyMap<string, readonly string[]> = new Map(),
): string[] {
  if (!ext) return [];
  const e = ext.toLowerCase().replace(/^\./, '');
  const out = new Set<string>(Object.hasOwn(EXTENSIONS, e) ? EXTENSIONS[e] : []);
  for (const [path, exts] of fetchedExtensions) if (exts.includes(e)) out.add(path);
  for (const entry of entries) if (entry.name.toLowerCase() === e) out.add(entry.path);
  const known = new Set(entries.map((x) => x.path));
  return [...out].filter((p) => !known.size || known.has(p)).sort();
}

/** Every path in the bundled extension map: an offline listing for the default repository. */
export function bundledPaths(): string[] {
  return [...new Set(Object.values(EXTENSIONS).flat())].sort();
}
