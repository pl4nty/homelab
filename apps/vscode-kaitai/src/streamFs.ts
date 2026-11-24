// Read-only in-memory file system for bytes that have no file of their own, such as decompressed
// streams. `kaitai-bytes:/<id>/<name>` opens in the Kaitai Hex Editor like any other file.
import * as vscode from 'vscode';

export const SCHEME = 'kaitai-bytes';

export class StreamFs implements vscode.FileSystemProvider {
  private readonly files = new Map<string, Uint8Array>();
  private next = 1;
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  add(name: string, data: Uint8Array): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${this.next++}/${name.replace(/[/\\]/g, '_')}` });
    this.files.set(uri.path, data);
    return uri;
  }

  private get(uri: vscode.Uri) {
    const d = this.files.get(uri.path);
    if (!d) throw vscode.FileSystemError.FileNotFound(uri);
    return d;
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    if (!this.files.has(uri.path)) {
      if ([...this.files.keys()].some((k) => k.startsWith(`${uri.path.replace(/\/$/, '')}/`))) {
        return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      }
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: this.get(uri).byteLength,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  readFile(uri: vscode.Uri) {
    return this.get(uri);
  }

  watch(): vscode.Disposable {
    return { dispose() {} };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    this.files.delete(uri.path);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
