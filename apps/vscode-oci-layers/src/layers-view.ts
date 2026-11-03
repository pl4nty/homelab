import * as vscode from 'vscode';
import type { LayerInfo } from './core/session.ts';
import { displayName, type SessionStore } from './session-store.ts';

type Node =
  | { kind: 'image'; id: string }
  | { kind: 'layer'; id: string; index: number; layer: LayerInfo }
  | { kind: 'pending'; id: string; count: number };

const size = (n: number) => (n < 2 ** 20 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 2 ** 20).toFixed(1)} MiB`);

export class LayersView implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.store.all().map(([id]) => ({ kind: 'image', id }));
    if (node.kind !== 'image') return [];
    const session = this.store.get(node.id)!;
    const count = session.overlay.changes().length;
    const layers = session.layers.map((layer, index): Node => ({ kind: 'layer', id: node.id, index, layer })).reverse();
    return count ? [{ kind: 'pending', id: node.id, count }, ...layers] : layers;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'image') {
      const s = this.store.get(node.id)!;
      const item = new vscode.TreeItem(displayName(s), vscode.TreeItemCollapsibleState.Expanded);
      item.description = s.resolved.manifestDigest.slice(0, 19);
      item.tooltip = `${s.pinned}\n${s.resolved.config.os}/${s.resolved.config.architecture}`;
      item.iconPath = new vscode.ThemeIcon('package');
      return item;
    }
    if (node.kind === 'pending') {
      const item = new vscode.TreeItem(`Uncommitted (${node.count} change${node.count === 1 ? '' : 's'})`);
      item.iconPath = new vscode.ThemeIcon('edit');
      item.command = { command: 'workbench.view.scm', title: 'Show Changes' };
      return item;
    }
    const { layer, index } = node;
    const createdBy = (layer.createdBy ?? '').replace(/^\/bin\/sh -c (#\(nop\) )?/, '').trim();
    // Our commits store the message as the comment; other tools use it for noise like "buildkit.dockerfile.v0".
    const ours = layer.createdBy?.startsWith('vscode oci-layers');
    const label = (ours && layer.comment) || createdBy || layer.comment || layer.descriptor.digest.slice(7, 19);
    const item = new vscode.TreeItem(`${index + 1}  ${label}`);
    item.description = size(layer.descriptor.size);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${layer.descriptor.digest}**`,
        layer.descriptor.mediaType,
        layer.created,
        layer.createdBy && `\`\`\`\n${layer.createdBy}\n\`\`\``,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    item.iconPath = new vscode.ThemeIcon('layers');
    return item;
  }
}
