// Format Gallery: tree view `kaitai.formats` of the .ksy files in a GitHub repo, mirrored into global storage so
// they open as normal documents and their imports resolve. Also the gallery fallback for absolute imports.
// Uses only CORS-enabled endpoints, so it works in VS Code for the Web.
import * as vscode from 'vscode';
import {
  type CachedListing,
  type GalleryCategory,
  type GalleryEntry,
  gitTreeUrl,
  groupByCategory,
  isFresh,
  jsdelivrListUrl,
  parseGitTree,
  parseJsdelivrFlat,
  rawUrls,
  toEntries,
} from './gallery/listing.ts';
import { normalizePath, readMeta, resolveImport, type SpecMeta } from './gallery/spec.ts';
import { bundledPaths, extensionOf, suggestFor } from './gallery/suggest.ts';
import { setGalleryFetch } from './imports.ts';
import type { KaitaiDocument, Session } from './session.ts';

const DEFAULT_REPO = 'kaitai-io/kaitai_struct_formats';
const CACHE_KEY = 'kaitai.gallery.listing';
const TIMEOUT_MS = 20_000;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

type Node =
  | { kind: 'message'; text: string; icon?: string; tooltip?: string; children?: GalleryEntry[] }
  | { kind: 'category'; category: GalleryCategory }
  | { kind: 'file'; entry: GalleryEntry; under?: 'suggested' };

function config() {
  const c = vscode.workspace.getConfiguration('kaitai');
  const repo = (c.get<string>('formatsRepository') || DEFAULT_REPO).trim().replace(/^\/+|\/+$/g, '');
  const ref = (c.get<string>('formatsRef') || 'master').trim();
  return { repo, ref };
}

