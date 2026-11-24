// Format Gallery: tree view `kaitai.formats` of the .ksy files in a GitHub repo, mirrored into global storage so
// they open as normal documents and their imports resolve. Also the gallery fallback for imports.
// Uses only CORS-enabled endpoints, so it works in VS Code for the Web.
import * as vscode from 'vscode';
import { fetchGitTree, fetchRepoFile, type GalleryEntry, groupByCategory, toEntries } from './gallery/listing.ts';
import { dirname, normalizePath, readMeta, resolveImport, type SpecMeta } from './gallery/spec.ts';
import { bundledPaths, extensionOf, suggestFor } from './gallery/suggest.ts';
import { setGalleryFetch } from './imports.ts';
import type { KaitaiDocument, Session } from './session.ts';

const DEFAULT_REPO = 'pl4nty/kaitai_struct_formats';
const CACHE_KEY = 'kaitai.gallery.listing';
const LISTING_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 20_000;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface Source {
  repo: string;
  ref: string;
}

/** The listing kept in global state, so the (rate-limited) GitHub API is asked at most once a day. */
interface CachedListing extends Source {
  /** ms since epoch. */
  fetchedAt: number;
  paths: string[];
}

interface Message {
  text: string;
  icon: string;
  tooltip?: string;
}

type Node =
  | ({ kind: 'message' } & Message)
  | { kind: 'group'; name: string; entries: GalleryEntry[]; suggested?: true }
  | { kind: 'file'; entry: GalleryEntry; suggested?: true };

function configuredSource(): Source {
  const c = vscode.workspace.getConfiguration('kaitai');
  // Normalised, so that neither can climb out of the mirror folder.
  const get = (key: string, fallback: string) => normalizePath((c.get<string>(key) ?? '').trim()) || fallback;
  return { repo: get('formatsRepository', DEFAULT_REPO), ref: get('formatsRef', 'master') };
}

