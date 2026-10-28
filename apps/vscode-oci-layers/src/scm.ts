// One SourceControl per opened image: pending edits are the working tree, the image's
// layers are the history, and "commit" pushes a new layer.

import * as vscode from 'vscode';
import type { Change } from './core/overlay.ts';
import type { ImageSession } from './core/session.ts';
import { BASE_SCHEME, displayName, SCHEME, sessionUri } from './session-store.ts';

const LETTER: Record<Change['status'], [string, string]> = {
  added: ['A', 'gitDecoration.addedResourceForeground'],
  modified: ['M', 'gitDecoration.modifiedResourceForeground'],
  deleted: ['D', 'gitDecoration.deletedResourceForeground'],
};

export interface ChangeState extends vscode.SourceControlResourceState {
  readonly sessionId: string;
  readonly change: Change;
}

export function baseUri(id: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BASE_SCHEME, authority: id, path: `/${path}` });
}

export class ImageSourceControl implements vscode.Disposable, vscode.QuickDiffProvider {
  readonly scm: vscode.SourceControl;
  private readonly group: vscode.SourceControlResourceGroup;
  readonly id: string;
  private readonly session: ImageSession;
  /** Current status per path, for the file decoration provider. */
  readonly statusByPath = new Map<string, Change['status']>();

  constructor(id: string, session: ImageSession) {
    this.id = id;
    this.session = session;
    this.scm = vscode.scm.createSourceControl('oci-layers', displayName(session), sessionUri(id));
    this.scm.quickDiffProvider = this;
    this.scm.inputBox.placeholder = 'Layer message (Ctrl+Enter to commit layer and push)';
    this.scm.acceptInputCommand = { command: 'ociLayers.commit', title: 'Commit Layer', arguments: [this.scm] };
    this.group = this.scm.createResourceGroup('changes', 'Changes');
    this.group.hideWhenEmpty = false;
    this.refresh();
  }

  dispose(): void { this.scm.dispose(); }

  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== SCHEME || uri.authority !== this.id) return;
    try {
      const real = this.session.overlay.resolve(uri.path);
      return this.session.overlay.original(real) ? baseUri(this.id, real) : undefined;
    } catch {
      return undefined;
    }
  }

  refresh(): void {
    const changes = this.session.overlay.changes();
    this.statusByPath.clear();
    this.group.resourceStates = changes.map((change): ChangeState => {
      this.statusByPath.set(change.path, change.status);
      const uri = sessionUri(this.id, `/${change.path}`);
      const name = change.path.split('/').pop()!;
      const command: vscode.Command =
        change.status === 'modified' && change.type === 'file'
          ? { command: 'vscode.diff', title: 'Open Changes', arguments: [baseUri(this.id, change.path), uri, `${name} (Image ↔ Edited)`] }
          : change.status === 'deleted'
            ? { command: 'vscode.open', title: 'Open Original', arguments: [baseUri(this.id, change.path)] }
            : { command: 'vscode.open', title: 'Open File', arguments: [uri] };
      return {
        sessionId: this.id,
        change,
        resourceUri: uri,
        command: change.type === 'dir' ? undefined : command,
        contextValue: change.status,
        decorations: {
          strikeThrough: change.status === 'deleted',
          faded: change.type === 'dir',
          tooltip: `${change.status}${change.type === 'file' ? '' : ` ${change.type}`}`,
        },
      };
    });
    this.scm.count = changes.length;
    this.scm.statusBarCommands = [{
      command: 'ociLayers.copyReference',
      title: `$(package) ${displayName(this.session)}`,
      tooltip: `Based on ${this.session.pinned}\nClick to copy`,
      arguments: [this.session.pinned],
    }];
  }
}

/** A/M/D letters in the explorer and editor tabs, like the Git extension. */
export class ChangeDecorations implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly controls: Map<string, ImageSourceControl>;

  constructor(controls: Map<string, ImageSourceControl>) { this.controls = controls; }

  refresh(): void { this._onDidChange.fire(undefined); }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) return;
    const status = this.controls.get(uri.authority)?.statusByPath.get(uri.path.replace(/^\/+/, ''));
    if (!status) return;
    const [letter, color] = LETTER[status];
    return new vscode.FileDecoration(letter, status, new vscode.ThemeColor(color));
  }
}
