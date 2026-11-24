// Custom editor `kaitai.hexEditor`: a read-only, field-coloured hex view of any file.
import * as vscode from 'vscode';
import { findDeepestNode, regionsInRange } from './engine/structure.ts';
import type { KaitaiDocument, Session } from './session.ts';
import type { FromHex, ToHex } from './shared/protocol.ts';
import { findStep } from './webview/hex/model.ts';
import { webviewHtml, webviewRoot } from './webviewHtml.ts';

export const VIEW_TYPE = 'kaitai.hexEditor';

interface HexDocument extends vscode.CustomDocument {
  readonly kdoc: KaitaiDocument;
}

/** Calls `onChange` shortly after the file was written or replaced (editors often save by renaming). */
function watchFile(uri: vscode.Uri, onChange: () => void): vscode.Disposable {
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  // The file name is matched as a glob: quote its special characters.
  const pattern = new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), name.replace(/[*?[{]/g, '[$&]'));
  const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 200);
  };
  return vscode.Disposable.from(
    watcher,
    watcher.onDidChange(debounced),
    watcher.onDidCreate(debounced),
    new vscode.Disposable(() => clearTimeout(timer)),
  );
}

class HexEditorProvider implements vscode.CustomReadonlyEditorProvider<HexDocument> {
  /** Every open hex editor and the file it shows. One file can be open in several editors. */
  private readonly panels = new Map<vscode.WebviewPanel, KaitaiDocument>();
  private readonly context: vscode.ExtensionContext;
  private readonly session: Session;
  private lastActive?: vscode.WebviewPanel;

  constructor(context: vscode.ExtensionContext, session: Session) {
    this.context = context;
    this.session = session;
  }

  async openCustomDocument(uri: vscode.Uri): Promise<HexDocument> {
    const kdoc = this.session.open(uri, await vscode.workspace.fs.readFile(uri));
    let watcher: vscode.Disposable | undefined;
    try {
      watcher = watchFile(uri, () => void this.reload(kdoc));
    } catch {
      // A URI without a folder to watch: the view then just does not live-update.
    }
    return {
      uri,
      kdoc,
      dispose: () => {
        watcher?.dispose();
        this.session.close(kdoc);
      },
    };
  }

  private async reload(kdoc: KaitaiDocument) {
    let data: Uint8Array;
    try {
      data = await vscode.workspace.fs.readFile(kdoc.uri);
    } catch {
      return; // deleted or unreadable; keep showing the last content
    }
    if (this.session.get(kdoc.uri) !== kdoc) return; // closed meanwhile
    const old = kdoc.data;
    if (old.byteLength === data.byteLength && old.every((b, i) => b === data[i])) return;
    this.broadcast(kdoc, { type: 'data', data });
    await this.session.setData(kdoc, data);
  }

  /** Sends a message to every editor of a file, or of all files. */
  broadcast(kdoc: KaitaiDocument | undefined, message: ToHex) {
    for (const [panel, d] of this.panels) if (!kdoc || d === kdoc) post(panel, message);
  }

  resolveCustomEditor({ kdoc }: HexDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    void webviewHtml(
      webviewRoot(this.context),
      'hex',
      'Kaitai Hex Editor',
      '<div id="app" tabindex="0" role="grid" aria-label="Hex view"></div>',
    ).then((h) => {
      panel.webview.html = h;
    });
    this.panels.set(panel, kdoc);
    const session = this.session;

    const subscriptions = vscode.Disposable.from(
      panel.webview.onDidReceiveMessage((m: FromHex) => {
        switch (m.type) {
          case 'ready':
            post(panel, {
              type: 'init',
              fileName: kdoc.fileName,
              data: kdoc.data,
              bytesPerRow: bytesPerRow(),
            });
            post(panel, parsedMessage(kdoc));
            break;
          case 'select':
            session.select(kdoc, { start: m.start, end: m.end }, 'hex');
            break;
          case 'requestRegions': {
            const { start, end } = m;
            const regions = regionsInRange(kdoc.roots, start, end);
            post(panel, { type: 'regions', version: kdoc.version, start, end, regions });
            break;
          }
          case 'find':
            post(panel, {
              type: 'found',
              range: kdoc.result && findStep(kdoc.roots, kdoc.data.byteLength, m.what, m.direction, m.from),
            });
            break;
          case 'revealInTree': {
            const node = findDeepestNode(kdoc.roots, m.offset);
            const range = node?.range ?? { start: m.offset, end: m.offset + 1 };
            session.select(kdoc, range, 'command', { reveal: true, node });
            break;
          }
          case 'command':
            session.setActive(kdoc);
            void vscode.commands.executeCommand(COMMANDS[m.command]);
            break;
        }
      }),
      panel.onDidChangeViewState(() => this.updateActive()),
    );
    panel.onDidDispose(() => {
      subscriptions.dispose();
      this.panels.delete(panel);
      if (this.lastActive === panel) this.lastActive = undefined;
      this.updateActive();
    });
    this.updateActive();
  }

  /**
   * The session's active document follows the focused hex panel. When focus moves to another editor
   * (say, the .ksy beside it), a hex panel that is still visible stays the target of tree, inspector
   * and commands; only when none is visible does the active document go away.
   */
  private updateActive() {
    this.lastActive = [...this.panels.keys()].find((p) => p.active) ?? this.lastActive;
    this.session.setActive(this.lastActive?.visible ? this.panels.get(this.lastActive) : undefined);
  }
}

const COMMANDS = { goToOffset: 'kaitai.goToOffset', loadSpec: 'kaitai.loadTemplate' };

function bytesPerRow(): number {
  const v = vscode.workspace.getConfiguration('kaitai').get<number>('hexEditor.bytesPerRow', 16);
  return [8, 16, 32].includes(v) ? v : 16;
}

function parsedMessage(doc: KaitaiDocument): ToHex {
  return { type: 'parsed', version: doc.version, hasSpec: !!doc.specUri, error: doc.specError ?? doc.result?.error };
}

function post(panel: vscode.WebviewPanel, message: ToHex) {
  void panel.webview.postMessage(message).then(undefined, () => {});
}

async function openInHexEditor(arg?: unknown) {
  let uri = arg instanceof vscode.Uri ? arg : undefined;
  uri ??= vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: unknown } | undefined;
    if (input?.uri instanceof vscode.Uri) uri = input.uri;
  }
  if (!uri) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open in Kaitai Hex Editor' });
    uri = picked?.[0];
  }
  if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

export function registerHexEditor(context: vscode.ExtensionContext, session: Session): vscode.Disposable {
  const provider = new HexEditorProvider(context, session);
  return vscode.Disposable.from(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand('kaitai.openInHexEditor', openInHexEditor),
    session.onDidParse((doc) => provider.broadcast(doc, parsedMessage(doc))),
    session.onDidChangeSelection(({ doc, source, range, reveal }) => {
      if (source !== 'hex') provider.broadcast(doc, { type: 'select', ...range, reveal });
    }),
    session.onDidHighlight(({ doc, range }) => provider.broadcast(doc, { type: 'highlight', ...range })),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kaitai.hexEditor.bytesPerRow')) {
        provider.broadcast(undefined, { type: 'config', bytesPerRow: bytesPerRow() });
      }
    }),
  );
}
