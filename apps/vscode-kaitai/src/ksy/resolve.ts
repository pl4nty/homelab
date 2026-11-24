// Documents behind the language features: parsed .ksy editors and the specs they import, found in
// the same search order as the compiler uses (../imports.ts).
import * as vscode from 'vscode';
import { importReader, readSpec } from '../imports.ts';
import { importEntries, type ParsedKsy, parseKsyDocument } from './yamlAst.ts';

export interface ResolvedSpec {
  /** File the spec was read from; undefined when it came from the format gallery. */
  uri?: vscode.Uri;
  text: string;
  /** The meta/imports entry that led here, as written. */
  name: string;
  parsed: ParsedKsy;
}

const parseCache = new WeakMap<vscode.TextDocument, { version: number; parsed: ParsedKsy }>();

/** Parsed document, cached per version (providers run several times per keystroke). */
export function parsedOf(doc: vscode.TextDocument): ParsedKsy {
  let hit = parseCache.get(doc);
  if (hit?.version !== doc.version) {
    hit = { version: doc.version, parsed: parseKsyDocument(doc.getText()) };
    parseCache.set(doc, hit);
  }
  return hit.parsed;
}

/** Resolves one meta/imports entry (`name`, or `/name` for an absolute import) of the spec at `specUri`. */
export async function resolveImport(specUri: vscode.Uri, name: string): Promise<ResolvedSpec | undefined> {
  let uri: vscode.Uri | undefined;
  const read = importReader(specUri, (u) => {
    uri = u;
  });
  try {
    const text = await (name.startsWith('/') ? read(name.slice(1), 'abs') : read(name, 'rel'));
    return { uri, text, name, parsed: parseKsyDocument(text) };
  } catch {
    // Unresolvable imports are reported by diagnostics.
    return undefined;
  }
}

let importCache = new WeakMap<vscode.TextDocument, { names: string; specs: Promise<ResolvedSpec[]> }>();

/** Direct imports of a document, cached until its import list changes or `forgetImports` is called. */
export function importedSpecs(doc: vscode.TextDocument): Promise<ResolvedSpec[]> {
  const entries = importEntries(parsedOf(doc));
  const names = entries.map((e) => e.name).join('\0');
  let hit = importCache.get(doc);
  if (hit?.names !== names) {
    const specs = Promise.all(entries.map((e) => resolveImport(doc.uri, e.name))).then((r) => r.filter((s) => !!s));
    hit = { names, specs };
    importCache.set(doc, hit);
  }
  return hit.specs;
}

/** Drops all cached imports, after a spec file changed. */
export function forgetImports() {
  importCache = new WeakMap();
}

/** The spec at `specUri` followed by every spec it imports, directly or not. */
export async function* specWithImports(specUri: vscode.Uri): AsyncGenerator<ResolvedSpec> {
  const text = await readSpec(specUri);
  const queue: ResolvedSpec[] = [{ uri: specUri, text, name: '', parsed: parseKsyDocument(text) }];
  const seen = new Set([specUri.toString()]);
  // The queue grows while it is read, and only as far as the consumer iterates.
  for (const spec of queue) {
    yield spec;
    for (const { name } of importEntries(spec.parsed)) {
      const imported = await resolveImport(spec.uri ?? specUri, name);
      const key = imported?.uri?.toString() ?? `gallery:${name}`;
      if (!imported || seen.has(key)) continue;
      seen.add(key);
      queue.push(imported);
    }
  }
}

/** Opens a resolved spec: its file, or an untitled copy for gallery specs. */
export function openSpec(spec: ResolvedSpec): Thenable<vscode.TextDocument> {
  return spec.uri
    ? vscode.workspace.openTextDocument(spec.uri)
    : vscode.workspace.openTextDocument({ language: 'ksy', content: spec.text });
}
