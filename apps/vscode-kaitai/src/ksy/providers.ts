// Completion, hover, go-to-definition and outline for .ksy documents.
import * as vscode from 'vscode';
import { computeCompletions, type ItemKind } from './completion.ts';
import { type DefinitionTarget, definitionTarget, hoverInfo } from './language.ts';
import { importedSpecs, openSpec, type ResolvedSpec, resolveImport } from './resolve.ts';
import {
  documentSymbols,
  enumRange,
  fieldRange,
  type KsySymbol,
  type OffsetRange,
  parseKsyDocument,
  type SymbolKind,
  typeKeyRange,
} from './yamlAst.ts';

const SELECTOR: vscode.DocumentSelector = { language: 'ksy' };

const ITEM_KIND: Record<ItemKind, vscode.CompletionItemKind> = {
  property: vscode.CompletionItemKind.Property,
  value: vscode.CompletionItemKind.Value,
  type: vscode.CompletionItemKind.Class,
  enum: vscode.CompletionItemKind.Enum,
  enumMember: vscode.CompletionItemKind.EnumMember,
  field: vscode.CompletionItemKind.Field,
  keyword: vscode.CompletionItemKind.Keyword,
  module: vscode.CompletionItemKind.Module,
};

const SYMBOL_KIND: Record<SymbolKind, vscode.SymbolKind> = {
  module: vscode.SymbolKind.Module,
  field: vscode.SymbolKind.Field,
  property: vscode.SymbolKind.Property,
  class: vscode.SymbolKind.Class,
  enum: vscode.SymbolKind.Enum,
  enumMember: vscode.SymbolKind.EnumMember,
  variable: vscode.SymbolKind.Variable,
  namespace: vscode.SymbolKind.Namespace,
};

const toRange = (doc: vscode.TextDocument, r: OffsetRange) =>
  new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end));

/** Parsed document, cached per version (providers run several times per keystroke). */
const parseCache = new WeakMap<vscode.TextDocument, { version: number; parsed: ReturnType<typeof parseKsyDocument> }>();
function parsedOf(doc: vscode.TextDocument) {
  const hit = parseCache.get(doc);
  if (hit && hit.version === doc.version) return hit.parsed;
  const parsed = parseKsyDocument(doc.getText());
  parseCache.set(doc, { version: doc.version, parsed });
  return parsed;
}

async function importedRoots(doc: vscode.TextDocument) {
  return importedSpecs(doc, parsedOf(doc));
}

function rangeInSpec(spec: ResolvedSpec, t: Extract<DefinitionTarget, { kind: 'imported' }>): OffsetRange | undefined {
  if (t.field) return fieldRange(spec.parsed, t.typePath, t.field);
  if (t.enumName) return enumRange(spec.parsed, t.typePath, t.enumName, t.label);
  return typeKeyRange(spec.parsed, t.typePath);
}

export function registerProviders(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      {
        async provideCompletionItems(doc, pos) {
          const offset = doc.offsetAt(pos);
          const imported = (await importedRoots(doc)).map((s) => s.root);
          const { items, from } = computeCompletions(doc.getText(), offset, { imported });
          const range = new vscode.Range(doc.positionAt(from), pos);
          return items.map((it) => {
            const item = new vscode.CompletionItem(it.label, ITEM_KIND[it.kind]);
            item.detail = it.detail;
            if (it.doc) item.documentation = new vscode.MarkdownString(it.doc);
            if (it.insertText) item.insertText = it.snippet ? new vscode.SnippetString(it.insertText) : it.insertText;
            item.sortText = it.sortText;
            item.range = range;
            // Keep the suggest widget open after a key so the value list shows.
            if (it.retrigger || it.insertText?.endsWith('::'))
              item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
            return item;
          });
        },
      },
      ':',
      '.',
      ' ',
    ),
    vscode.languages.registerHoverProvider(SELECTOR, {
      async provideHover(doc, pos) {
        const imported = (await importedRoots(doc)).map((s) => s.root);
        const h = hoverInfo(parsedOf(doc), doc.getText(), doc.offsetAt(pos), imported);
        return h && new vscode.Hover(new vscode.MarkdownString(h.markdown), h.range && toRange(doc, h.range));
      },
    }),
    vscode.languages.registerDefinitionProvider(SELECTOR, {
      async provideDefinition(doc, pos) {
        const specs = await importedRoots(doc);
        const t = definitionTarget(
          parsedOf(doc),
          doc.getText(),
          doc.offsetAt(pos),
          specs.map((s) => s.root),
        );
        if (!t) return undefined;
        if (t.kind === 'local') return new vscode.Location(doc.uri, toRange(doc, t.range));
        if (t.kind === 'import') {
          const spec = await resolveImport(doc.uri, t.name, t.mode);
          if (!spec) return undefined;
          const target = await openSpec(spec);
          return new vscode.Location(target.uri, new vscode.Position(0, 0));
        }
        const spec = specs.find((s) => s.root.specId === t.specId);
        if (!spec) return undefined;
        const target = await openSpec(spec);
        const r = rangeInSpec(spec, t);
        return new vscode.Location(target.uri, r ? toRange(target, r) : new vscode.Position(0, 0));
      },
    }),
    vscode.languages.registerDocumentSymbolProvider(
      SELECTOR,
      {
        provideDocumentSymbols(doc) {
          const convert = (s: KsySymbol): vscode.DocumentSymbol => {
            const sym = new vscode.DocumentSymbol(
              s.name,
              s.detail ?? '',
              SYMBOL_KIND[s.kind],
              toRange(doc, s.range),
              toRange(doc, s.selectionRange),
            );
            sym.children = s.children.map(convert);
            return sym;
          };
          return documentSymbols(parsedOf(doc), doc.getText()).map(convert);
        },
      },
      { label: 'Kaitai Struct' },
    ),
  );
}
