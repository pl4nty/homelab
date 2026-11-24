// Compiles .ksy specs on demand and caches the result per URI and source text. Shared by the
// structure session (parsing) and the .ksy language features (diagnostics), so a spec is compiled
// once per edit.
import * as vscode from 'vscode';
import { compileTemplate, type KsyError, type Template, toKsyError } from './engine/kaitai.ts';
import { importReader } from './imports.ts';

export interface CompileResult {
  uri: vscode.Uri;
  source: string;
  template?: Template;
  error?: KsyError;
  /** Imported spec files that were read, for change tracking. */
  imports: vscode.Uri[];
}

export class Templates implements vscode.Disposable {
  private readonly cache = new Map<string, Promise<CompileResult>>();
  private readonly emitter = new vscode.EventEmitter<CompileResult>();
  /** Fires after every compilation that was not served from cache. */
  readonly onDidCompile = this.emitter.event;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  /** Fires when a spec, or a file it imports, changes (debounced). */
  readonly onDidChangeSpec = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter, this.changed];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    const touch = (uri: vscode.Uri) => {
      if (!uri.path.endsWith('.ksy')) return;
      const key = uri.toString();
      clearTimeout(this.timers.get(key));
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          this.changed.fire(uri);
        }, 300),
      );
    };
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => touch(e.document.uri)),
      vscode.workspace.onDidSaveTextDocument((d) => touch(d.uri)),
    );
    try {
      const watcher = vscode.workspace.createFileSystemWatcher('**/*.ksy');
      watcher.onDidChange(touch);
      watcher.onDidCreate(touch);
      this.disposables.push(watcher);
    } catch {
      // Not every file system supports watching.
    }
  }

  /** Reads the spec (open editor text first) and compiles it. */
  async compileUri(uri: vscode.Uri): Promise<CompileResult> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const source = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    return this.compile(uri, source);
  }

  /** Compiles `source` as the spec at `uri`. Cached on (uri, source). */
  compile(uri: vscode.Uri, source: string): Promise<CompileResult> {
    const key = `${uri.toString()}\0${source}`;
    let p = this.cache.get(key);
    if (!p) {
      // Keep only the latest source per URI.
      for (const k of this.cache.keys()) if (k.startsWith(`${uri.toString()}\0`)) this.cache.delete(k);
      const imports: vscode.Uri[] = [];
      p = compileTemplate(source, importReader(uri, (u) => imports.push(u))).then(
        (template) => ({ uri, source, template, imports }),
        (e) => ({ uri, source, error: toKsyError(e), imports }),
      );
      p.then((r) => this.emitter.fire(r));
      this.cache.set(key, p);
    }
    return p;
  }

  /** Drops cached results, e.g. after an imported file changed. */
  invalidate(uri?: vscode.Uri) {
    if (!uri) this.cache.clear();
    else for (const k of this.cache.keys()) if (k.startsWith(`${uri.toString()}\0`)) this.cache.delete(k);
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}
