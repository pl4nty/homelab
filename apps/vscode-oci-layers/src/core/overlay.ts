// Merged image root filesystem (lower layers) plus a writable upper layer, with
// OCI whiteout semantics.
// Spec: https://github.com/opencontainers/image-spec/blob/main/layer.md#whiteouts

import { fromBase64, toBase64 } from './bytes.ts';
import type { TarEntry, TarType } from './tar.ts';
import { normalizePath } from './tar.ts';

export interface FsNode {
  type: TarType; // never "hardlink": hardlinks are materialised as files
  mode: number;
  uid: number;
  gid: number;
  uname?: string;
  gname?: string;
  mtime: number;
  data?: Uint8Array;
  linkname?: string;
  devmajor?: number;
  devminor?: number;
}

export const WH_PREFIX = '.wh.';
export const WH_OPAQUE = '.wh..wh..opq';

export const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
const isUnder = (p: string, dir: string) => dir === '' || p.startsWith(`${dir}/`);

function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let d = dirname(p); d !== ''; d = dirname(d)) out.unshift(d);
  return out;
}

const ROOT: FsNode = { type: 'dir', mode: 0o755, uid: 0, gid: 0, mtime: 0 };

/** An immutable-after-build merged view of the image's layers. */
export class Tree {
  readonly nodes = new Map<string, FsNode>([['', ROOT]]);
  private readonly children = new Map<string, Set<string>>([['', new Set()]]);

  get(p: string): FsNode | undefined {
    return this.nodes.get(p);
  }

  list(p: string): string[] {
    return [...(this.children.get(p) ?? [])];
  }

  set(p: string, node: FsNode): void {
    const parent = dirname(p);
    if (!this.nodes.has(parent) || this.nodes.get(parent)!.type !== 'dir') {
      if (this.nodes.has(parent)) this.remove(parent);
      this.set(parent, { ...ROOT, mtime: node.mtime });
    }
    const existing = this.nodes.get(p);
    if (existing?.type === 'dir' && node.type !== 'dir') this.remove(p);
    this.nodes.set(p, node);
    this.children.get(parent)!.add(basename(p));
    if (node.type === 'dir' && !this.children.has(p)) this.children.set(p, new Set());
  }

  remove(p: string): void {
    if (p === '' || !this.nodes.has(p)) return;
    for (const c of this.list(p)) this.remove(join(p, c));
    this.nodes.delete(p);
    this.children.delete(p);
    this.children.get(dirname(p))?.delete(basename(p));
  }

  /** Apply one layer's entries. Whiteouts only affect lower layers, so they go first. */
  applyLayer(entries: TarEntry[]): void {
    for (const e of entries) {
      const name = basename(e.path);
      const dir = dirname(e.path);
      if (name === WH_OPAQUE) for (const c of this.list(dir)) this.remove(join(dir, c));
      else if (name.startsWith(WH_PREFIX)) this.remove(join(dir, name.slice(WH_PREFIX.length)));
    }
    for (const e of entries) {
      if (basename(e.path).startsWith(WH_PREFIX)) continue;
      const { path, type, data, ...meta } = e;
      if (type === 'hardlink') {
        const target = this.get(normalizePath(e.linkname ?? ''));
        this.set(path, { ...meta, linkname: undefined, type: 'file', data: target?.data ?? new Uint8Array() });
      } else {
        this.set(path, { ...meta, type, data: type === 'file' ? (data ?? new Uint8Array()) : undefined });
      }
    }
  }
}

type Upper = { kind: 'node'; node: FsNode; opaque?: boolean } | { kind: 'deleted' };

export type ChangeStatus = 'added' | 'modified' | 'deleted';
export interface Change {
  path: string;
  status: ChangeStatus;
  type: TarType;
}

export type FsErrorCode = 'FileNotFound' | 'FileExists' | 'FileNotADirectory' | 'FileIsADirectory' | 'NoPermissions';

export class FsError extends Error {
  readonly code: FsErrorCode;
  constructor(code: FsErrorCode, path: string) {
    super(`${code}: /${path}`);
    this.code = code;
  }
}

const MAX_SYMLINKS = 40;

/** Base tree + in-memory upper layer. Paths are normalised, relative to the image root. */
export class Overlay {
  private upper = new Map<string, Upper>();
  readonly base: Tree;

  constructor(base: Tree) {
    this.base = base;
  }

  // ---- lookup -------------------------------------------------------------

  /** Whether `p` in the base tree is visible through the upper layer's masks on its ancestors. */
  private baseVisible(p: string): boolean {
    for (const a of ancestors(p)) {
      const u = this.upper.get(a);
      if (u?.kind === 'deleted') return false;
      if (u?.kind === 'node' && (u.node.type !== 'dir' || u.opaque)) return false;
    }
    return this.base.get(p) !== undefined;
  }

