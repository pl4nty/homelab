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
  /** Why the applied spec could not be read or compiled. */
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

/** Remembered spec URIs, in workspace state: per file URI, and per file extension. */
type Remembered = 'kaitai.byFile' | 'kaitai.byExtension';

const autoApplyByExtension = () => vscode.workspace.getConfiguration('kaitai').get('autoApplyByExtension', true);
const extensionOf = (uri: vscode.Uri) => /\.([^./]+)$/.exec(uri.path)?.[1].toLowerCase();
const setContext = (key: string, value: boolean) => void vscode.commands.executeCommand('setContext', key, value);

export class Session implements vscode.Disposable {
  private readonly docs = new Map<string, KaitaiDocument>();
  private activeDoc?: KaitaiDocument;
  /** Latest reparse of each document. `stale`: its data, params or spec changed since the last parse. */
  private readonly runs = new WeakMap<KaitaiDocument, { stale: boolean }>();
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
  private readonly disposables: vscode.Disposable[];

  readonly templates: Templates;

  constructor(templates: Templates, memento: vscode.Memento) {
    this.templates = templates;
    this.memento = memento;
    this.disposables = [
      this.activeEmitter,
      this.parseEmitter,
      this.selectionEmitter,
      this.highlightEmitter,
      // Specs the change does not affect come back from the compile cache, and are not parsed again.
      templates.onDidChangeSpec(() => {
        for (const doc of this.docs.values()) if (doc.specUri) void this.reparse(doc, false);
      }),
    ];
  }

  get active() {
    return this.activeDoc;
  }

  get(uri: vscode.Uri) {
    return this.docs.get(uri.toString());
  }

  /** Called by the hex editor when it opens a file. Applies a remembered spec. */
  open(uri: vscode.Uri, data: Uint8Array): KaitaiDocument {
    let doc = this.get(uri);
    if (doc) {
      doc.data = data;
      return doc;
    }
    doc = new KaitaiDocument(uri, data);
    this.docs.set(uri.toString(), doc);
    const ext = extensionOf(uri);
    const spec =
      this.remembered('kaitai.byFile')[uri.toString()] ??
      (ext && autoApplyByExtension() ? this.remembered('kaitai.byExtension')[ext] : undefined);
    if (spec) void this.setSpec(doc, vscode.Uri.parse(spec), false);
    return doc;
  }

  close(doc: KaitaiDocument) {
    this.docs.delete(doc.uri.toString());
    if (this.activeDoc === doc) this.setActive(undefined);
  }

  setActive(doc: KaitaiDocument | undefined) {
    if (this.activeDoc === doc) return;
    this.activeDoc = doc;
    this.updateContext();
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
    if (remember) await this.remember('kaitai.byFile', { [doc.uri.toString()]: specUri });
    await this.reparse(doc);
    const extensions = doc.template?.fileExtensions;
    if (!remember || !specUri || !extensions?.length || doc.specUri !== specUri) return;
    await this.remember('kaitai.byExtension', Object.fromEntries(extensions.map((ext) => [ext, specUri])));
    if (!autoApplyByExtension()) return;
    // Apply to other open files that match and have no spec yet.
    for (const other of this.docs.values()) {
      if (!other.specUri && extensions.includes(extensionOf(other.uri) ?? '')) void this.setSpec(other, specUri, false);
    }
  }

  private remembered(key: Remembered) {
    return this.memento.get<Record<string, string>>(key, {});
  }

  private remember(key: Remembered, specs: Record<string, vscode.Uri | undefined>) {
    const all = { ...this.remembered(key) };
    for (const [name, uri] of Object.entries(specs)) {
      if (uri) all[name] = uri.toString();
      else delete all[name];
    }
    return this.memento.update(key, all);
  }

  /**
   * Compiles the spec (cached) and parses the file. With `stale` false, the file is parsed only
   * when the spec compiled anew.
   */
  async reparse(doc: KaitaiDocument, stale = true) {
    // A run that gets superseded hands its staleness on.
    const run = { stale: stale || !!this.runs.get(doc)?.stale };
    this.runs.set(doc, run);
    const { specUri } = doc;
    let template: Template | undefined;
    let specError: string | undefined;
    if (specUri) {
      try {
        const compiled = await this.templates.compileUri(specUri);
        template = compiled.template;
        specError = compiled.error && formatSpecError(compiled.error);
      } catch (e) {
        specError = `Cannot read ${specUri.path}: ${(e as Error).message}`;
      }
      if (this.runs.get(doc) !== run) return; // a newer reparse started
      if (!run.stale && template && template === doc.template) return;
    }
    run.stale = false;
    doc.template = template;
    doc.specError = specError;
    doc.result = template && parse(doc, template);
    doc.version++;
    if (doc === this.activeDoc) this.updateContext();
    this.parseEmitter.fire(doc);
  }

  private updateContext() {
    const doc = this.activeDoc;
    setContext('kaitai.hasActiveDocument', !!doc);
    setContext('kaitai.hasSpec', !!doc?.specUri);
    setContext('kaitai.hasParams', !!doc?.template?.params.length);
  }

  /** Changes the selection and notifies views. The tree passes its node; the hex view does not. */
  select(
    doc: KaitaiDocument,
    range: ByteRange,
    source: SelectionSource,
    opts: { reveal?: boolean; node?: StructureNode } = {},
  ) {
    doc.selection = range;
    const node = opts.node ?? findDeepestNode(doc.roots, range.start);
    this.selectionEmitter.fire({ doc, range, source, reveal: opts.reveal ?? source !== 'hex', node });
  }

  highlight(doc: KaitaiDocument, range?: ByteRange) {
    this.highlightEmitter.fire({ doc, range });
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

/** Parses the whole file with the template, then each "parse selection as" range as an extra root. */
function parse(doc: KaitaiDocument, template: Template): ParseResult {
  const maxMB = vscode.workspace.getConfiguration('kaitai').get('maxFileSizeMB', 256);
  if (doc.data.byteLength > maxMB * 1024 * 1024) {
    return { roots: [], error: `File is larger than kaitai.maxFileSizeMB (${maxMB} MB)` };
  }
  const result = template.parse(doc.data, { params: doc.params });
  for (const { typeName, start, end } of doc.extraParses) {
    const rootName = `${typeName}@0x${start.toString(16).toUpperCase()}`;
    result.roots.push(
      ...template.parse(doc.data.subarray(start, end), { typeName, baseOffset: start, rootName }).roots,
    );
  }
  return result;
}

export function formatSpecError(e: { message: string; path?: string[]; file?: string }) {
  const where = [e.file, e.path && `/${e.path.join('/')}`].filter(Boolean).join(': ');
  return where ? `${where}: ${e.message}` : e.message;
}
