// `kaitai.revealDefinition`: from a structure tree node, open the spec that defines the field and
// select its id in `seq` or `instances`.
import * as vscode from 'vscode';
import type { StructureNode } from '../engine/structure.ts';
import type { Session } from '../session.ts';
import { toUpperCamel } from '../util/names.ts';
import { symbolRange } from './language.ts';
import type { TypeInfo } from './model.ts';
import { openSpec, specWithImports } from './resolve.ts';

/** Types with a generated class name (UpperCamel of the type key, or of meta/id for the root). */
function* typesNamed(type: TypeInfo, className: string): Generator<TypeInfo> {
  if (toUpperCamel(type.name) === className) yield type;
  for (const child of type.children.values()) yield* typesNamed(child, className);
}

export async function revealDefinition(session: Session, node?: StructureNode) {
  const kdoc = session.active;
  if (!kdoc?.specUri) {
    void vscode.window.showWarningMessage('No spec is loaded for the active file.');
    return;
  }
  const def = node?.def;
  // Without a def (the root node), show the root type.
  const className = def?.type ?? (kdoc.template && toUpperCamel(kdoc.template.id));
  for await (const spec of specWithImports(kdoc.specUri)) {
    // Nested types of different parents can share a class name: take the one that has the field.
    const types = className ? [...typesNamed(spec.parsed.root, className)] : [spec.parsed.root];
    const ranges = types.map((type) => symbolRange(spec.parsed, { type, field: def?.field }));
    const range = ranges.find(Boolean);
    if (!types.length || (def?.field && !range)) continue;
    const doc = await openSpec(spec);
    // Keep the hex editor visible: open beside it unless the spec is already showing.
    const visible = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    await vscode.window.showTextDocument(doc, {
      selection: range && new vscode.Range(doc.positionAt(range.start), doc.positionAt(range.end)),
      viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
    });
    return;
  }
  void vscode.window.showWarningMessage(
    `Cannot find the definition of ${def ? `${def.type}.${def.field}` : 'the root type'}.`,
  );
}
