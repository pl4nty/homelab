// Suggests gallery specs for a file extension. No vscode imports (unit-tested).
import { EXTENSIONS } from './extensions.ts';
import type { GalleryEntry } from './listing.ts';

/** Lower-case extension of a file name or path, without the dot. Undefined for none and for dotfiles. */
export function extensionOf(path: string): string | undefined {
  return /[^/]\.([^./]+)$/.exec(path)?.[1].toLowerCase();
}

/**
 * Spec paths for `ext`: the bundled extension map, meta/file-extension of specs fetched since, and entries named
 * after the extension. When `entries` is non-empty, only paths in it are kept (the configured repo may differ).
 */
export function suggestFor(
  ext: string | undefined,
  entries: readonly GalleryEntry[],
  fetched: ReadonlyMap<string, { fileExtensions: readonly string[] }> = new Map(),
): string[] {
  if (!ext) return [];
  const e = ext.toLowerCase().replace(/^\./, '');
  const out = new Set<string>(Object.hasOwn(EXTENSIONS, e) ? EXTENSIONS[e] : []);
  for (const [path, meta] of fetched) if (meta.fileExtensions.includes(e)) out.add(path);
  for (const entry of entries) if (entry.name.toLowerCase() === e) out.add(entry.path);
  const known = new Set(entries.map((x) => x.path));
  return [...out].filter((p) => !known.size || known.has(p)).sort();
}

/** Every path in the bundled extension map: an offline listing for the default repository. */
export function bundledPaths(): string[] {
  return [...new Set(Object.values(EXTENSIONS).flat())].sort();
}
