// .ksy language support: diagnostics, completion, hover, definition, outline, quick fixes,
// generated code view and "go to field definition" from the structure tree.
import * as vscode from 'vscode';
import type { StructureNode } from '../engine/structure.ts';
import type { Session } from '../session.ts';
import { KsyDiagnostics } from './diagnostics.ts';
import { registerGeneratedCode } from './generated.ts';
import { registerProviders } from './providers.ts';
import { revealDefinition } from './reveal.ts';

export function registerKsyLanguage(_context: vscode.ExtensionContext, session: Session): vscode.Disposable {
  return vscode.Disposable.from(
    new KsyDiagnostics(session),
    registerProviders(),
    registerGeneratedCode(session),
    vscode.commands.registerCommand('kaitai.revealDefinition', (node?: StructureNode) =>
      revealDefinition(session, node),
    ),
  );
}
