// Finds imported specs for language features: resolves meta/imports entries to files (same search
// order as ../imports.ts) and builds their type trees.
import * as vscode from 'vscode';
import { importReader } from '../imports.ts';
import { buildTypeTree, type TypeInfo } from './model.ts';
import { importEntries, type ParsedKsy, parseKsyDocument } from './yamlAst.ts';

export interface ResolvedSpec {
  /** File the spec was read from; undefined when it came from the format gallery. */
  uri?: vscode.Uri;
  text: string;
  /** The import name as written, without a leading slash. */
  name: string;
  parsed: ParsedKsy;
  root: TypeInfo;
}

/** Resolves one import of the spec at `specUri`. */
export async function resolveImport(
  specUri: vscode.Uri,
  name: string,
  mode: 'rel' | 'abs',
): Promise<ResolvedSpec | undefined> {
  let uri: vscode.Uri | undefined;
  try {
    const text = await importReader(specUri, (u) => {
      uri = u;
    })(name, mode);
    const parsed = parseKsyDocument(text);
    return { uri, text, name, parsed, root: buildTypeTree(parsed.js ?? {}) };
  } catch {
    return undefined;
  }
}

const cache = new Map<string, { key: string; specs: Promise<ResolvedSpec[]> }>();

/** Direct imports of a document (cached per document version). */
export function importedSpecs(doc: { uri: vscode.Uri; version: number }, parsed: ParsedKsy): Promise<ResolvedSpec[]> {
  const entries = importEntries(parsed);
  const key = `${doc.version}\0${entries.map((e) => e.name).join('\0')}`;
  const hit = cache.get(doc.uri.toString());
  if (hit && hit.key === key) return hit.specs;
  const specs = Promise.all(
    entries.map((e) =>
      e.name.startsWith('/') ? resolveImport(doc.uri, e.name.slice(1), 'abs') : resolveImport(doc.uri, e.name, 'rel'),
    ),
  ).then((r) => r.filter((x): x is ResolvedSpec => !!x));
  cache.set(doc.uri.toString(), { key, specs });
  return specs;
}

/** Drops cached imports (of one document, or all after an imported file changed). */
export function forgetImports(uri?: vscode.Uri) {
  if (uri) cache.delete(uri.toString());
  else cache.clear();
}

/** Opens a resolved spec: its file, or a read-only-ish untitled copy for gallery specs. */
export async function openSpec(spec: ResolvedSpec): Promise<vscode.TextDocument> {
  if (spec.uri) return vscode.workspace.openTextDocument(spec.uri);
  return vscode.workspace.openTextDocument({ language: 'ksy', content: spec.text });
}
