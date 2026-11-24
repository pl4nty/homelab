// Per-file parse state shared by the hex editor, structure tree, value inspector and commands.
import * as vscode from 'vscode';
import type { Template } from './engine/kaitai.ts';
import { type ByteRange, findDeepestNode, type ParseResult, type StructureNode } from './engine/structure.ts';
import type { Templates } from './templates.ts';

export type SelectionSource = 'hex' | 'tree' | 'command';

export class KaitaiDocument {
  readonly uri: vscode.Uri;
  data: Uint8Array;
  /** Spec applied to this file, if any. */
  specUri?: vscode.Uri;
  template?: Template;
  result?: ParseResult;
  /** Compile error of the applied spec. */
  specError?: string;
  /** Increases on every parse (or clear). */
  version = 0;
  selection: ByteRange = { start: 0, end: 0 };
  /** Values for the spec's top-level `params`, in order. */
  params?: unknown[];
  /** Extra roots: byte ranges parsed as a chosen user type ("parse selection as"). */
  extraParses: { typeName: string; start: number; end: number }[] = [];

  constructor(uri: vscode.Uri, data: Uint8Array) {
    this.uri = uri;
    this.data = data;
  }

  get roots(): StructureNode[] {
    return this.result?.roots ?? [];
  }

  get fileName() {
    return this.uri.path.split('/').pop() ?? this.uri.path;
  }
}

export interface SelectionEvent {
  doc: KaitaiDocument;
  range: ByteRange;
  source: SelectionSource;
  /** Scroll the hex view to the range. */
  reveal: boolean;
  /** Node chosen in the tree, or the deepest node at the caret. */
  node?: StructureNode;
}

export class Session implements vscode.Disposable {
  private readonly docs = new Map<string, KaitaiDocument>();
  private activeDoc?: KaitaiDocument;
  /** Spec URI chosen for each file extension, for kaitai.autoApplyByExtension. */
  private readonly byExtension = new Map<string, vscode.Uri>();
  private readonly memento: vscode.Memento;

  private readonly activeEmitter = new vscode.EventEmitter<KaitaiDocument | undefined>();
  readonly onDidChangeActive = this.activeEmitter.event;
  private readonly parseEmitter = new vscode.EventEmitter<KaitaiDocument>();
  /** After a parse, a spec change or a clear. */
  readonly onDidParse = this.parseEmitter.event;
  private readonly selectionEmitter = new vscode.EventEmitter<SelectionEvent>();
  readonly onDidChangeSelection = this.selectionEmitter.event;
  private readonly highlightEmitter = new vscode.EventEmitter<{ doc: KaitaiDocument; range?: ByteRange }>();
  readonly onDidHighlight = this.highlightEmitter.event;
  private readonly disposables: vscode.Disposable[] = [
    this.activeEmitter,
    this.parseEmitter,
    this.selectionEmitter,
    this.highlightEmitter,
  ];

  readonly templates: Templates;

  constructor(templates: Templates, memento: vscode.Memento) {
    this.templates = templates;
    this.memento = memento;
    for (const [ext, uri] of Object.entries(memento.get<Record<string, string>>('kaitai.byExtension', {}))) {
      this.byExtension.set(ext, vscode.Uri.parse(uri));
    }
    this.disposables.push(
      templates.onDidChangeSpec((uri) => {
        templates.invalidate(uri);
        for (const doc of this.docs.values()) {
          if (doc.specUri && (doc.specUri.toString() === uri.toString() || doc.template)) {
            // Imports may have changed too; reparse every doc that has a spec. Compiles are cached.
            if (doc.specUri.toString() !== uri.toString()) templates.invalidate(doc.specUri);
            void this.reparse(doc);
          }
        }
      }),
    );
  }

  get active() {
    return this.activeDoc;
  }

  get documents(): Iterable<KaitaiDocument> {
    return this.docs.values();
  }

  get(uri: vscode.Uri) {
    return this.docs.get(uri.toString());
  }

  /** Called by the hex editor when it opens a file. Applies a remembered spec. */
  open(uri: vscode.Uri, data: Uint8Array): KaitaiDocument {
    let doc = this.docs.get(uri.toString());
    if (doc) {
      doc.data = data;
      return doc;
    }
    doc = new KaitaiDocument(uri, data);
    this.docs.set(uri.toString(), doc);
    const perFile = this.memento.get<Record<string, string>>('kaitai.byFile', {})[uri.toString()];
    const ext = extensionOf(uri);
    const spec = perFile
      ? vscode.Uri.parse(perFile)
      : vscode.workspace.getConfiguration('kaitai').get('autoApplyByExtension', true) && ext
        ? this.byExtension.get(ext)
        : undefined;
    if (spec) void this.setSpec(doc, spec, false);
    return doc;
  }

  close(doc: KaitaiDocument) {
    this.docs.delete(doc.uri.toString());
    if (this.activeDoc === doc) this.setActive(undefined);
  }

