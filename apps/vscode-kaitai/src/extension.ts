import type * as vscode from 'vscode';
import { registerCommands } from './commands.ts';
import { registerFormatGallery } from './formats.ts';
import { registerHexEditor } from './hexEditor.ts';
import { registerInspector } from './inspector.ts';
import { registerKsyLanguage } from './ksy/index.ts';
import { Session } from './session.ts';
import { StructureView } from './structureView.ts';
import { Templates } from './templates.ts';
import { registerUriHandler } from './uriHandler.ts';

export function activate(context: vscode.ExtensionContext) {
  const templates = new Templates();
  const session = new Session(templates, context.workspaceState);
  context.subscriptions.push(
    templates,
    session,
    registerHexEditor(context, session),
    new StructureView(session),
    registerInspector(context, session),
    registerFormatGallery(context, session),
    registerKsyLanguage(context, session),
    registerCommands(context, session),
    registerUriHandler(session),
  );
}

export function deactivate() {}
