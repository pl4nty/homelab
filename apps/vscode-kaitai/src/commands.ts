// Commands that act on the active document or on a node of the structure tree.
import * as vscode from 'vscode';
import { findDeepestNode, type StructureNode, toJson } from './engine/structure.ts';
import type { KaitaiDocument, Session } from './session.ts';
import { SCHEME, StreamFs } from './streamFs.ts';
import { COPY_FORMATS, type CopyFormat } from './util/copyAs.ts';
import { insertSeqItems, typeChoices } from './util/insertField.ts';
import { INVALID, parseParamValue, parseRange } from './util/parse.ts';
import { findAll, parseNeedle } from './util/search.ts';

const FIND_LIMIT = 5000;

const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;
const warn = (message: string) => void vscode.window.showWarningMessage(message);
const copy = async (text: string, what: string) => {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(`Copied ${what}`, 3000);
};
/** `<file>.<node>.<ext>`, for bytes or JSON taken from a node of the file. */
const siblingName = (doc: KaitaiDocument, node: StructureNode, ext: string) =>
  `${doc.fileName}.${node.name.replace(/[^\w.-]+/g, '_')}.${ext}`;

export function registerCommands(session: Session): vscode.Disposable {
  const streams = new StreamFs();

  /** A command on the active document; without one, offers to open a file. */
  const onDoc =
    (run: (doc: KaitaiDocument, arg?: unknown) => unknown) =>
    (arg?: unknown): unknown => {
      if (session.active) return run(session.active, arg);
      void vscode.window
        .showWarningMessage('Open a file in the Kaitai Hex Editor first.', 'Open File…')
        .then((a) => a && vscode.commands.executeCommand('kaitai.openInHexEditor'));
    };
  /** A context menu command of the structure tree. */
  const onNode = (run: (node: StructureNode, doc: KaitaiDocument) => unknown) => (node?: StructureNode) =>
    node && session.active && run(node, session.active);
  const reveal = (doc: KaitaiDocument, start: number, end: number) =>
    session.select(doc, { start, end }, 'command', { reveal: true });

  const commands: Record<string, (...args: never[]) => unknown> = {
    'kaitai.loadTemplate': onDoc(async (doc, arg) => {
      const uri = arg instanceof vscode.Uri ? arg : await pickSpec(doc.fileName);
      if (!uri) return;
      await session.setSpec(doc, uri);
      if (doc.specError) void vscode.window.showErrorMessage(`Spec error: ${doc.specError}`);
      void vscode.commands.executeCommand('kaitai.structure.focus');
    }),
    'kaitai.clearTemplate': onDoc((doc) => session.setSpec(doc, undefined)),
    'kaitai.reparse': onDoc((doc) => {
      if (doc.specUri) session.templates.invalidate(doc.specUri);
      return session.reparse(doc);
    }),
    'kaitai.setParams': onDoc(async (doc) => {
      const params = doc.template?.params;
      if (!params) return;
      if (!params.length) return void vscode.window.showInformationMessage('This spec has no top-level params.');
      const values: unknown[] = [];
      for (const [i, p] of params.entries()) {
        const prev = doc.params?.[i];
        const input = await vscode.window.showInputBox({
          title: `Spec param ${i + 1}/${params.length}: ${p.id}${p.type ? ` (${p.type})` : ''}`,
          prompt: p.doc ?? 'Number (0x hex ok), true/false, "string", or [bytes]',
          value: prev === undefined ? '' : formatParam(prev),
          validateInput: (v) => (parseParamValue(v, p.type) === INVALID ? 'Cannot parse this value' : undefined),
        });
        if (input === undefined) return;
        values.push(parseParamValue(input, p.type));
      }
      doc.params = values;
      await session.reparse(doc);
    }),
    'kaitai.parseSelectionAs': onDoc(async (doc) => {
      const names = doc.template?.typeNames ?? [];
      if (!names.length) return warn('The spec has no user types.');
      const { start } = doc.selection;
      const end = doc.selection.end > start ? doc.selection.end : doc.data.byteLength;
      const typeName = await vscode.window.showQuickPick(names, {
        placeHolder: `Parse ${hex(start)}–${hex(end - 1)} (${end - start} bytes) as…`,
      });
      if (!typeName) return;
      doc.extraParses.push({ typeName, start, end });
      await session.reparse(doc);
    }),
    'kaitai.removeParse': onNode(async (node, doc) => {
      // The extra parses are the last roots, in order.
      const i = doc.roots.indexOf(node) - (doc.roots.length - doc.extraParses.length);
      if (i < 0) return;
      doc.extraParses.splice(i, 1);
      await session.reparse(doc);
    }),
    'kaitai.addFieldFromSelection': onDoc((doc) => addFieldFromSelection(doc)),
    'kaitai.find': onDoc(async (doc) => {
      const endian = doc.template?.endian === 'be' ? 'be' : 'le';
      const query = await vscode.window.showInputBox({
        title: 'Find in file',
        prompt: `Typed value (u4le 1234, s2 -1, f4 1.5), string ("text", utf-16le "text") or hex (89 50 ?? 47). Default endianness: ${endian}.`,
        validateInput: (v) => {
          const r = parseNeedle(v, endian);
          return typeof r === 'string' ? r : undefined;
        },
      });
      const needle = query === undefined ? undefined : parseNeedle(query, endian);
      if (!needle || typeof needle === 'string') return;
      const hits = findAll(doc.data, needle, FIND_LIMIT);
      if (!hits.length) return void vscode.window.showInformationMessage(`No match for ${needle.label}`);
      const show = (hit: { offset: number }) => reveal(doc, hit.offset, hit.offset + needle.bytes.length);
      const items = hits.map((offset) => ({
        label: hex(offset),
        description: `${offset}`,
        detail: findDeepestNode(doc.roots, offset)?.id,
        offset,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: `${hits.length}${hits.length >= FIND_LIMIT ? '+' : ''} matches for ${needle.label}`,
        onDidSelectItem: (item) => show(item as (typeof items)[number]),
      });
      if (pick) show(pick);
    }),
    'kaitai.goToOffset': onDoc(async (doc) => {
      const size = doc.data.byteLength;
      const input = await vscode.window.showInputBox({
        prompt: `Offset or range (0x hex, or decimal). File is ${size} bytes.`,
        placeHolder: '0x1f4  |  500  |  0x10-0x20  |  0x10+16',
        validateInput: (v) => (parseRange(v, size) ? undefined : 'Enter an offset inside the file'),
      });
      const range = input && parseRange(input, size);
      if (range) reveal(doc, range.start, range.end);
    }),
    'kaitai.exportJson': onDoc(async (doc) => {
      const root = doc.roots[0];
      if (!root) return warn('Nothing parsed yet.');
      const json = JSON.stringify(toJson(root), null, 2);
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(doc.uri, '..', `${doc.fileName}.json`),
        filters: { JSON: ['json'] },
      });
      if (target) await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(json));
      // Without a target, the JSON still opens, as an untitled document.
      const shown = target ?? (await vscode.workspace.openTextDocument({ language: 'json', content: json })).uri;
      void vscode.window.showTextDocument(shown);
    }),
    'kaitai.exportNodeJson': onNode((node) => copy(JSON.stringify(toJson(node), null, 2), `${node.name} as JSON`)),
    'kaitai.copyValue': onNode(({ raw, value, name }) => {
      const text = raw instanceof Uint8Array ? Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('') : raw;
      return copy(String(text ?? value ?? ''), name);
    }),
    'kaitai.copyPath': onNode((node) => copy(toExpressionPath(node), 'path')),
    // From the hex view (its selection) or the structure tree (that field's bytes).
    'kaitai.copyAs': onDoc(async (doc, arg) => {
      const node = arg && typeof arg === 'object' && 'kind' in arg ? (arg as StructureNode) : undefined;
      const bytes = node
        ? node.range
          ? doc.data.subarray(node.range.start, node.range.end)
          : node.streamBytes?.()
        : doc.data.subarray(doc.selection.start, doc.selection.end);
      if (!(bytes instanceof Uint8Array) || !bytes.length) {
        return void vscode.window.showInformationMessage('Select some bytes in the Kaitai Hex Editor first.');
      }
      const pick = await vscode.window.showQuickPick(
        Object.entries(COPY_FORMATS).map(([id, f]) => ({ id: id as CopyFormat, label: f.label, detail: f.detail })),
        { placeHolder: `Copy ${bytes.length} bytes as` },
      );
      if (pick) await copy(COPY_FORMATS[pick.id].format(bytes), `${bytes.length} bytes as ${pick.label}`);
    }),
    'kaitai.exportBytes': onNode(async (node, doc) => {
      const { range } = node;
      if (!range) return;
      const defaultUri = vscode.Uri.joinPath(doc.uri, '..', siblingName(doc, node, 'bin'));
      const target = await vscode.window.showSaveDialog({ defaultUri });
      if (target) await vscode.workspace.fs.writeFile(target, doc.data.slice(range.start, range.end));
    }),
    'kaitai.openStream': onNode((node, doc) => {
      const bytes = node.streamBytes?.() ?? node.raw;
      // A copy: the bytes may be a view of the whole file, or of a parse result that gets replaced.
      if (bytes instanceof Uint8Array) return streams.open(siblingName(doc, node, 'bin'), bytes.slice());
    }),
  };

  return vscode.Disposable.from(
    streams,
    vscode.workspace.registerFileSystemProvider(SCHEME, streams, { isReadonly: true }),
    ...Object.entries(commands).map(([id, run]) => vscode.commands.registerCommand(id, run)),
  );
}