  /** Raw lookup without following symlinks. */
  lookup(p: string): FsNode | undefined {
    if (p === '')
      return this.upper.get('')?.kind === 'node' ? (this.upper.get('') as { node: FsNode }).node : this.base.get('');
    const u = this.upper.get(p);
    if (u) return u.kind === 'deleted' ? undefined : u.node;
    // An upper entry only exists below directories that exist, so checking masks suffices.
    return this.baseVisible(p) ? this.base.get(p) : undefined;
  }

  /** Resolve symlinks in every component (and the last one if `followLast`). Returns the real path. */
  resolve(p: string, followLast = true, depth = 0): string {
    const parts = normalizePath(p).split('/').filter(Boolean);
    let real = '';
    for (let i = 0; i < parts.length; i++) {
      const next = join(real, parts[i]);
      const node = this.lookup(next);
      if (node?.type === 'symlink' && (i < parts.length - 1 || followLast)) {
        if (depth >= MAX_SYMLINKS) throw new FsError('FileNotFound', p);
        const link = node.linkname ?? '';
        real = this.resolve(link.startsWith('/') ? link : join(dirname(next), link), true, depth + 1);
      } else {
        if (!node && i < parts.length - 1) throw new FsError('FileNotFound', p);
        real = next;
      }
    }
    return real;
  }

  stat(p: string, followLast = true): { node: FsNode; real: string; isLink: boolean } {
    const raw = this.lookup(this.resolve(p, false));
    const real = this.resolve(p, followLast);
    const node = this.lookup(real);
    if (!node) throw new FsError('FileNotFound', p);
    return { node, real, isLink: raw?.type === 'symlink' };
  }

  readdir(p: string): [string, FsNode][] {
    const real = this.resolve(p);
    const node = this.lookup(real);
    if (!node) throw new FsError('FileNotFound', p);
    if (node.type !== 'dir') throw new FsError('FileNotADirectory', p);
    const names = new Set<string>();
    const u = this.upper.get(real);
    if (!(u?.kind === 'node' && u.opaque) && this.baseVisible(real)) for (const n of this.base.list(real)) names.add(n);
    for (const k of this.upper.keys()) if (k !== '' && dirname(k) === real) names.add(basename(k));
    const out: [string, FsNode][] = [];
    for (const n of names) {
      const child = this.lookup(join(real, n));
      if (child) out.push([n, child]);
    }
    return out;
  }

  readFile(p: string): Uint8Array {
    const { node } = this.stat(p);
    if (node.type === 'dir') throw new FsError('FileIsADirectory', p);
    return node.data ?? new Uint8Array();
  }

  // ---- mutation -----------------------------------------------------------

  private realForWrite(p: string): string {
    const parent = this.resolve(dirname(normalizePath(p)));
    const parentNode = this.lookup(parent);
    if (!parentNode) throw new FsError('FileNotFound', dirname(p));
    if (parentNode.type !== 'dir') throw new FsError('FileNotADirectory', dirname(p));
    let real = join(parent, basename(normalizePath(p)));
    if (this.lookup(real)?.type === 'symlink') real = this.resolve(real);
    return real;
  }

  writeFile(
    p: string,
    data: Uint8Array,
    opts: { create: boolean; overwrite: boolean },
    now = Math.floor(Date.now() / 1000),
  ): string {
    const real = this.realForWrite(p);
    const existing = this.lookup(real);
    if (existing?.type === 'dir') throw new FsError('FileIsADirectory', p);
    if (!existing && !opts.create) throw new FsError('FileNotFound', p);
    if (existing && !opts.overwrite) throw new FsError('FileExists', p);
    const meta: Pick<FsNode, 'mode' | 'uid' | 'gid' | 'uname' | 'gname'> = existing ?? { mode: 0o644, uid: 0, gid: 0 };
    this.upper.set(real, {
      kind: 'node',
      node: {
        type: 'file',
        mode: meta.mode,
        uid: meta.uid,
        gid: meta.gid,
        uname: meta.uname,
        gname: meta.gname,
        mtime: now,
        data,
      },
    });
    return real;
  }

  mkdir(p: string, now = Math.floor(Date.now() / 1000)): string {
    const real = this.realForWrite(p);
    if (this.lookup(real)) throw new FsError('FileExists', p);
    // Re-creating a deleted directory must hide the old contents: mark it opaque.
    const opaque = this.upper.get(real)?.kind === 'deleted';
    this.upper.set(real, { kind: 'node', node: { type: 'dir', mode: 0o755, uid: 0, gid: 0, mtime: now }, opaque });
    return real;
  }

  symlink(p: string, target: string, now = Math.floor(Date.now() / 1000)): string {
    const real = join(this.resolve(dirname(normalizePath(p))), basename(normalizePath(p)));
    if (this.lookup(real)) throw new FsError('FileExists', p);
    this.upper.set(real, {
      kind: 'node',
      node: { type: 'symlink', mode: 0o777, uid: 0, gid: 0, mtime: now, linkname: target },
    });
    return real;
  }