async function githubToken(): Promise<string | undefined> {
  try {
    return (await vscode.authentication.getSession('github', [], { silent: true }))?.accessToken;
  } catch {
    return undefined;
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Gallery implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly context: vscode.ExtensionContext;
  private readonly session: Session;
  private readonly disposables: vscode.Disposable[] = [this.changeEmitter];

  /** The configured repository. Replaced (never mutated) when the settings change. */
  private source = configuredSource();
  private entries: GalleryEntry[] = [];
  private status?: Message;
  /** The first or latest load of the listing; loads run one after another. */
  private listing?: Promise<void>;
  /** Suggestions for the active document, as of the last time the tree's roots were built. */
  private suggested?: { ext: string; paths: Set<string> };
  /** Meta of specs read in this session, by repo path. */
  private readonly meta = new Map<string, SpecMeta>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  /** Folders of gallery files handed to the compiler, latest first, for nested relative imports. */
  private readonly importDirs: string[] = [];

  constructor(context: vscode.ExtensionContext, session: Session) {
    this.context = context;
    this.session = session;
    this.disposables.push(
      session.onDidChangeActive(() => this.changeEmitter.fire()),
      session.onDidParse((doc) => {
        if (doc === session.active) this.changeEmitter.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kaitai.formatsRepository') || e.affectsConfiguration('kaitai.formatsRef')) {
          this.source = configuredSource();
          this.meta.clear();
          this.importDirs.length = 0;
          if (this.listing) void this.refresh(false);
        }
      }),
    );
  }

  // ---- storage ----

  private uriOf(path: string, { repo, ref } = this.source) {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'gallery', repo, ref, path);
  }

  private async readMirror(path: string, from = this.source): Promise<string | undefined> {
    try {
      return decoder.decode(await vscode.workspace.fs.readFile(this.uriOf(path, from)));
    } catch {
      return undefined;
    }
  }

  /** Text of a gallery file: from the mirror, else downloaded (and mirrored). Undefined when it does not exist. */
  private fetchText(path: string): Promise<string | undefined> {
    const from = this.source;
    const key = `${from.repo}@${from.ref}:${path}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.download(path, from).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async download(path: string, from: Source): Promise<string | undefined> {
    let text = await this.readMirror(path, from);
    if (text === undefined) {
      try {
        text = await fetchRepoFile(from.repo, from.ref, path, AbortSignal.timeout(TIMEOUT_MS));
        if (text === undefined) return undefined;
      } catch (e) {
        throw new Error(`Cannot download ${path}: ${errorMessage(e)}`);
      }
      const uri = this.uriOf(path, from);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
    }
    if (from === this.source) this.meta.set(path, readMeta(text));
    return text;
  }

  /** Mirrors a spec and, if asked, its imports (recursively). Returns the mirrored spec's URI. */
  async mirror(path: string, withImports: boolean): Promise<vscode.Uri> {
    const from = this.source;
    if ((await this.fetchText(path)) === undefined) {
      throw new Error(`${path} does not exist in ${from.repo}@${from.ref}`);
    }
    if (withImports) await this.mirrorImports(path, new Set([path]));
    return this.uriOf(path, from);
  }

  private async mirrorImports(path: string, seen: Set<string>): Promise<void> {
    await Promise.all(
      (this.meta.get(path)?.imports ?? []).map(async (name) => {
        const target = resolveImport(path, name);
        if (!target || seen.has(target)) return;
        seen.add(target);
        // A missing or unreachable import is left for the compiler to report.
        const text = await this.fetchText(target).catch(() => undefined);
        if (text !== undefined) await this.mirrorImports(target, seen);
      }),
    );
  }

  /**
   * Import fallback for specs anywhere. `path` has `.ksy`; with a leading `/` it is relative to the repo root,
   * otherwise it is tried in the folders of the gallery files served so far, then in the root.
   */
  async importFallback(path: string): Promise<string | undefined> {
    const candidates = new Set<string>();
    if (!path.startsWith('/')) {
      // Only ask for files the listing has, when there is one.
      const known = new Set(this.entries.map((e) => e.path));
      for (const dir of this.importDirs) {
        const p = normalizePath(`${dir}/${path}`);
        if (p && (!known.size || known.has(p))) candidates.add(p);
      }
    }
    const fromRoot = normalizePath(path);
    if (fromRoot) candidates.add(fromRoot);
    for (const p of candidates) {
      // Offline: let the compiler report the missing import.
      const text = await this.fetchText(p).catch(() => undefined);
      if (text === undefined) continue;
      const dir = dirname(p);
      if (!this.importDirs.includes(dir)) this.importDirs.unshift(dir);
      return text;
    }
    return undefined;
  }

  // ---- listing ----

  private ensureLoaded() {
    this.listing ??= this.load(false);
    return this.listing;
  }

  refresh(force: boolean) {
    // Chained, so that an earlier, slower load cannot overwrite this one's result.
    this.listing = (this.listing ?? Promise.resolve()).then(() => this.load(force));
    this.changeEmitter.fire();
    return this.listing;
  }

  /** Never rejects: failures end up in `status`. */
  private async load(force: boolean) {
    const { repo, ref } = this.source;
    const stored = this.context.globalState.get<CachedListing>(CACHE_KEY);
    const cache = stored?.repo === repo && stored.ref === ref ? stored : undefined;
    let paths: string[] = [];
    this.status = undefined;
    if (cache && !force && Date.now() - cache.fetchedAt < LISTING_TTL_MS) {
      paths = cache.paths;
    } else {
      try {
        const tree = await fetchGitTree(repo, ref, await githubToken(), AbortSignal.timeout(TIMEOUT_MS));
        paths = tree.entries.map((e) => e.path);
        if (tree.truncated) {
          this.status = { text: 'The repository is too large: some specs are not listed', icon: 'warning' };
        }
        const listing: CachedListing = { repo, ref, fetchedAt: Date.now(), paths };
        await this.context.globalState.update(CACHE_KEY, listing);
      } catch (e) {
        const tooltip = `GitHub: ${errorMessage(e)}`;
        if (cache) {
          paths = cache.paths;
          const when = new Date(cache.fetchedAt).toLocaleString();
          this.status = { text: `Offline: showing the list from ${when}`, icon: 'warning', tooltip };
        } else if (repo === DEFAULT_REPO) {
          paths = bundledPaths();
          this.status = { text: 'Offline: showing the bundled format list', icon: 'warning', tooltip };
        } else {
          this.status = { text: `Cannot list ${repo}@${ref}`, icon: 'error', tooltip };
        }
      }
    }
    this.entries = toEntries(paths);
    this.changeEmitter.fire();
  }

  // ---- tree ----

  private suggest() {
    const doc = this.session.active;
    const ext = doc ? extensionOf(doc.uri.path) : undefined;
    const paths = new Set(suggestFor(ext, this.entries, this.meta));
    this.suggested = ext && paths.size ? { ext, paths } : undefined;
    return this.suggested;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) {
      if (node.kind !== 'group') return [];
      return node.entries.map((entry) => ({ kind: 'file', entry, suggested: node.suggested }));
    }
    await this.ensureLoaded();
    const out: Node[] = [];
    if (this.status) out.push({ kind: 'message', ...this.status });
    const s = this.suggest();
    const suggested = s ? this.entries.filter((e) => s.paths.has(e.path)) : [];
    if (s && suggested.length) {
      const name = `Suggested for .${s.ext}: ${suggested.map((e) => e.name).join(', ')}`;
      out.push({ kind: 'group', name, entries: suggested, suggested: true });
    }
    for (const { name, entries } of groupByCategory(this.entries)) {
      if (name) out.push({ kind: 'group', name, entries });
      else out.push(...entries.map((entry) => ({ kind: 'file' as const, entry })));
    }
    return out;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text);
      item.id = `message:${node.icon}`;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.tooltip;
      return item;
    }
    if (node.kind === 'group') {
      const { Expanded, Collapsed } = vscode.TreeItemCollapsibleState;
      const item = new vscode.TreeItem(node.name, node.suggested ? Expanded : Collapsed);
      if (node.suggested) {
        item.id = 'suggested';
        item.iconPath = new vscode.ThemeIcon('lightbulb');
      } else {
        item.id = `category:${node.name}`;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.description = `${node.entries.length}`;
        item.contextValue = 'category';
      }
      return item;
    }
    const { name, path } = node.entry;
    const s = this.suggested?.paths.has(path) ? this.suggested : undefined;
    const item = new vscode.TreeItem(name);
    item.id = `${node.suggested ? 'suggested' : 'file'}:${path}`;
    const loaded = this.session.active?.specUri?.toString() === this.uriOf(path).toString();
    item.iconPath = new vscode.ThemeIcon(loaded ? 'check' : s ? 'star-full' : 'file-code');
    item.description = [loaded && 'loaded', s && `suggested for .${s.ext}`, path].filter(Boolean).join(' · ');
    item.contextValue = 'format';
    item.command = { command: 'kaitai.formats.open', title: 'Open Spec', arguments: [node] };
    return item;
  }

  async resolveTreeItem(item: vscode.TreeItem, node: Node): Promise<vscode.TreeItem> {
    if (node.kind !== 'file') return item;
    const { name, path } = node.entry;
    let meta = this.meta.get(path);
    if (!meta) {
      const text = await this.readMirror(path);
      if (text !== undefined) {
        meta = readMeta(text);
        this.meta.set(path, meta);
      }
    }
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMd(meta?.title ?? name)}**\n\n\`${escapeMd(path)}\`\n\n`);
    if (meta?.fileExtensions.length) {
      md.appendMarkdown(`Extensions: ${meta.fileExtensions.map((e) => `.${escapeMd(e)}`).join(', ')}\n\n`);
    }
    if (!meta) md.appendMarkdown('_Open or use the spec to fetch its details._');
    item.tooltip = md;
    return item;
  }

  /** The entry a command was invoked with: a tree node, or a repo path (which need not be in the listing). */
  entryFor(arg: unknown): GalleryEntry | undefined {
    if (typeof arg === 'string') {
      const path = normalizePath(arg);
      return this.entries.find((e) => e.path === path) ?? toEntries(path ? [path] : [])[0];
    }
    const node = arg as Node | undefined;
    return node?.kind === 'file' ? node.entry : undefined;
  }

  async pick(placeHolder: string): Promise<GalleryEntry | undefined> {
    await this.ensureLoaded();
    const s = this.suggest();
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
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

function escapeMd(s: string) {
  return s.replace(/[\\`*_[\]<>]/g, '\\$&');
}

/** Waits for the session to get an active document (e.g. after "Open in Kaitai Hex Editor"). */
function waitForActive(session: Session, ms: number): Promise<KaitaiDocument | undefined> {
  if (session.active) return Promise.resolve(session.active);
  return new Promise((resolve) => {
    const done = (doc: KaitaiDocument | undefined) => {
      clearTimeout(timer);
      sub.dispose();
      resolve(doc);
    };
    const timer = setTimeout(done, ms, undefined);
    const sub = session.onDidChangeActive((doc) => doc && done(doc));
  });
}

export function registerFormatGallery(context: vscode.ExtensionContext, session: Session): vscode.Disposable {
  const gallery = new Gallery(context, session);
  setGalleryFetch((path) => gallery.importFallback(path));

  /** Runs `task` on the picked entry with progress in the view, reporting failures. */
  const command = (id: string, placeHolder: string, task: (entry: GalleryEntry) => Promise<void>) =>
    vscode.commands.registerCommand(id, async (arg?: unknown) => {
      const entry = gallery.entryFor(arg) ?? (await gallery.pick(placeHolder));
      if (!entry) return;
      try {
        await task(entry);
      } catch (e) {
        void vscode.window.showErrorMessage(`Kaitai: ${errorMessage(e)}`);
      }
    });
  const withProgress = <T>(title: string, task: () => Promise<T>) =>
    vscode.window.withProgress({ location: { viewId: 'kaitai.formats' }, title }, task);

  return vscode.Disposable.from(
    gallery,
    vscode.window.createTreeView('kaitai.formats', { treeDataProvider: gallery, showCollapseAll: true }),
    { dispose: () => setGalleryFetch(async () => undefined) },
    vscode.commands.registerCommand('kaitai.formats.refresh', () =>
      withProgress('Refreshing format list', () => gallery.refresh(true)),
    ),
    command('kaitai.formats.open', 'Spec to open', async (entry) => {
      const uri = await withProgress(`Fetching ${entry.path}`, () => gallery.mirror(entry.path, false));
      await vscode.window.showTextDocument(uri, { preview: true });
    }),
    command('kaitai.formats.use', 'Spec to use for the active file', async (entry) => {
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
      const uri = await withProgress(`Fetching ${entry.path} and its imports`, () => gallery.mirror(entry.path, true));
      await session.setSpec(doc, uri);
      if (doc.specError) void vscode.window.showWarningMessage(`Kaitai: ${doc.specError}`);
    }),
  );
}