  setActive(doc: KaitaiDocument | undefined) {
    if (this.activeDoc === doc) return;
    this.activeDoc = doc;
    void vscode.commands.executeCommand('setContext', 'kaitai.hasActiveDocument', !!doc);
    void vscode.commands.executeCommand('setContext', 'kaitai.hasSpec', !!doc?.specUri);
    this.activeEmitter.fire(doc);
  }

  /** Replaces the file contents (e.g. after an external change) and reparses. */
  async setData(doc: KaitaiDocument, data: Uint8Array) {
    doc.data = data;
    await this.reparse(doc);
  }

  /** Applies a spec to a file and remembers it for the file and its extension. */
  async setSpec(doc: KaitaiDocument, specUri: vscode.Uri | undefined, remember = true) {
    if (doc.specUri?.toString() !== specUri?.toString()) {
      doc.params = undefined;
      doc.extraParses = [];
    }
    doc.specUri = specUri;
    if (remember) {
      const byFile = { ...this.memento.get<Record<string, string>>('kaitai.byFile', {}) };
      if (specUri) byFile[doc.uri.toString()] = specUri.toString();
      else delete byFile[doc.uri.toString()];
      await this.memento.update('kaitai.byFile', byFile);
    }
    if (doc === this.activeDoc) void vscode.commands.executeCommand('setContext', 'kaitai.hasSpec', !!specUri);
    await this.reparse(doc);
    if (remember && specUri && doc.template) {
      for (const ext of doc.template.fileExtensions) this.byExtension.set(ext.toLowerCase(), specUri);
      await this.memento.update(
        'kaitai.byExtension',
        Object.fromEntries([...this.byExtension].map(([k, v]) => [k, v.toString()])),
      );
      // Apply to other open files that match and have no spec yet.
      if (vscode.workspace.getConfiguration('kaitai').get('autoApplyByExtension', true)) {
        for (const other of this.docs.values()) {
          const ext = extensionOf(other.uri);
          if (other !== doc && !other.specUri && ext && doc.template.fileExtensions.includes(ext)) {
            void this.setSpec(other, specUri, false);
          }
        }
      }
    }
  }

  /** Compiles the spec (cached) and parses the file. */
  async reparse(doc: KaitaiDocument) {
    const version = ++doc.version;
    if (!doc.specUri) {
      doc.template = doc.result = doc.specError = undefined;
      this.parseEmitter.fire(doc);
      return;
    }
    const max = vscode.workspace.getConfiguration('kaitai').get('maxFileSizeMB', 256) * 1024 * 1024;
    let compiled: Awaited<ReturnType<Templates['compileUri']>>;
    try {
      compiled = await this.templates.compileUri(doc.specUri);
    } catch (e) {
      if (version !== doc.version) return;
      doc.template = doc.result = undefined;
      doc.specError = `Cannot read ${doc.specUri.path}: ${(e as Error).message}`;
      this.parseEmitter.fire(doc);
      return;
    }
    if (version !== doc.version) return; // a newer reparse started
    doc.template = compiled.template;
    doc.specError = compiled.error && formatSpecError(compiled.error);
    doc.result = !compiled.template
      ? undefined
      : doc.data.byteLength > max
        ? { roots: [], error: `File is larger than kaitai.maxFileSizeMB (${max / 1048576} MB)` }
        : compiled.template.parse(doc.data, { params: doc.params });
    if (doc.result && compiled.template) {
      for (const x of doc.extraParses) {
        const r = compiled.template.parse(doc.data.subarray(x.start, x.end), {
          typeName: x.typeName,
          baseOffset: x.start,
          rootName: `${x.typeName}@0x${x.start.toString(16).toUpperCase()}`,
        });
        doc.result.roots.push(...r.roots);
      }
    }
    this.parseEmitter.fire(doc);
  }

  /** Changes the selection and notifies views. The tree passes its node; the hex view does not. */
  select(
    doc: KaitaiDocument,
    range: ByteRange,
    source: SelectionSource,
    opts: { reveal?: boolean; node?: StructureNode } = {},
  ) {
    doc.selection = range;
    const node = opts.node ?? (doc.result ? findDeepestNode(doc.roots, range.start) : undefined);
    this.selectionEmitter.fire({ doc, range, source, reveal: opts.reveal ?? source !== 'hex', node });
  }

  highlight(doc: KaitaiDocument, range?: ByteRange) {
    this.highlightEmitter.fire({ doc, range });
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

function extensionOf(uri: vscode.Uri) {
  const m = /\.([^./]+)$/.exec(uri.path);
  return m?.[1].toLowerCase();
}

export function formatSpecError(e: { message: string; path?: string[]; file?: string }) {
  const where = [e.file, e.path && `/${e.path.join('/')}`].filter(Boolean).join(': ');
  return where ? `${where}: ${e.message}` : e.message;
}
