// Commands that act on the active document: load/clear spec, reparse, export, go to offset, copy.
import * as vscode from 'vscode';
import { findDeepestNode, type StructureNode, toJson } from './engine/structure.ts';
import type { KaitaiDocument, Session } from './session.ts';
import { SCHEME, StreamFs } from './streamFs.ts';
import { insertSeqItems, typeChoices } from './util/insertField.ts';
import { INVALID, parseParamValue, parseRange } from './util/parse.ts';
import { findAll, parseNeedle } from './util/search.ts';

export function registerCommands(_context: vscode.ExtensionContext, session: Session): vscode.Disposable {
  const need = (): KaitaiDocument | undefined => {
    const doc = session.active;
    if (!doc) {
      void vscode.window
        .showWarningMessage('Open a file in the Kaitai Hex Editor first.', 'Open File…')
        .then((a) => a && vscode.commands.executeCommand('kaitai.openInHexEditor'));
    }
    return doc;
  };

  const reg = (id: string, f: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, f);
  const streams = new StreamFs();

  return vscode.Disposable.from(
    vscode.workspace.registerFileSystemProvider(SCHEME, streams, { isReadonly: true }),
    reg('kaitai.find', async () => {
      const doc = need();
      if (!doc) return;
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
      const hits = findAll(doc.data, needle, 5000);
      if (!hits.length) return void vscode.window.showInformationMessage(`No match for ${needle.label}`);

      const pick = await vscode.window.showQuickPick(
        hits.map((o) => ({
          label: `0x${o.toString(16).toUpperCase()}`,
          description: `${o}`,
          detail: findDeepestNode(doc.roots, o)?.id,
          offset: o,
        })),
        {
          title: `${hits.length}${hits.length >= 5000 ? '+' : ''} matches for ${needle.label}`,
          onDidSelectItem: (i) => {
            const o = (i as unknown as { offset: number }).offset;
            session.select(doc, { start: o, end: o + needle.bytes.length }, 'command', { reveal: true });
          },
        },
      );
      if (pick)
        session.select(doc, { start: pick.offset, end: pick.offset + needle.bytes.length }, 'command', {
          reveal: true,
        });
    }),
    reg('kaitai.addFieldFromSelection', async () => {
      const doc = need();
      if (!doc?.specUri) return void (doc && vscode.window.showWarningMessage('Load a spec first.'));
      const { start, end } = doc.selection;
      if (end <= start)
        return void vscode.window.showWarningMessage('Select the bytes of the new field in the hex editor.');
      // The innermost struct that contains the selection and was read from the file.
      let container = findDeepestNode(doc.roots, start);
      while (container && (container.kind !== 'struct' || !container.range || container.range.end < end))
        container = container.parent;
      if (!container) container = doc.roots[0];
      if (!container?.type) return;
      const seqFields = container.children().filter((c) => !c.instance && c.range);
      const index = seqFields.filter((c) => c.range!.end <= start).length;
      const prevEnd = index > 0 ? seqFields[index - 1].range!.end : container.range!.start;
      const choice = await vscode.window.showQuickPick(typeChoices(end - start, doc.template?.endian), {
        title: `New field in ${container.type}: 0x${start.toString(16)}, ${end - start} bytes`,
      });
      if (!choice) return;
      const id = await vscode.window.showInputBox({
        title: 'Field id',
        value: `field_${start.toString(16)}`,
        validateInput: (v) =>
          /^[a-z][a-z0-9_]*$/.test(v) ? undefined : 'Use lower_snake_case, starting with a letter',
      });
      if (!id) return;
      const fields = [
        ...(start > prevEnd ? [{ id: `unknown_${prevEnd.toString(16)}`, attrs: { size: start - prevEnd } }] : []),
        { id, attrs: choice.attrs },
      ];
      const text = await vscode.workspace.openTextDocument(doc.specUri);
      const edit = insertSeqItems(text.getText(), container.type, index, fields);
      if (typeof edit === 'string') return void vscode.window.showErrorMessage(edit);
      const we = new vscode.WorkspaceEdit();
      we.insert(doc.specUri, text.positionAt(edit.offset), edit.text);
      await vscode.workspace.applyEdit(we);
      const editor = await vscode.window.showTextDocument(text, { preview: false, preserveFocus: true });
      const pos = text.positionAt(edit.offset);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      // The spec change triggers a reparse through Templates.onDidChangeSpec.
    }),
    reg('kaitai.setParams', async () => {
      const doc = need();
      const params = doc?.template?.params;
      if (!doc || !params) return;
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
    reg('kaitai.parseSelectionAs', async () => {
      const doc = need();
      if (!doc) return;
      const names = doc.template?.typeNames ?? [];
      if (!names.length) return void vscode.window.showWarningMessage('The spec has no user types.');
      const { start, end } = doc.selection;
      const range = end > start ? { start, end } : { start, end: doc.data.byteLength };
      const typeName = await vscode.window.showQuickPick(names, {
        placeHolder: `Parse 0x${range.start.toString(16)}–0x${(range.end - 1).toString(16)} (${range.end - range.start} bytes) as…`,
      });
      if (!typeName) return;
      doc.extraParses.push({ typeName, ...range });
      await session.reparse(doc);
    }),
    reg('kaitai.removeParse', async (node: StructureNode) => {
      const doc = session.active;
      if (!doc || !node || node.parent) return;
      const i = doc.roots.indexOf(node) - 1;
      if (i < 0) return;
      doc.extraParses.splice(i, 1);
      await session.reparse(doc);
    }),
    reg('kaitai.openStream', async (node: StructureNode) => {
      const doc = session.active;
      const bytes = node?.streamBytes?.() ?? (node?.raw instanceof Uint8Array ? node.raw : undefined);
      if (!bytes) return;
      const uri = streams.add(`${doc?.fileName ?? 'stream'}.${node.name.replace(/[^\w.-]+/g, '_')}.bin`, bytes.slice());
      await vscode.commands.executeCommand('vscode.openWith', uri, 'kaitai.hexEditor');
    }),
    reg('kaitai.loadTemplate', async (arg?: vscode.Uri) => {
      const doc = need();
      if (!doc) return;
      let uri = arg instanceof vscode.Uri ? arg : undefined;
      if (!uri) {
        // Prefer .ksy files in the workspace; fall back to an open dialog.
        const found = await vscode.workspace.findFiles('**/*.ksy', '**/node_modules/**', 500).then(
          (r) => r,
          () => [] as vscode.Uri[],
        );
        const browse = { label: '$(folder-opened) Browse…', uri: undefined as vscode.Uri | undefined };
        const gallery = { label: '$(library) Format Gallery…', uri: undefined as vscode.Uri | undefined };
        const pick = await vscode.window.showQuickPick(
          [
            ...found.map((u) => ({
              label: u.path.split('/').pop()!,
              description: vscode.workspace.asRelativePath(u),
              uri: u,
            })),
            browse,
            gallery,
          ],
          { placeHolder: `Spec for ${doc.fileName}`, matchOnDescription: true },
        );
        if (!pick) return;
        if (pick === gallery) return vscode.commands.executeCommand('kaitai.formats.focus');
        uri =
          pick.uri ??
          (
            await vscode.window.showOpenDialog({
              canSelectMany: false,
              openLabel: 'Load Spec',
              filters: { 'Kaitai Struct spec': ['ksy'] },
            })
          )?.[0];
      }
      if (!uri) return;
      await session.setSpec(doc, uri);
      if (doc.specError) void vscode.window.showErrorMessage(`Spec error: ${doc.specError}`);
      void vscode.commands.executeCommand('kaitai.structure.focus');
    }),
    reg('kaitai.clearTemplate', async () => {
      const doc = need();
      if (doc) await session.setSpec(doc, undefined);
    }),
    reg('kaitai.reparse', async () => {
      const doc = need();
      if (!doc) return;
      if (doc.specUri) session.templates.invalidate(doc.specUri);
      await session.reparse(doc);
    }),
    reg('kaitai.exportJson', async () => {
      const doc = need();
      const root = doc?.roots[0];
      if (!doc || !root) return void vscode.window.showWarningMessage('Nothing parsed yet.');
      const json = JSON.stringify(toJson(root), null, 2);
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(doc.uri, '..', `${doc.fileName}.json`),
        filters: { JSON: ['json'] },
      });
      if (target) {
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(json));
        void vscode.window.showTextDocument(target);
      } else {
        const d = await vscode.workspace.openTextDocument({ language: 'json', content: json });
        void vscode.window.showTextDocument(d);
      }
    }),
    reg('kaitai.exportNodeJson', async (node: StructureNode) => {
      if (!node) return;
      await vscode.env.clipboard.writeText(JSON.stringify(toJson(node), null, 2));
      vscode.window.setStatusBarMessage(`Copied ${node.name} as JSON`, 3000);
    }),
    reg('kaitai.copyValue', async (node: StructureNode) => {
      if (!node) return;
      const raw = node.raw;
      const text =
        raw instanceof Uint8Array
          ? Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('')
          : raw === undefined
            ? (node.value ?? '')
            : String(raw);
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(`Copied ${node.name}`, 3000);
    }),
    reg('kaitai.copyPath', async (node: StructureNode) => {
      if (!node) return;
      await vscode.env.clipboard.writeText(toExpressionPath(node));
      vscode.window.setStatusBarMessage('Copied path', 3000);
    }),
    reg('kaitai.exportBytes', async (node: StructureNode) => {
      const doc = session.active;
      if (!doc || !node?.range) return;
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(doc.uri, '..', `${doc.fileName}.${node.name.replace(/[^\w.-]+/g, '_')}.bin`),
      });
      if (target) await vscode.workspace.fs.writeFile(target, doc.data.slice(node.range.start, node.range.end));
    }),
    reg('kaitai.goToOffset', async () => {
      const doc = need();
      if (!doc) return;
      const input = await vscode.window.showInputBox({
        prompt: `Offset or range (0x hex, or decimal). File is ${doc.data.byteLength} bytes.`,
        placeHolder: '0x1f4  |  500  |  0x10-0x20  |  0x10+16',
        validateInput: (v) => (parseRange(v, doc.data.byteLength) ? undefined : 'Enter an offset inside the file'),
      });
      const range = input && parseRange(input, doc.data.byteLength);
      if (range) session.select(doc, range, 'command', { reveal: true });
    }),
  );
}

/** `_root.chunks[0].len` style path for a node, usable in expressions. */
export function toExpressionPath(node: StructureNode): string {
  const parts: string[] = [];
  for (let n: StructureNode | undefined = node; n?.parent; n = n.parent) {
    if (n.kind === 'bucket') continue;
    parts.unshift(n.name.startsWith('[') ? n.name : `.${n.name}`);
  }
  return `_root${parts.join('')}`;
}

function formatParam(v: unknown) {
  if (v instanceof Uint8Array) return `[${Array.from(v).join(', ')}]`;
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}