async function githubToken(): Promise<string | undefined> {
  try {
    return (await vscode.authentication.getSession('github', [], { createIfNone: false, silent: true }))?.accessToken;
  } catch {
    return undefined;
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      // not JSON
    }
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

class Gallery implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly context: vscode.ExtensionContext;
  private readonly session: Session;
  private readonly disposables: vscode.Disposable[] = [this.changeEmitter];

  private entries: GalleryEntry[] = [];
  private categories: GalleryCategory[] = [];
  private status?: { text: string; icon: string; tooltip?: string };
  private loading?: Promise<void>;
  private loaded = false;
  /** Meta of specs fetched in this session, by repo path. */
  private readonly meta = new Map<string, SpecMeta>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  /** Folders of gallery files handed to the compiler, for nested relative imports. */
  private readonly importDirs: string[] = [];

  constructor(context: vscode.ExtensionContext, session: Session) {
    this.context = context;
    this.session = session;
    this.disposables.push(
      session.onDidChangeActive(() => this.changeEmitter.fire(undefined)),
      session.onDidParse((doc) => {
        if (doc === session.active) this.changeEmitter.fire(undefined);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kaitai.formatsRepository') || e.affectsConfiguration('kaitai.formatsRef')) {
          this.meta.clear();
          this.importDirs.length = 0;
          if (this.loaded) void this.refresh(false);
        }
      }),
    );
  }

  // ---- storage ----

  private root(repo = config().repo, ref = config().ref) {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'gallery', ...repo.split('/'), ...ref.split('/'));
  }

  uriOf(path: string) {
    return vscode.Uri.joinPath(this.root(), ...path.split('/'));
  }

  private async readMirror(path: string): Promise<string | undefined> {
    try {
      return decoder.decode(await vscode.workspace.fs.readFile(this.uriOf(path)));
    } catch {
      return undefined;
    }
  }

  /** Text of a gallery file: from the mirror, else downloaded (and mirrored). Undefined when it does not exist. */
  fetchText(path: string): Promise<string | undefined> {
    const norm = normalizePath(path);
    if (!norm) return Promise.resolve(undefined);
    const key = `${config().repo}@${config().ref}:${norm}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.download(norm).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async download(path: string): Promise<string | undefined> {
    let text = await this.readMirror(path);
    if (text === undefined) {
      const { repo, ref } = config();
      let lastError: unknown;
      for (const url of rawUrls(repo, ref, path)) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (res.status === 404) return undefined;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          text = await res.text();
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (text === undefined)
        throw new Error(`Cannot download ${path}: ${(lastError as Error)?.message ?? 'unknown error'}`);
      const uri = this.uriOf(path);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
    }
    this.meta.set(path, readMeta(text));
    return text;
  }

  /** Mirrors a spec and, recursively, its imports. Returns the mirrored spec's URI. */
  async mirror(path: string, withImports: boolean): Promise<vscode.Uri> {
    const seen = new Set<string>();
    const visit = async (p: string, top: boolean): Promise<void> => {
      if (seen.has(p)) return;
      seen.add(p);
      let text: string | undefined;
      try {
        text = await this.fetchText(p);
      } catch (e) {
        if (top) throw e;
        return; // a missing import is reported by the compiler
      }
      if (text === undefined) {
        if (top) throw new Error(`${p} does not exist in ${config().repo}@${config().ref}`);
        return;
      }
      if (!withImports) return;
      const imports = this.meta.get(p)?.imports ?? [];
      await Promise.all(
        imports.map((name) => {
          const target = resolveImport(p, name);
          return target ? visit(target, false) : undefined;
        }),
      );
    };
    await visit(path, true);
    return this.uriOf(path);
  }

  /** Import fallback for specs anywhere: `path` is relative to the repo root, with `.ksy`. */
  async importFallback(path: string): Promise<string | undefined> {
    const clean = normalizePath(path);
    if (!clean) return undefined;
    const candidates: string[] = [];
    if (!path.startsWith('/')) {
      // Relative import of a gallery file served earlier: resolve from its folder first, when the listing has it.
      const known = new Set(this.entries.map((e) => e.path));
      for (const dir of [...this.importDirs].reverse()) {
        const p = normalizePath(`${dir}/${path}`);
        if (p && known.has(p) && !candidates.includes(p)) candidates.push(p);
      }
    }
    if (!candidates.includes(clean)) candidates.push(clean);
    for (const norm of candidates) {
      try {
        const text = await this.fetchText(norm);
        if (text === undefined) continue;
        const dir = norm.split('/').slice(0, -1).join('/');
        if (!this.importDirs.includes(dir)) this.importDirs.push(dir);
        return text;
      } catch {
        // offline: let the compiler report the missing import
      }
    }
    return undefined;
  }

  // ---- listing ----

  private ensureLoaded() {
    if (!this.loaded && !this.loading) this.loading = this.load(false).finally(() => (this.loading = undefined));
    return this.loading;
  }

  async refresh(force: boolean) {
    this.loaded = false;
    this.loading = this.load(force).finally(() => (this.loading = undefined));
    this.changeEmitter.fire(undefined);
    await this.loading;
  }

  private async load(force: boolean) {
    const { repo, ref } = config();
    const cache = this.context.globalState.get<CachedListing>(CACHE_KEY);
    const now = Date.now();
    let paths: string[] | undefined;
    this.status = undefined;
    if (!force && cache && isFresh(cache, repo, ref, now)) {
      paths = cache.paths;
    } else {
      const errors: string[] = [];
      let source: CachedListing['source'] = 'github';
      try {
        const token = await githubToken();
        const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const tree = parseGitTree(await getJson(gitTreeUrl(repo, ref), headers));
        if (tree.truncated) errors.push('GitHub listing truncated');
        paths = tree.entries.map((e) => e.path);
      } catch (e) {
        errors.push(`GitHub: ${(e as Error).message}`);
        try {
          paths = parseJsdelivrFlat(await getJson(jsdelivrListUrl(repo, ref))).map((e) => e.path);
          source = 'jsdelivr';
        } catch (e2) {
          errors.push(`jsDelivr: ${(e2 as Error).message}`);
        }
      }
      if (paths) {
        await this.context.globalState.update(CACHE_KEY, {
          repo,
          ref,
          fetchedAt: now,
          paths,
          source,
        } satisfies CachedListing);
      } else if (cache && cache.repo === repo && cache.ref === ref) {
        paths = cache.paths;
        this.status = {
          text: `Offline: showing the list from ${new Date(cache.fetchedAt).toLocaleString()}`,
          icon: 'warning',
          tooltip: errors.join('\n'),
        };
      } else if (repo === DEFAULT_REPO) {
        paths = bundledPaths();
        this.status = { text: 'Offline: showing the bundled format list', icon: 'warning', tooltip: errors.join('\n') };
      } else {
        this.status = { text: `Cannot list ${repo}@${ref}`, icon: 'error', tooltip: errors.join('\n') };
      }
    }
    this.entries = toEntries(paths ?? []);
    this.categories = groupByCategory(this.entries);
    this.loaded = true;
    this.changeEmitter.fire(undefined);
  }

  // ---- tree ----

  private suggestions(): { ext: string; paths: Set<string> } | undefined {
    const doc = this.session.active;
    if (!doc || doc.specUri) return undefined;
    const ext = extensionOf(doc.uri.path);
    if (!ext) return undefined;
    const fetched = new Map([...this.meta].map(([p, m]) => [p, m.fileExtensions]));
    const paths = suggestFor(ext, this.entries, fetched);
    return paths.length ? { ext, paths: new Set(paths) } : undefined;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      await this.ensureLoaded();
      const out: Node[] = [];
      if (this.status) out.push({ kind: 'message', ...this.status });
      const s = this.suggestions();
      if (s) {
        const byPath = new Map(this.entries.map((e) => [e.path, e]));
        const children = [...s.paths].map((p) => byPath.get(p)).filter((e): e is GalleryEntry => !!e);
        out.push({
          kind: 'message',
          text: `Suggested for .${s.ext}: ${children.map((c) => c.name).join(', ')}`,
          icon: 'lightbulb',
          children,
        });
      }
      for (const category of this.categories) {
        if (category.name) out.push({ kind: 'category', category });
        else out.push(...category.entries.map((entry) => ({ kind: 'file' as const, entry })));
      }
      return out;
    }
    if (node.kind === 'category') return node.category.entries.map((entry) => ({ kind: 'file', entry }));
    if (node.kind === 'message' && node.children) {
      return node.children.map((entry) => ({ kind: 'file', entry, under: 'suggested' }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(
        node.text,
        node.children?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      item.id = `msg:${node.icon}:${node.children ? 'suggest' : ''}`;
      if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.tooltip) item.tooltip = node.tooltip;
      return item;
    }
    const s = this.suggestions();
    if (node.kind === 'category') {
      const item = new vscode.TreeItem(node.category.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `cat:${node.category.name}`;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.description = `${node.category.entries.length}`;
      item.contextValue = 'category';
      return item;
    }
    const { entry } = node;
    const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
    item.id = `${node.under ?? 'file'}:${entry.path}`;
    item.iconPath = new vscode.ThemeIcon(s?.paths.has(entry.path) ? 'star-full' : 'file-code');
    item.description = s?.paths.has(entry.path) ? `suggested for .${s.ext} · ${entry.path}` : entry.path;
    item.contextValue = 'format';
    item.command = { command: 'kaitai.formats.open', title: 'Open Spec', arguments: [node] };
    return item;
  }

  async resolveTreeItem(item: vscode.TreeItem, node: Node): Promise<vscode.TreeItem> {
    if (node.kind !== 'file') return item;
    let meta = this.meta.get(node.entry.path);
    if (!meta) {
      const text = await this.readMirror(node.entry.path);
      if (text !== undefined) this.meta.set(node.entry.path, (meta = readMeta(text)));
    }
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMd(meta?.title ?? node.entry.name)}**\n\n`);
    md.appendMarkdown(`\`${escapeMd(node.entry.path)}\`\n\n`);
    if (meta?.fileExtensions.length)
      md.appendMarkdown(`Extensions: ${meta.fileExtensions.map((e) => `.${e}`).join(', ')}\n\n`);
    if (!meta) md.appendMarkdown('_Open or use the spec to fetch its details._');
    item.tooltip = md;
    return item;
  }

  getParent() {
    return undefined;
  }

  entryFor(arg: unknown): GalleryEntry | undefined {
    if (typeof arg === 'string') return this.entries.find((e) => e.path === arg) ?? toEntries([arg])[0];
    const node = arg as Node | undefined;
    if (node?.kind === 'file') return node.entry;
    return undefined;
  }

  async pick(placeHolder: string): Promise<GalleryEntry | undefined> {
    await this.ensureLoaded();
    const s = this.suggestions();
    const items = this.entries.map((entry) => ({
      label: entry.name,
      description: entry.path,
      detail: s?.paths.has(entry.path) ? `Suggested for .${s.ext}` : undefined,
      entry,
    }));
    items.sort((a, b) => Number(!!b.detail) - Number(!!a.detail));
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.entry;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

function escapeMd(s: string) {
  return s.replace(/[\\`*_[\]<>]/g, '\\$&');
}

/** Waits for the session to get an active document (e.g. after "Open in Kaitai Hex Editor"). */
function waitForActive(session: Session, ms: number): Promise<KaitaiDocument | undefined> {
  if (session.active) return Promise.resolve(session.active);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(undefined);
    }, ms);
    const sub = session.onDidChangeActive((doc) => {
      if (!doc) return;
      clearTimeout(timer);
      sub.dispose();
      resolve(doc);
    });
  });
}

export function registerFormatGallery(context: vscode.ExtensionContext, session: Session): vscode.Disposable {
  const gallery = new Gallery(context, session);
  setGalleryFetch((path) => gallery.importFallback(path));
  const view = vscode.window.createTreeView('kaitai.formats', { treeDataProvider: gallery, showCollapseAll: true });

  const withProgress = <T>(title: string, task: () => Promise<T>) =>
    vscode.window.withProgress({ location: { viewId: 'kaitai.formats' }, title }, task);

  const resolveEntry = async (arg: unknown, placeHolder: string) =>
    gallery.entryFor(arg) ?? (await gallery.pick(placeHolder));

  return vscode.Disposable.from(
    gallery,
    view,
    { dispose: () => setGalleryFetch(async () => undefined) },
    vscode.commands.registerCommand('kaitai.formats.refresh', () =>
      withProgress('Refreshing format list', () => gallery.refresh(true)),
    ),
    vscode.commands.registerCommand('kaitai.formats.open', async (arg?: unknown) => {
      const entry = await resolveEntry(arg, 'Spec to open');
      if (!entry) return;
      try {
        const uri = await withProgress(`Fetching ${entry.path}`, () => gallery.mirror(entry.path, false));
        await vscode.window.showTextDocument(uri, { preview: true });
      } catch (e) {
        void vscode.window.showErrorMessage(`Kaitai: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('kaitai.formats.use', async (arg?: unknown) => {
      const entry = await resolveEntry(arg, 'Spec to use for the active file');
      if (!entry) return;
      let doc = session.active;
      if (!doc) {
        const open = 'Open in Kaitai Hex Editor';
        const answer = await vscode.window.showWarningMessage(
          `Open a file in the Kaitai Hex Editor to parse it with ${entry.name}.`,
          open,
        );
        if (answer !== open) return;
        await vscode.commands.executeCommand('kaitai.openInHexEditor');
        doc = await waitForActive(session, 15_000);
        if (!doc) return;
      }
      try {
        const uri = await withProgress(`Fetching ${entry.path} and its imports`, () =>
          gallery.mirror(entry.path, true),
        );
        await session.setSpec(doc, uri);
        if (doc.specError) void vscode.window.showWarningMessage(`Kaitai: ${doc.specError}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`Kaitai: ${(e as Error).message}`);
      }
    }),
  );
}
