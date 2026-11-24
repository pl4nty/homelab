// Completion, hover, go-to-definition and outline for .ksy documents.
import * as vscode from 'vscode';
import { computeCompletions } from './completion.ts';
import { definitionTarget, hoverInfo, symbolRange } from './language.ts';
import { rootOf } from './model.ts';
import { importedSpecs, openSpec, parsedOf } from './resolve.ts';
import { documentSymbols, type KsySymbol, type OffsetRange } from './yamlAst.ts';

const SELECTOR: vscode.DocumentSelector = { language: 'ksy' };
const START = new vscode.Position(0, 0);

const toRange = (doc: vscode.TextDocument, r: OffsetRange) =>
  new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end));

const importedRoots = async (doc: vscode.TextDocument) => (await importedSpecs(doc)).map((s) => s.parsed.root);

const completion: vscode.CompletionItemProvider = {
  async provideCompletionItems(doc, pos) {
    const { items, from } = computeCompletions(doc.getText(), doc.offsetAt(pos), await importedRoots(doc));
    const range = new vscode.Range(doc.positionAt(from), pos);
    return items.map((it) => {
      const item = new vscode.CompletionItem(it.label, vscode.CompletionItemKind[it.kind]);
      item.detail = it.detail;
      if (it.doc) item.documentation = new vscode.MarkdownString(it.doc);
      if (it.insertText) item.insertText = it.snippet ? new vscode.SnippetString(it.insertText) : it.insertText;
      item.sortText = it.sortText;
      item.range = range;
      // Keep the suggest widget open after a key or `enum::` so the next list shows.
      if (it.retrigger || it.insertText?.endsWith('::'))
        item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
      return item;
    });
  },
};

const hover: vscode.HoverProvider = {
  async provideHover(doc, pos) {
    const h = hoverInfo(parsedOf(doc), doc.getText(), doc.offsetAt(pos), await importedRoots(doc));
    return h && new vscode.Hover(new vscode.MarkdownString(h.markdown), h.range && toRange(doc, h.range));
  },
};

const definition: vscode.DefinitionProvider = {
  async provideDefinition(doc, pos) {
    const specs = await importedSpecs(doc);
    const roots = specs.map((s) => s.parsed.root);
    const t = definitionTarget(parsedOf(doc), doc.getText(), doc.offsetAt(pos), roots);
    if (!t) return undefined;
    if (t.kind === 'local') return new vscode.Location(doc.uri, toRange(doc, t.range));
    const spec = t.kind === 'import' ? specs.find((s) => s.name === t.name) : specs[roots.indexOf(rootOf(t.type))];
    if (!spec) return undefined;
    const target = await openSpec(spec);
    const range = t.kind === 'imported' ? symbolRange(spec.parsed, t) : undefined;
    return new vscode.Location(target.uri, range ? toRange(target, range) : START);
  },
};

const symbols: vscode.DocumentSymbolProvider = {
  provideDocumentSymbols(doc) {
    const convert = (s: KsySymbol): vscode.DocumentSymbol => {
      const sym = new vscode.DocumentSymbol(
        s.name,
        s.detail ?? '',
        vscode.SymbolKind[s.kind],
        toRange(doc, s.range),
        toRange(doc, s.selectionRange),
      );
      sym.children = s.children.map(convert);
      return sym;
    };
    return documentSymbols(parsedOf(doc)).map(convert);
  },
};

export function registerProviders(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.languages.registerCompletionItemProvider(SELECTOR, completion, ':', '.', ' '),
    vscode.languages.registerHoverProvider(SELECTOR, hover),
    vscode.languages.registerDefinitionProvider(SELECTOR, definition),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, symbols, { label: 'Kaitai Struct' }),
  );
}
