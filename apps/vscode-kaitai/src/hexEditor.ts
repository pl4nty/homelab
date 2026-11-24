// OWNER: hex editor agent. Custom editor `kaitai.hexEditor` (read-only, CustomReadonlyEditorProvider).
import type * as vscode from 'vscode';
import type { Session } from './session.ts';

export function registerHexEditor(_context: vscode.ExtensionContext, _session: Session): vscode.Disposable {
  return { dispose() {} };
}