  delete(p: string, recursive: boolean): string {
    const real = this.resolve(p, false);
    const node = this.lookup(real);
    if (!node || real === '') throw new FsError(real === '' ? 'NoPermissions' : 'FileNotFound', p);
    if (node.type === 'dir' && !recursive && this.readdir(real).length) throw new FsError('NoPermissions', p);
    for (const k of [...this.upper.keys()]) if (k !== real && isUnder(k, real)) this.upper.delete(k);
    if (this.baseVisible(real)) this.upper.set(real, { kind: 'deleted' });
    else this.upper.delete(real);
    return real;
  }

  rename(from: string, to: string, overwrite: boolean): void {
    const src = this.resolve(from, false);
    if (!this.lookup(src)) throw new FsError('FileNotFound', from);
    const dst = this.realForWrite(to);
    if (dst === src || isUnder(dst, src)) throw new FsError('NoPermissions', to);
    if (this.lookup(dst)) {
      if (!overwrite) throw new FsError('FileExists', to);
      this.delete(dst, true);
    }
    this.copyTree(src, dst);
    this.delete(src, true);
  }

  private copyTree(src: string, dst: string): void {
    const node = this.lookup(src)!;
    if (node.type === 'dir') {
      const opaque = this.upper.get(dst)?.kind === 'deleted';
      this.upper.set(dst, { kind: 'node', node: { ...node }, opaque });
      for (const [name] of this.readdir(src)) this.copyTree(join(src, name), join(dst, name));
    } else {
      this.upper.set(dst, { kind: 'node', node: { ...node } });
    }
  }

  // ---- change tracking ----------------------------------------------------

  isDirty(): boolean {
    return this.upper.size > 0;
  }

  changes(): Change[] {
    const out: Change[] = [];
    for (const [p, u] of [...this.upper].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (u.kind === 'deleted') {
        out.push({ path: p, status: 'deleted', type: this.base.get(p)?.type ?? 'file' });
        continue;
      }
      const inBase = this.baseVisible(p);
      if (u.node.type === 'dir') {
        // Only report directories that are new and have no reported children, or that were replaced.
        const hasChildren = [...this.upper.keys()].some((k) => k !== p && isUnder(k, p));
        if ((!inBase || u.opaque) && !hasChildren)
          out.push({ path: p, status: inBase ? 'modified' : 'added', type: 'dir' });
        continue;
      }
      out.push({ path: p, status: inBase ? 'modified' : 'added', type: u.node.type });
    }
    return out;
  }

  /** Base (pre-edit) content of a path, if it existed. */
  original(p: string): FsNode | undefined {
    return this.baseVisible(p) || this.upper.get(p)?.kind === 'deleted' ? this.base.get(p) : undefined;
  }

  discard(p: string): void {
    for (const k of [...this.upper.keys()]) if (k === p || isUnder(k, p)) this.upper.delete(k);
  }

  discardAll(): void {
    this.upper.clear();
  }

  /** Build the tar entries for the upper layer, including parent directories and whiteouts. */
  toLayerEntries(): TarEntry[] {
    const paths = [...this.upper.keys()].filter((p) => p !== '');
    const all = new Set<string>(paths);
    for (const p of paths) for (const a of ancestors(p)) all.add(a);
    const entries: TarEntry[] = [];
    for (const p of [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const u = this.upper.get(p);
      if (u?.kind === 'deleted') {
        entries.push({
          path: join(dirname(p), WH_PREFIX + basename(p)),
          type: 'file',
          mode: 0,
          uid: 0,
          gid: 0,
          mtime: 0,
          data: new Uint8Array(),
        });
        continue;
      }
      const node = u?.node ?? this.lookup(p);
      if (!node) continue;
      const { data, ...meta } = node;
      entries.push({ ...meta, path: p, data: node.type === 'file' ? data : undefined });
      if (u?.opaque)
        entries.push({
          path: join(p, WH_OPAQUE),
          type: 'file',
          mode: 0,
          uid: 0,
          gid: 0,
          mtime: 0,
          data: new Uint8Array(),
        });
    }
    return entries;
  }

  /** Make the upper layer part of the base (after a successful commit). */
  flatten(): void {
    this.base.applyLayer(this.toLayerEntries());
    this.upper.clear();
  }

  // ---- persistence --------------------------------------------------------

  serialize(): unknown {
    return [...this.upper].map(([p, u]) =>
      u.kind === 'deleted' ? [p, 0] : [p, { ...u.node, data: u.node.data && toBase64(u.node.data) }, u.opaque ? 1 : 0],
    );
  }

  restore(state: unknown): void {
    this.upper.clear();
    if (!Array.isArray(state)) return;
    for (const [p, n, opaque] of state as [string, 0 | (Omit<FsNode, 'data'> & { data?: string }), number?][]) {
      if (n === 0) this.upper.set(p, { kind: 'deleted' });
      else
        this.upper.set(p, {
          kind: 'node',
          node: { ...n, data: n.data ? fromBase64(n.data) : undefined },
          opaque: !!opaque,
        });
    }
  }
}
