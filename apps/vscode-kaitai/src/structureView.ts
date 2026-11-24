// Tree view of the active file's parse result, kept in sync with the hex editor selection.
import * as vscode from 'vscode';
import { findDeepestNode, type StructureNode } from './engine/structure.ts';
import type { KaitaiDocument, Session } from './session.ts';

const hex = (n: number) => n.toString(16).toUpperCase();

/** Message node shown at the root when there is a spec error or parse error. */
type Item = StructureNode;

export class StructureView implements vscode.TreeDataProvider<Item>, vscode.Disposable {
  static readonly viewId = 'kaitai.structure';
  private readonly changeEmitter = new vscode.EventEmitter<Item | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly treeView: vscode.TreeView<Item>;
  private readonly disposables: vscode.Disposable[] = [];
  private doc?: KaitaiDocument;
  private readonly session: Session;
  /** Node most recently chosen in the tree, to avoid echoing its selection back. */
  private chosen?: StructureNode;

  constructor(session: Session) {
    this.session = session;
    this.treeView = vscode.window.createTreeView(StructureView.viewId, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(
      this.treeView,
      this.changeEmitter,
      vscode.commands.registerCommand('kaitai.selectNode', (node: StructureNode) => this.choose(node)),
      this.treeView.onDidChangeSelection((e) => {
        // Keyboard navigation in the tree moves the hex selection too.
        const node = e.selection[0];
        if (node && node !== this.chosen && node.range) this.choose(node);
      }),
      session.onDidChangeActive((doc) => this.show(doc)),
      session.onDidParse((doc) => doc === this.doc && this.show(doc)),
      session.onDidChangeSelection((e) => {
        if (e.doc !== this.doc || e.source === 'tree') return;
        this.reveal(e.range.start, e.range.end - e.range.start);
      }),
    );
    this.show(session.active);
  }

  private show(doc: KaitaiDocument | undefined) {
    this.doc = doc;
    this.chosen = undefined;
    const t = doc?.template;
    this.treeView.title = 'Structure';
    this.treeView.description = doc ? (t ? `${t.title} · ${doc.fileName}` : doc.fileName) : undefined;
    this.treeView.message = !doc
      ? undefined
      : doc.specError
        ? `Spec error: ${doc.specError}`
        : doc.result?.error
          ? `Parse error: ${doc.result.error}${t?.params.length && !doc.params ? ' (this spec takes params: use Set Spec Params…)' : ''}`
          : !doc.specUri
            ? 'No spec loaded. Use Load Spec… or pick one from the Format Gallery.'
            : undefined;
    void vscode.commands.executeCommand('setContext', 'kaitai.hasSpec', !!doc?.specUri);
    void vscode.commands.executeCommand('setContext', 'kaitai.hasParams', !!t?.params.length);
    this.changeEmitter.fire();
  }

  getTreeItem(node: Item): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      !node.hasChildren
        ? vscode.TreeItemCollapsibleState.None
        : node.parent
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = node.id; // stable ids keep expansion state across reparses
    item.description = node.error ?? node.value ?? node.type;
    item.iconPath = node.error
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
      : new vscode.ThemeIcon(iconFor(node));
    item.contextValue = [
      node.hasChildren ? 'branch' : 'leaf',
      node.range ? 'ranged' : '',
      node.def ? 'def' : '',
      node.streamBytes || node.kind === 'bytes' ? 'stream' : '',
      !node.parent && this.doc && this.doc.roots.indexOf(node) > 0 ? 'extraRoot' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${node.name}**`);
    if (node.type) tip.appendMarkdown(` : \`${node.type}\``);
    if (node.instance) tip.appendMarkdown(' _(instance)_');
    if (node.value !== undefined) tip.appendText(`\n\n${node.value}`);
    if (node.range) {
      const { start, end } = node.range;
      tip.appendText(`\n\nOffset 0x${hex(start)}–0x${hex(Math.max(start, end - 1))} (${end - start} bytes)`);
      item.command = { command: 'kaitai.selectNode', title: 'Select in Hex Editor', arguments: [node] };
    } else if (node.hasChildren || node.value !== undefined) {
      tip.appendText('\n\nNot in the file (computed, or inside a processed stream).');
    }
    if (node.error) tip.appendText(`\n\n${node.error}`);
    item.tooltip = tip;
    return item;
  }

  getChildren(node?: Item): Item[] {
    return node ? node.children() : (this.doc?.roots ?? []);
  }

  getParent(node: Item): Item | undefined {
    return node.parent;
  }

  private choose(node: StructureNode) {
    if (!this.doc || !node.range) return;
    this.chosen = node;
    this.session.select(this.doc, node.range, 'tree', { reveal: true, node });
  }

  /** Reveals the deepest field at an offset, unless it is inside the node just chosen in the tree. */
  private reveal(offset: number, length: number) {
    if (!this.doc || !this.treeView.visible) return;
    const r = this.chosen?.range;
    if (r && length === r.end - r.start && offset === r.start) return;
    const node = findDeepestNode(this.doc.roots, offset);
    if (!node) return;
    this.chosen = node;
    this.treeView.reveal(node, { select: true, focus: false, expand: false }).then(undefined, () => undefined);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

function iconFor(node: StructureNode) {
  switch (node.kind) {
    case 'struct':
      return 'symbol-structure';
    case 'array':
    case 'bucket':
      return 'symbol-array';
    case 'bytes':
      return 'file-binary';
    case 'string':
      return 'symbol-string';
    case 'enum':
      return 'symbol-enum-member';
    case 'boolean':
      return 'symbol-boolean';
    case 'number':
      return 'symbol-number';
    default:
      return node.instance ? 'symbol-property' : 'symbol-field';
  }
}
