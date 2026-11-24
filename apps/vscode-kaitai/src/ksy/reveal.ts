// `kaitai.revealDefinition`: from a structure tree node, open the spec that defines the field and
// select its id in `seq` or `instances`.
import * as vscode from 'vscode';
import { toUpperCamel } from '../engine/kaitai.ts';
import type { StructureNode } from '../engine/structure.ts';
import { importReader } from '../imports.ts';
import type { Session } from '../session.ts';
import { buildTypeTree, type TypeInfo } from './model.ts';
import { fieldRange, type OffsetRange, type ParsedKsy, parseKsyDocument, typeKeyRange } from './yamlAst.ts';

/** Finds a type by its generated class name (UpperCamel of the type key, or of meta/id for the root). */
export function findTypeByClassName(root: TypeInfo, className: string): TypeInfo | undefined {
  if (toUpperCamel(root.name) === className) return root;
  const queue = [...root.children.values()];
  while (queue.length) {
    const t = queue.shift() as TypeInfo;
    if (toUpperCamel(t.name) === className) return t;
    queue.push(...t.children.values());
  }
  return undefined;
}

interface Candidate {
  uri?: vscode.Uri;
  text: string;
}

async function readText(uri: vscode.Uri) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  return open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

/** The root spec followed by every spec it imports (transitively), resolved like the compiler does. */
async function* candidateSpecs(specUri: vscode.Uri): AsyncGenerator<Candidate> {
  const rootText = await readText(specUri);
  yield { uri: specUri, text: rootText };
  const reader = (() => {
    let last: vscode.Uri | undefined;
    const r = importReader(specUri, (u) => {
      last = u;
    });
    return async (name: string, mode: 'rel' | 'abs') => {
      last = undefined;
      const text = await r(name, mode);
      return { text, uri: last as vscode.Uri | undefined };
    };
  })();
  const seen = new Set<string>();
  const queue = [rootText];
  while (queue.length) {
    const text = queue.shift() as string;
    const imports: unknown = parseKsyDocument(text).js?.meta?.imports;
    for (const name of Array.isArray(imports) ? imports.map(String) : []) {
      const mode = name.startsWith('/') ? 'abs' : 'rel';
      const clean = mode === 'abs' ? name.slice(1) : name;
      try {
        const got = await reader(clean, mode);
        const key = got.uri?.toString() ?? `gallery:${clean}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(got.text);
        yield got;
      } catch {
        // Unresolvable imports are reported by diagnostics.
      }
    }
  }
}

export async function revealDefinition(session: Session, node?: StructureNode) {
  const kdoc = session.active;
  const specUri = kdoc?.specUri;
  if (!specUri) {
    void vscode.window.showWarningMessage('No spec is loaded for the active file.');
    return;
  }
  const def = node?.def;
  // Without a def (the root node), show the root type.
  const className = def?.type ?? (kdoc.template ? toUpperCamel(kdoc.template.id) : undefined);
  let found: { cand: Candidate; parsed: ParsedKsy; range?: OffsetRange } | undefined;
  for await (const cand of candidateSpecs(specUri)) {
    const parsed = parseKsyDocument(cand.text);
    const root = buildTypeTree(parsed.js ?? {});
    const t = className ? findTypeByClassName(root, className) : root;
    if (!t) continue;
    const range = def?.field ? fieldRange(parsed, t.path, def.field) : typeKeyRange(parsed, t.path);
    if (def?.field && !range) continue; // same class name elsewhere
    found = { cand, parsed, range };
    break;
  }
  if (!found) {
    void vscode.window.showWarningMessage(
      `Cannot find the definition of ${def ? `${def.type}.${def.field}` : 'the root type'}.`,
    );
    return;
  }
  const doc = found.cand.uri
    ? await vscode.workspace.openTextDocument(found.cand.uri)
    : await vscode.workspace.openTextDocument({ language: 'ksy', content: found.cand.text });
  const r = found.range;
  const selection = r ? new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)) : undefined;
  // Keep the hex editor visible: open beside it unless the spec is already showing.
  const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === doc.uri.toString());
  await vscode.window.showTextDocument(doc, {
    selection,
    preserveFocus: false,
    viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
  });
}
