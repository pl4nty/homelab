// Resolves .ksy imports through workspace.fs (works on virtual file systems and the web), with the
// format gallery as a fallback for absolute imports such as `/common/vlq_base128_le`.
import * as vscode from 'vscode';
import type { ImportReader } from './engine/kaitai.ts';

/** Fetches a file from the configured format gallery. Set by the gallery module at activation. */
export let galleryFetch: (path: string) => Promise<string | undefined> = async () => undefined;
export function setGalleryFetch(f: typeof galleryFetch) {
  galleryFetch = f;
}

const decoder = new TextDecoder();

async function tryRead(uri: vscode.Uri): Promise<string | undefined> {
  // An open (possibly unsaved) editor wins over the file on disk.
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return decoder.decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/**
 * Import reader for a spec at `specUri`. Relative imports resolve from the spec's folder.
 * Absolute imports are tried in each ancestor folder (so a checkout of the format gallery works),
 * then in the gallery. `onResolve` reports each file used, so callers can watch them.
 */
export function importReader(specUri: vscode.Uri | undefined, onResolve?: (uri: vscode.Uri) => void): ImportReader {
  // Nested relative imports resolve from the importing file; the compiler only gives us names, so
  // keep the folders seen so far and try them in order.
  const dirs: vscode.Uri[] = specUri ? [vscode.Uri.joinPath(specUri, '..')] : [];
  return async (name, mode) => {
    const file = `${name}.ksy`;
    const candidates: vscode.Uri[] = [];
    if (mode === 'rel') {
      for (const d of dirs) candidates.push(vscode.Uri.joinPath(d, file));
    } else if (specUri) {
      let dir = vscode.Uri.joinPath(specUri, '..');
      for (let i = 0; i < 32; i++) {
        candidates.push(vscode.Uri.joinPath(dir, file));
        const parent = vscode.Uri.joinPath(dir, '..');
        if (parent.path === dir.path) break;
        dir = parent;
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) candidates.push(vscode.Uri.joinPath(folder.uri, file));
    for (const uri of candidates) {
      const text = await tryRead(uri);
      if (text !== undefined) {
        onResolve?.(uri);
        const d = vscode.Uri.joinPath(uri, '..');
        if (!dirs.some((x) => x.toString() === d.toString())) dirs.push(d);
        return text;
      }
    }
    const fromGallery = await galleryFetch(mode === 'abs' ? file : file.replace(/^\.\//, ''));
    if (fromGallery !== undefined) return fromGallery;
    throw new Error(`Cannot find imported spec "${name}" (${mode === 'abs' ? 'absolute' : 'relative'} import)`);
  };
}