/** Asks for a spec: a .ksy file of the workspace, one from an open dialog, or the format gallery. */
/**
 * Workspace .ksy files. Falls back to walking the folders when file search finds nothing, because some web file
 * systems (e.g. vscode-test-web's mount) have no search provider.
 */
async function findSpecs(limit = 500): Promise<vscode.Uri[]> {
  const found = await vscode.workspace.findFiles('**/*.ksy', '**/node_modules/**', limit).then(
    (uris) => uris,
    () => [],
  );
  if (found.length) return found;
  const out: vscode.Uri[] = [];
  const walk = async (dir: vscode.Uri, depth: number): Promise<void> => {
    const entries = await vscode.workspace.fs.readDirectory(dir).then(
      (e) => e,
      () => [],
    );
    for (const [name, type] of entries) {
      if (out.length >= limit) return;
      if (name.startsWith('.') || name === 'node_modules') continue;
      const uri = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) {
        if (depth > 0) await walk(uri, depth - 1);
      } else if (name.toLowerCase().endsWith('.ksy')) out.push(uri);
    }
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) await walk(folder.uri, 6);
  return out;
}

async function pickSpec(fileName: string): Promise<vscode.Uri | undefined> {
  const found = await findSpecs();
  const browse: vscode.QuickPickItem = { label: '$(folder-opened) Browse…' };
  const gallery: vscode.QuickPickItem = { label: '$(library) Format Gallery…' };
  const files = found.map((uri) => ({
    label: uri.path.split('/').pop() as string,
    description: vscode.workspace.asRelativePath(uri),
    uri,
  }));
  const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { uri?: vscode.Uri }>(
    [...files, browse, gallery],
    { placeHolder: `Spec for ${fileName}`, matchOnDescription: true },
  );
  if (pick === gallery) void vscode.commands.executeCommand('kaitai.formats.focus');
  if (pick !== browse) return pick?.uri;
  const opened = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Load Spec',
    filters: { 'Kaitai Struct spec': ['ksy'] },
  });
  return opened?.[0];
}

