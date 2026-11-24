// Commands that act on the active document: load/clear spec, export, go to offset.
import type * as vscode from 'vscode';
import type { Session } from './session.ts';

export function registerCommands(_context: vscode.ExtensionContext, _session: Session): vscode.Disposable {
  return { dispose() {} };
}
