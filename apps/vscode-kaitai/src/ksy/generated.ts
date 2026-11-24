// "Show Generated Code": compiles the spec to a target language and shows each output file as a
// read-only virtual document (scheme `kaitai-gen`) that refreshes when the spec changes.
import * as vscode from 'vscode';
import { generateCode, LANGUAGES, toKsyError } from '../engine/kaitai.ts';
import { importReader, readSpec } from '../imports.ts';
import { formatSpecError, type Session } from '../session.ts';

const GEN_SCHEME = 'kaitai-gen';

/** VS Code language ids of compiler targets, where the two differ. */
const LANGUAGE_IDS: Record<string, string> = { construct: 'python', cpp_stl: 'cpp', graphviz: 'dot' };

interface GenTarget {
  spec: vscode.Uri;
  lang: string;
  debug: boolean;
}

/** `kaitai-gen:/<lang>[-debug]/<file>?<spec uri>` */
function genUri({ spec, lang, debug }: GenTarget, file: string) {
  return vscode.Uri.from({
    scheme: GEN_SCHEME,
    path: `/${lang}${debug ? '-debug' : ''}/${file}`,
    query: spec.toString(),
  });
}

function parseGenUri(uri: vscode.Uri): (GenTarget & { file: string }) | undefined {
  const m = /^\/([^/]+?)(-debug)?\/(.+)$/.exec(uri.path);
  return m ? { lang: m[1], debug: !!m[2], file: m[3], spec: vscode.Uri.parse(uri.query) } : undefined;
}

/** Generated files by relative path. */
async function generate({ spec, lang, debug }: GenTarget): Promise<Record<string, string>> {
  const files = await generateCode(await readSpec(spec), lang, importReader(spec), debug);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k.replace(/^\/+/, ''), v]));
}

const compileError = (e: unknown) => `// Compile error: ${formatSpecError(toKsyError(e))}`;

export function registerGeneratedCode(session: Session): vscode.Disposable {
  const contents = new Map<string, string>();
  const emitter = new vscode.EventEmitter<vscode.Uri>();
  const provider: vscode.TextDocumentContentProvider = {
    onDidChange: emitter.event,
    async provideTextDocumentContent(uri) {
      const cached = contents.get(uri.toString());
      if (cached !== undefined) return cached;
      // Reopened after a reload: regenerate.
      const g = parseGenUri(uri);
      if (!g) return '';
      try {
        return (await generate(g))[g.file] ?? `// ${g.file} is no longer generated`;
      } catch (e) {
        return compileError(e);
      }
    },
  };

  // Any open generated doc may import the changed spec, so all of them are regenerated.
  const refresh = async () => {
    const jobs = new Map<string, Promise<Record<string, string> | string>>();
    for (const { uri } of vscode.workspace.textDocuments) {
      const g = uri.scheme === GEN_SCHEME ? parseGenUri(uri) : undefined;
      if (!g) continue;
      const job = `${g.spec.toString()}\0${g.lang}\0${g.debug}`;
      if (!jobs.has(job)) jobs.set(job, generate(g).catch(compileError));
      const files = await (jobs.get(job) as Promise<Record<string, string> | string>);
      const prev = contents.get(uri.toString());
      // Keep the last good code on errors, with the error on top.
      const next =
        typeof files === 'string'
          ? `${files}\n\n${(prev ?? '').replace(/^\/\/ Compile error: .*\n\n/, '')}`
          : (files[g.file] ?? '');
      if (next !== prev) {
        contents.set(uri.toString(), next);
        emitter.fire(uri);
      }
    }
  };

  const show = async (arg?: vscode.Uri) => {
    const editor = vscode.window.activeTextEditor;
    const spec =
      arg instanceof vscode.Uri
        ? arg
        : editor?.document.languageId === 'ksy'
          ? editor.document.uri
          : session.active?.specUri;
    if (!spec) {
      void vscode.window.showWarningMessage('Open a .ksy file (or load a spec for the active binary file) first.');
      return;
    }
    const picks = LANGUAGES.flatMap((lang) => [
      { label: lang, lang, debug: false },
      { label: `${lang} (debug)`, lang, debug: true, description: 'with position info, as used by this IDE' },
    ]);
    const pick = await vscode.window.showQuickPick(picks, { title: 'Generate code', placeHolder: 'Target language' });
    if (!pick) return;
    const target = { spec, lang: pick.lang, debug: pick.debug };
    let files: Record<string, string>;
    try {
      files = await generate(target);
    } catch (e) {
      void vscode.window.showErrorMessage(`Cannot compile spec: ${formatSpecError(toKsyError(e))}`);
      return;
    }
    const names = Object.keys(files);
    if (!names.length) {
      void vscode.window.showWarningMessage('The compiler produced no files.');
      return;
    }
    for (const name of names) contents.set(genUri(target, name).toString(), files[name]);
    let chosen = names;
    if (names.length > 1) {
      const all = '$(files) Open all';
      const f = await vscode.window.showQuickPick([...names, all], { title: `${pick.label}: ${names.length} files` });
      if (!f) return;
      if (f !== all) chosen = [f];
    }
    const known = new Set(await vscode.languages.getLanguages());
    for (const name of chosen) {
      let doc = await vscode.workspace.openTextDocument(genUri(target, name));
      const wanted = name.endsWith('.h') ? 'cpp' : (LANGUAGE_IDS[pick.lang] ?? pick.lang);
      const lang = known.has(wanted) ? wanted : 'plaintext';
      if (doc.languageId !== lang) doc = await vscode.languages.setTextDocumentLanguage(doc, lang);
      await vscode.window.showTextDocument(doc, { preview: chosen.length === 1, viewColumn: vscode.ViewColumn.Beside });
    }
  };

  return vscode.Disposable.from(
    emitter,
    vscode.workspace.registerTextDocumentContentProvider(GEN_SCHEME, provider),
    vscode.commands.registerCommand('kaitai.showGeneratedCode', show),
    session.templates.onDidChangeSpec(() => void refresh()),
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (d.uri.scheme === GEN_SCHEME) contents.delete(d.uri.toString());
    }),
  );
}
