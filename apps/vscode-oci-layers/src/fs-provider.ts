// oci-layer:  read/write merged view of an image (base layers + pending edits)
// oci-layer-base:  read-only view of the base layers, used as the "original" side of diffs

import * as vscode from 'vscode';
import { FsError, type FsNode, type Overlay } from './core/overlay.ts';
import { normalizePath } from './core/tar.ts';
import type { SessionStore } from './session-store.ts';

const pathOf = (uri: vscode.Uri) => normalizePath(uri.path);

function fileType(node: FsNode, isLink = false): vscode.FileType {
  const t = node.type === 'dir' ? vscode.FileType.Directory : node.type === 'file' ? vscode.FileType.File : node.type === 'symlink' ? vscode.FileType.SymbolicLink : vscode.FileType.Unknown;
  return isLink && t !== vscode.FileType.SymbolicLink ? t | vscode.FileType.SymbolicLink : t;
}

function toStat(node: FsNode, isLink = false): vscode.FileStat {
  return {
    type: fileType(node, isLink),
    ctime: node.mtime * 1000,
    mtime: node.mtime * 1000,
    size: node.data?.length ?? 0,
  };
}

function mapError(e: unknown, uri: vscode.Uri): never {
  if (e instanceof FsError) throw vscode.FileSystemError[e.code](uri);
  throw e;
}

export class ImageFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;
  private readonly store: SessionStore;

  constructor(store: SessionStore) { this.store = store; }

  fire(events: vscode.FileChangeEvent[]): void { this._onDidChangeFile.fire(events); }

  private async run<T>(uri: vscode.Uri, fn: (o: Overlay) => T, mutates?: vscode.FileChangeEvent[]): Promise<T> {
    const session = await this.store.load(uri.authority);
    try {
      const result = fn(session.overlay);
      if (mutates) {
        this.store.changed(uri.authority);
        this._onDidChangeFile.fire(mutates);
      }
      return result;
    } catch (e) {
      mapError(e, uri);
    }
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

  stat(uri: vscode.Uri) {
    return this.run(uri, (o) => { const s = o.stat(pathOf(uri)); return toStat(s.node, s.isLink); });
  }

  readDirectory(uri: vscode.Uri) {
    return this.run(uri, (o) => {
      const dir = o.resolve(pathOf(uri));
      return o.readdir(pathOf(uri)).map(([name, node]): [string, vscode.FileType] => {
        if (node.type !== 'symlink') return [name, fileType(node)];
        try {
          return [name, fileType(o.stat(dir ? `${dir}/${name}` : name).node, true)];
        } catch {
          return [name, vscode.FileType.SymbolicLink]; // dangling
        }
      });
    });
  }

  readFile(uri: vscode.Uri) { return this.run(uri, (o) => o.readFile(pathOf(uri))); }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }) {
    return this.run(uri, (o) => {
      const existed = !!o.lookup(o.resolve(pathOf(uri)));
      o.writeFile(pathOf(uri), content, options);
      return existed;
    }).then((existed) => {
      this.store.changed(uri.authority);
      this._onDidChangeFile.fire([{ type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
    });
  }

  createDirectory(uri: vscode.Uri) {
    return this.run(uri, (o) => { o.mkdir(pathOf(uri)); }, [{ type: vscode.FileChangeType.Created, uri }]);
  }

  delete(uri: vscode.Uri, options: { recursive: boolean }) {
    return this.run(uri, (o) => { o.delete(pathOf(uri), options.recursive); }, [{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }) {
    return this.run(oldUri, (o) => { o.rename(pathOf(oldUri), pathOf(newUri), options.overwrite); }, [
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }
}

/** Read-only base layers. Paths are real (symlink-free) paths as reported by Overlay.changes(). */
export class BaseFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;
  private readonly store: SessionStore;

  constructor(store: SessionStore) { this.store = store; }

  fire(events: vscode.FileChangeEvent[]): void { this._onDidChangeFile.fire(events); }

  private async node(uri: vscode.Uri): Promise<FsNode> {
    const session = await this.store.load(uri.authority);
    const node = session.overlay.original(pathOf(uri));
    if (!node) throw vscode.FileSystemError.FileNotFound(uri);
    return node;
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  async stat(uri: vscode.Uri) { return toStat(await this.node(uri)); }
  async readFile(uri: vscode.Uri) { return (await this.node(uri)).data ?? new Uint8Array(); }
  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const session = await this.store.load(uri.authority);
    const p = pathOf(uri);
    return session.overlay.base.list(p).map((n) => [n, fileType(session.overlay.base.get(p ? `${p}/${n}` : n)!)]);
  }
  private readonly ro = () => { throw vscode.FileSystemError.NoPermissions('base image layers are read-only'); };
  writeFile = this.ro;
  createDirectory = this.ro;
  delete = this.ro;
  rename = this.ro;
}

