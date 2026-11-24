// OWNER: inspector/gallery agent. Tree view `kaitai.formats` and the gallery import fallback.
import type * as vscode from 'vscode';
import type { Session } from './session.ts';

export function registerFormatGallery(_context: vscode.ExtensionContext, _session: Session): vscode.Disposable {
  return { dispose() {} };
}
