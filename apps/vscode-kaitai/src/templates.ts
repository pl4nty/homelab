// Compiles .ksy specs on demand and caches the result per URI and source text. Shared by the
// structure session (parsing) and the .ksy language features (diagnostics), so a spec is compiled
// once per edit.
import * as vscode from 'vscode';
import { compileTemplate, type KsyError, type Template, toKsyError } from './engine/kaitai.ts';
import { importReader, readSpec } from './imports.ts';

export interface CompileResult {
  template?: Template;
  error?: KsyError;
}

interface Entry {
  source: string;
  result: Promise<CompileResult>;
  /** Imported spec files read so far. */
  imports: Set<string>;
  /** Compiled without error. Until then any spec change may affect the outcome. */
  ok?: boolean;
}

const DEBOUNCE_MS = 300;

export class Templates implements vscode.Disposable {
  /** Latest compilation per spec URI. */
  private readonly cache = new Map<string, Entry>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  /**
   * Fires when a .ksy file changes in an editor or on disk (debounced). Cached compilations of the
   * spec, and of specs that import it, are dropped first.
   */
  readonly onDidChangeSpec = this.changed.event;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[];

  constructor() {
    const touch = (uri: vscode.Uri) => {
      if (!uri.path.endsWith('.ksy')) return;
      const key = uri.toString();
      clearTimeout(this.timers.get(key));
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          for (const [spec, e] of this.cache) if (spec === key || !e.ok || e.imports.has(key)) this.cache.delete(spec);
          this.changed.fire(uri);
        }, DEBOUNCE_MS),
      );
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.ksy');
    this.disposables = [
      this.changed,
      watcher,
      watcher.onDidChange(touch),
      watcher.onDidCreate(touch),
      watcher.onDidDelete(touch),
      vscode.workspace.onDidChangeTextDocument((e) => touch(e.document.uri)),
      vscode.workspace.onDidSaveTextDocument((d) => touch(d.uri)),
    ];
  }

  /** Reads the spec (open editor text first) and compiles it. Rejects when it cannot be read. */
  async compileUri(uri: vscode.Uri): Promise<CompileResult> {
    return this.compile(uri, await readSpec(uri));
  }

  /** Compiles `source` as the spec at `uri`. Cached until the source or an import changes. */
  compile(uri: vscode.Uri, source: string): Promise<CompileResult> {
    const key = uri.toString();
    const hit = this.cache.get(key);
    if (hit?.source === source) return hit.result;
    const imports = new Set<string>();
    const result = compileTemplate(
      source,
      importReader(uri, (u) => imports.add(u.toString())),
    ).then(
      (template): CompileResult => {
        entry.ok = true;
        return { template };
      },
      (e): CompileResult => ({ error: toKsyError(e) }),
    );
    const entry: Entry = { source, result, imports };
    this.cache.set(key, entry);
    return result;
  }

  /** Drops the cached compilation of a spec, or all of them. */
  invalidate(uri?: vscode.Uri) {
    if (uri) this.cache.delete(uri.toString());
    else this.cache.clear();
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}
