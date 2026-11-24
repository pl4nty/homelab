// "Show Generated Code": compiles the spec to a target language and shows each output file as a
// read-only virtual document (scheme `kaitai-gen`) that refreshes when the spec changes.
import * as vscode from 'vscode';
import { generateCode, LANGUAGES, toKsyError } from '../engine/kaitai.ts';
import { importReader } from '../imports.ts';
import { formatSpecError, type Session } from '../session.ts';

export const GEN_SCHEME = 'kaitai-gen';

const LANGUAGE_IDS: Record<string, string> = {
  construct: 'python',
  cpp_stl: 'cpp',
  csharp: 'csharp',
  go: 'go',
  graphviz: 'dot',
  html: 'html',
  java: 'java',
  javascript: 'javascript',
  lua: 'lua',
  nim: 'nim',
  perl: 'perl',
  php: 'php',
  python: 'python',
  ruby: 'ruby',
  rust: 'rust',
};

/** `kaitai-gen:/<lang>[-debug]/<file>?<spec uri>` */
function genUri(spec: vscode.Uri, lang: string, debug: boolean, file: string) {
  return vscode.Uri.from({
    scheme: GEN_SCHEME,
    path: `/${lang}${debug ? '-debug' : ''}/${file.replace(/^\/+/, '')}`,
    query: spec.toString(),
  });
}

function parseGenUri(uri: vscode.Uri) {
  const m = /^\/([^/]+?)(-debug)?\/(.+)$/.exec(uri.path);
  if (!m) return undefined;
  return { lang: m[1], debug: !!m[2], file: m[3], spec: vscode.Uri.parse(uri.query) };
}

async function specText(uri: vscode.Uri) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  return open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function generate(spec: vscode.Uri, lang: string, debug: boolean): Promise<Record<string, string>> {
  const files = await generateCode(await specText(spec), lang, importReader(spec), debug);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k.replace(/^\/+/, ''), v]));
}

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
        const files = await generate(g.spec, g.lang, g.debug);
        return files[g.file] ?? `// ${g.file} is no longer generated`;
      } catch (e) {
        return `// Compile error: ${formatSpecError(toKsyError(e))}`;
      }
    },
  };

  // Any open generated doc may import the changed spec, so all of them are regenerated.
  const refresh = async () => {
    const groups = new Map<string, vscode.Uri[]>();
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.scheme !== GEN_SCHEME) continue;
      const g = parseGenUri(d.uri);
      if (!g) continue;
      const key = `${g.spec.toString()}\0${g.lang}\0${g.debug}`;
      groups.set(key, [...(groups.get(key) ?? []), d.uri]);
    }
    for (const [key, uris] of groups) {
      const [specStr, lang, debug] = key.split('\0');
      let files: Record<string, string> | undefined;
      let error: string | undefined;
      try {
        files = await generate(vscode.Uri.parse(specStr), lang, debug === 'true');
      } catch (e) {
        error = formatSpecError(toKsyError(e));
      }
      for (const uri of uris) {
        const g = parseGenUri(uri);
        if (!g) continue;
        const prev = contents.get(uri.toString());
        // Keep the last good code on errors, with the error on top.
        const next = files
          ? (files[g.file] ?? '')
          : `// Compile error: ${error}\n\n${(prev ?? '').replace(/^\/\/ Compile error: .*\n\n/, '')}`;
        if (next !== prev) {
          contents.set(uri.toString(), next);
          emitter.fire(uri);
        }
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
    let files: Record<string, string>;
    try {
      files = await generate(spec, pick.lang, pick.debug);
    } catch (e) {
      void vscode.window.showErrorMessage(`Cannot compile spec: ${formatSpecError(toKsyError(e))}`);
      return;
    }
    const names = Object.keys(files);
    if (!names.length) {
      void vscode.window.showWarningMessage('The compiler produced no files.');
      return;
    }
    for (const name of names) contents.set(genUri(spec, pick.lang, pick.debug, name).toString(), files[name]);
    let chosen = names;
    if (names.length > 1) {
      const all = '$(files) Open all';
      const f = await vscode.window.showQuickPick([...names, all], { title: `${pick.label}: ${names.length} files` });
      if (!f) return;
      chosen = f === all ? names : [f];
    }
    const known = new Set(await vscode.languages.getLanguages());
    for (const name of chosen) {
      let doc = await vscode.workspace.openTextDocument(genUri(spec, pick.lang, pick.debug, name));
      const lang = /\.h$/.test(name) ? 'cpp' : (LANGUAGE_IDS[pick.lang] ?? 'plaintext');
      if (doc.languageId !== lang) {
        doc = await vscode.languages.setTextDocumentLanguage(doc, known.has(lang) ? lang : 'plaintext');
      }
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
