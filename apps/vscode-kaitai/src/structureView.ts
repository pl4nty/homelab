// Tree view of the active file's parse result, kept in sync with the hex editor selection.
import * as vscode from 'vscode';
import type { ByteRange, NodeKind, StructureNode } from './engine/structure.ts';
import type { KaitaiDocument, SelectionEvent, Session } from './session.ts';

const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;

const ICONS: Partial<Record<NodeKind, string>> = {
  struct: 'symbol-structure',
  array: 'symbol-array',
  bucket: 'symbol-array',
  bytes: 'file-binary',
  string: 'symbol-string',
  enum: 'symbol-enum-member',
  boolean: 'symbol-boolean',
  number: 'symbol-number',
};

export class StructureView implements vscode.TreeDataProvider<StructureNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly treeView = vscode.window.createTreeView('kaitai.structure', {
    treeDataProvider: this,
    showCollapseAll: true,
  });
  private readonly disposables: vscode.Disposable[];
  private readonly session: Session;
  private doc?: KaitaiDocument;
  /**
   * The node that the tree selection and the hex selection last agreed on. The two views echo
   * each other's selection changes; an echo of this node is not passed on again. A copy, so that
   * it does not keep a replaced parse result alive.
   */
  private synced?: { id: string; range?: ByteRange };

  constructor(session: Session) {
    this.session = session;
    this.disposables = [
      this.treeView,
      this.changeEmitter,
      // Clicking a node, also when it is selected already.
      vscode.commands.registerCommand('kaitai.selectNode', (node: StructureNode) => this.choose(node)),
      // Keyboard navigation in the tree moves the hex selection too.
      this.treeView.onDidChangeSelection(({ selection: [node] }) => {
        if (node && node.id !== this.synced?.id) this.choose(node);
      }),
      session.onDidChangeActive((doc) => this.show(doc)),
      session.onDidParse((doc) => doc === this.doc && this.show(doc)),
      session.onDidChangeSelection((e) => this.follow(e)),
    ];
    this.show(session.active);
  }

  private show(doc: KaitaiDocument | undefined) {
    if (doc !== this.doc) this.synced = undefined;
    this.doc = doc;
    const t = doc?.template;
    this.treeView.description = doc && (t ? `${t.title} · ${doc.fileName}` : doc.fileName);
    this.treeView.message = !doc
      ? undefined
      : doc.specError
        ? `Spec error: ${doc.specError}`
        : doc.result?.error
          ? `Parse error: ${doc.result.error}${t?.params.length && !doc.params ? ' (this spec takes params: use Set Spec Params…)' : ''}`
          : !doc.specUri
            ? 'No spec loaded. Use Load Spec… or pick one from the Format Gallery.'
            : undefined;
    this.changeEmitter.fire();
  }

  getTreeItem(node: StructureNode): vscode.TreeItem {
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
      : new vscode.ThemeIcon(ICONS[node.kind] ?? (node.instance ? 'symbol-property' : 'symbol-field'));
    item.contextValue = [
      node.hasChildren ? 'branch' : 'leaf',
      node.range && 'ranged',
      node.def && 'def',
      (node.streamBytes || node.kind === 'bytes') && 'stream',
      !node.parent && this.doc && this.doc.roots.indexOf(node) > 0 && 'extraRoot',
    ]
      .filter(Boolean)
      .join(' ');
    if (node.range) item.command = { command: 'kaitai.selectNode', title: 'Select in Hex Editor', arguments: [node] };
    return item;
  }

  resolveTreeItem(item: vscode.TreeItem, node: StructureNode): vscode.TreeItem {
    const tip = new vscode.MarkdownString(`**${node.name}**`);
    if (node.type) tip.appendMarkdown(` : \`${node.type}\``);
    if (node.instance) tip.appendMarkdown(' _(instance)_');
    if (node.value !== undefined) tip.appendText(`\n\n${node.value}`);
    if (node.range) {
      const { start, end } = node.range;
      tip.appendText(`\n\nOffset ${hex(start)}–${hex(Math.max(start, end - 1))} (${end - start} bytes)`);
    } else if (node.hasChildren || node.value !== undefined) {
      tip.appendText('\n\nNot in the file (computed, or inside a processed stream).');
    }
    if (node.error) tip.appendText(`\n\n${node.error}`);
    item.tooltip = tip;
    return item;
  }

  getChildren(node?: StructureNode): StructureNode[] {
    return node ? node.children() : (this.doc?.roots ?? []);
  }

  getParent(node: StructureNode): StructureNode | undefined {
    return node.parent;
  }

  /** Tree to hex: selects the node's bytes. */
  private choose(node: StructureNode) {
    if (!this.doc || !node.range) return;
    this.synced = { id: node.id, range: node.range };
    this.session.select(this.doc, node.range, 'tree', { reveal: true, node });
  }

  /** Hex to tree: reveals the deepest field at the caret. */
  private follow({ doc, source, range, node }: SelectionEvent) {
    if (doc !== this.doc || source === 'tree' || !node || !this.treeView.visible) return;
    // The hex view reporting the range of the node chosen in the tree: the deepest node there
    // may be a child of that node, which should stay selected.
    const r = this.synced?.range;
    if (r && r.start === range.start && r.end === range.end) return;
    this.synced = { id: node.id, range: node.range };
    this.treeView.reveal(node, { select: true, focus: false, expand: false }).then(undefined, () => undefined);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
