// Loads .ksy specs for the CLI and MCP server: local files, inline source, or the format gallery (`gallery:<path>`),
// and resolves their imports. Node only (node:fs); no vscode import.
import { readFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { ImportReader } from '../engine/kaitai.ts';
import { fetchRepoFile } from '../gallery/listing.ts';
import { dirname as galleryDir, normalizePath } from '../gallery/spec.ts';

const DEFAULT_REPO = 'pl4nty/kaitai_struct_formats';
const DEFAULT_REF = 'master';
const TIMEOUT_MS = 20_000;
const GALLERY = 'gallery:';

export interface SourceOptions {
  /** Format gallery `owner/repo`. */
  repo?: string;
  ref?: string;
  /** Extra folders for imports, like ksc's `-I` (absolute imports are tried in each). */
  importPaths?: readonly string[];
  /** Base for relative paths. Defaults to the process working directory. */
  cwd?: string;
  /** Set to false to never use the network. Defaults to true, or false with KAITAI_OFFLINE=1. */
  network?: boolean;
}

export interface LoadedSpec {
  /** YAML source. */
  source: string;
  /** Where it came from: a resolved file path, `gallery:<path>`, or `<inline>`. */
  label: string;
  readImport: ImportReader;
}

/** A folder that imports are looked up in. */
interface Loc {
  kind: 'fs' | 'gallery';
  dir: string;
}

const sameLoc = (a: Loc, b: Loc) => a.kind === b.kind && a.dir === b.dir;

/** Gallery file cache, shared by every spec loaded in this process. Keyed by `repo@ref:path`. */
const galleryCache = new Map<string, Promise<string | undefined>>();

export class SpecLoader {
  readonly repo: string;
  readonly ref: string;
  private readonly importPaths: string[];
  private readonly cwd: string;
  private readonly network: boolean;

  constructor(opts: SourceOptions = {}) {
    this.repo = opts.repo || process.env.KAITAI_FORMATS_REPO || DEFAULT_REPO;
    this.ref = opts.ref || process.env.KAITAI_FORMATS_REF || DEFAULT_REF;
    this.cwd = opts.cwd ?? process.cwd();
    // Split like ksc does (`;` on Windows, where `:` follows a drive letter).
    const envPaths = (process.env.KSPATH ?? '').split(delimiter).filter(Boolean);
    this.importPaths = [...(opts.importPaths ?? []), ...envPaths].map((p) => resolve(this.cwd, p));
    this.network = opts.network ?? process.env.KAITAI_OFFLINE !== '1';
  }

  /** Downloads a gallery file (repo-relative path with `.ksy`). Undefined when it does not exist. */
  fetchGallery(path: string): Promise<string | undefined> {
    if (!this.network) return Promise.resolve(undefined);
    const key = `${this.repo}@${this.ref}:${path}`;
    let p = galleryCache.get(key);
    if (!p) {
      p = fetchRepoFile(this.repo, this.ref, path, AbortSignal.timeout(TIMEOUT_MS)).catch((e) => {
        galleryCache.delete(key);
        throw new Error(`Cannot download ${path} from ${this.repo}@${this.ref}: ${(e as Error).message ?? e}`);
      });
      galleryCache.set(key, p);
    }
    return p;
  }

  /** Loads a spec by reference: a file path or `gallery:<path>` (`.ksy` optional). */
  async load(ref: string): Promise<LoadedSpec> {
    if (ref.startsWith(GALLERY)) {
      const path = normalizePath(ref.slice(GALLERY.length));
      if (!path) throw new Error(`Bad gallery path: ${ref}`);
      const file = path.endsWith('.ksy') ? path : `${path}.ksy`;
      const source = await this.fetchGallery(file);
      if (source === undefined) {
        throw new Error(`No ${file} in ${this.repo}@${this.ref}${this.network ? '' : ' (the network is turned off)'}`);
      }
      return {
        source,
        label: `${GALLERY}${file}`,
        readImport: this.reader({ kind: 'gallery', dir: galleryDir(file) }),
      };
    }
    const file = resolve(this.cwd, ref);
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch (e) {
      const hint = /^[\w-]+\/[\w/-]+$/.test(ref) ? ` (for the format gallery, use "${GALLERY}${ref}")` : '';
      throw new Error(`Cannot read spec ${ref}: ${(e as NodeJS.ErrnoException).code ?? e}${hint}`);
    }
    return { source, label: file, readImport: this.reader({ kind: 'fs', dir: dirname(file) }) };
  }

  /** Inline spec source. Relative imports resolve from the working directory. */
  inline(source: string): LoadedSpec {
    return { source, label: '<inline>', readImport: this.reader({ kind: 'fs', dir: this.cwd }) };
  }

  /**
   * Import reader for a spec in `home`. Mirrors the IDE: relative imports are tried in the folder of every spec
   * read so far (the compiler only passes names), absolute ones in each ancestor folder of the root spec (so a
   * checkout of the gallery works). Both then fall back to the import paths and the gallery root.
   */
  private reader(home: Loc): ImportReader {
    const seen: Loc[] = [home];
    return async (name, mode) => {
      const rel = name.replace(/^\/+/, '');
      const candidates: Loc[] = [];
      if (mode === 'rel') candidates.push(...seen);
      else if (home.kind === 'fs') {
        for (let d = home.dir; ; d = dirname(d)) {
          candidates.push({ kind: 'fs', dir: d });
          if (dirname(d) === d) break;
        }
      }
      candidates.push(...this.importPaths.map((dir): Loc => ({ kind: 'fs', dir })), { kind: 'gallery', dir: '' });

      let failure = '';
      for (const loc of candidates) {
        const found = await this.read(loc, `${rel}.ksy`).catch((e: Error) => {
          failure = `; ${e.message}`;
          return undefined;
        });
        if (!found) continue;
        if (!seen.some((l) => sameLoc(l, found.dir))) seen.push(found.dir);
        return found.text;
      }
      const kind = mode === 'abs' ? 'absolute' : 'relative';
      throw new Error(`Cannot find imported spec "${name}" (${kind} import)${failure}`);
    };
  }

  private async read(loc: Loc, file: string): Promise<{ text: string; dir: Loc } | undefined> {
    if (loc.kind === 'fs') {
      const path = join(loc.dir, file);
      const text = await readFile(path, 'utf8').catch(() => undefined);
      return text === undefined ? undefined : { text, dir: { kind: 'fs', dir: dirname(path) } };
    }
    const path = normalizePath(loc.dir ? `${loc.dir}/${file}` : file);
    if (!path) return undefined;
    const text = await this.fetchGallery(path);
    return text === undefined ? undefined : { text, dir: { kind: 'gallery', dir: galleryDir(path) } };
  }
}
