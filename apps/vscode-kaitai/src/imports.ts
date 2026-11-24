// Reads .ksy specs and resolves their imports through workspace.fs (works on virtual file systems
// and the web), with the format gallery as a fallback for imports such as `/common/vlq_base128_le`.
import * as vscode from 'vscode';
import type { ImportReader } from './engine/kaitai.ts';

let galleryFetch: (path: string) => Promise<string | undefined> = async () => undefined;

/** Sets how a file is fetched from the configured format gallery. Called by the gallery module. */
export function setGalleryFetch(f: typeof galleryFetch) {
  galleryFetch = f;
}

/** Text of the spec at `uri`. An open (possibly unsaved) editor wins over the file on disk. */
export async function readSpec(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  return open?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

const parentOf = (uri: vscode.Uri) => vscode.Uri.joinPath(uri, '..');

/**
 * Import reader for a spec at `specUri`. Relative imports resolve from the spec's folder.
 * Absolute imports are tried in each ancestor folder (so a checkout of the format gallery works).
 * Both then fall back to the workspace folders and the gallery. `onResolve` reports each file
 * used, so callers can watch them.
 */
export function importReader(specUri: vscode.Uri | undefined, onResolve?: (uri: vscode.Uri) => void): ImportReader {
  // Nested relative imports resolve from the importing file; the compiler only gives us names, so
  // keep the folders seen so far and try them in order.
  const dirs = specUri ? [parentOf(specUri)] : [];
  return async (name, mode) => {
    const file = `${name}.ksy`;
    const folders: vscode.Uri[] = [];
    if (mode === 'rel') folders.push(...dirs);
    else for (let dir = dirs[0]; dir && dir.path !== folders.at(-1)?.path; dir = parentOf(dir)) folders.push(dir);
    folders.push(...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri));
    for (const folder of folders) {
      const uri = vscode.Uri.joinPath(folder, file);
      const text = await readSpec(uri).catch(() => undefined);
      if (text === undefined) continue;
      onResolve?.(uri);
      const dir = parentOf(uri);
      if (!dirs.some((d) => d.toString() === dir.toString())) dirs.push(dir);
      return text;
    }
    const fromGallery = await galleryFetch(file.replace(/^\.\//, ''));
    if (fromGallery !== undefined) return fromGallery;
    throw new Error(`Cannot find imported spec "${name}" (${mode === 'abs' ? 'absolute' : 'relative'} import)`);
  };
}
