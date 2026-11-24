// Read-only in-memory file system for bytes that have no file of their own, such as decompressed
// streams. `kaitai-bytes:/<id>/<name>` opens in the Kaitai Hex Editor like any other file.
import * as vscode from 'vscode';

export const SCHEME = 'kaitai-bytes';

const uriOf = (tab: vscode.Tab) => (tab.input as { uri?: vscode.Uri } | undefined)?.uri;

export class StreamFs implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly files = new Map<string, Uint8Array>();
  private next = 1;
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  // Frees a stream once its last editor tab is closed.
  private readonly tabs = vscode.window.tabGroups.onDidChangeTabs(({ closed }) => {
    for (const uri of closed.map(uriOf)) {
      if (uri?.scheme !== SCHEME) continue;
      const open = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => uriOf(t)?.path === uri.path));
      if (!open) this.files.delete(uri.path);
    }
  });

  /** Adds a file and opens it in the hex editor. */
  async open(name: string, data: Uint8Array) {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${this.next++}/${name.replace(/[/\\]/g, '_')}` });
    this.files.set(uri.path, data);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'kaitai.hexEditor');
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const size = this.files.get(uri.path)?.byteLength;
    // Every file has a folder of its own.
    if (size === undefined && !/^\/\d*$/.test(uri.path)) throw vscode.FileSystemError.FileNotFound(uri);
    const type = size === undefined ? vscode.FileType.Directory : vscode.FileType.File;
    return { type, ctime: 0, mtime: 0, size: size ?? 0, permissions: vscode.FilePermission.Readonly };
  }

  readFile(uri: vscode.Uri) {
    const data = this.files.get(uri.path);
    if (!data) throw vscode.FileSystemError.FileNotFound(uri);
    return data;
  }

  watch(): vscode.Disposable {
    return { dispose() {} };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    this.files.delete(uri.path);
  }

  dispose() {
    this.tabs.dispose();
    this.emitter.dispose();
  }
}
