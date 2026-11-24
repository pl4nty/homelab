// OWNER: inspector/gallery agent. Webview view `kaitai.inspector`.
import type * as vscode from 'vscode';
import type { Session } from './session.ts';

export function registerInspector(_context: vscode.ExtensionContext, _session: Session): vscode.Disposable {
  return { dispose() {} };
}