/** Inserts a `seq` entry for the selected bytes into the spec, with a gap field before it if needed. */
async function addFieldFromSelection(doc: KaitaiDocument) {
  if (!doc.specUri) return warn('Load a spec first.');
  const { start, end } = doc.selection;
  if (end <= start) return warn('Select the bytes of the new field in the hex editor.');
  // The innermost struct that contains the selection and was read from the file.
  let container = findDeepestNode(doc.roots, start);
  while (container && (container.kind !== 'struct' || !container.range || container.range.end < end))
    container = container.parent;
  container ??= doc.roots[0];
  if (!container?.type || !container.range) return;
  const seqFields = container.children().filter((c) => !c.instance && c.range);
  const index = seqFields.filter((c) => c.range && c.range.end <= start).length;
  const prevEnd = seqFields[index - 1]?.range?.end ?? container.range.start;
  const choice = await vscode.window.showQuickPick(typeChoices(end - start, doc.template?.endian), {
    title: `New field in ${container.type}: ${hex(start)}, ${end - start} bytes`,
  });
  if (!choice) return;
  const id = await vscode.window.showInputBox({
    title: 'Field id',
    value: `field_${start.toString(16)}`,
    validateInput: (v) => (/^[a-z][a-z0-9_]*$/.test(v) ? undefined : 'Use lower_snake_case, starting with a letter'),
  });
  if (!id) return;
  const fields = [{ id, attrs: choice.attrs }];
  if (start > prevEnd) fields.unshift({ id: `unknown_${prevEnd.toString(16)}`, attrs: { size: start - prevEnd } });
  const text = await vscode.workspace.openTextDocument(doc.specUri);
  // Named by the field that follows: fields skipped by an `if` are not in the tree.
  const edit = insertSeqItems(text.getText(), container.type, seqFields[index]?.name, fields);
  if (typeof edit === 'string') return void vscode.window.showErrorMessage(edit);
  const position = text.positionAt(edit.offset);
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.insert(doc.specUri, position, edit.text);
  await vscode.workspace.applyEdit(workspaceEdit);
  const editor = await vscode.window.showTextDocument(text, { preview: false, preserveFocus: true });
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  // The spec change triggers a reparse through Templates.onDidChangeSpec.
}

/** `_root.chunks[0].len` style path for a node, usable in expressions. */
function toExpressionPath(node: StructureNode): string {
  let path = '';
  for (let n = node; n.parent; n = n.parent) {
    if (n.kind !== 'bucket') path = (n.name.startsWith('[') ? n.name : `.${n.name}`) + path;
  }
  return `_root${path}`;
}

function formatParam(v: unknown) {
  if (v instanceof Uint8Array) return `[${Array.from(v).join(', ')}]`;
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}
