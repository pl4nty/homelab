// Custom editor `kaitai.hexEditor`: a read-only, field-coloured hex view of any file.
import * as vscode from 'vscode';
import { findDeepestNode } from './engine/structure.ts';
import type { KaitaiDocument, Session } from './session.ts';
import type { FromHex, ToHex } from './shared/protocol.ts';
import { findStep, keyedRegionsInRange } from './webview/hex/model.ts';

export const VIEW_TYPE = 'kaitai.hexEditor';

class HexDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  readonly kdoc: KaitaiDocument;
  readonly panels = new Set<vscode.WebviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDispose: () => void;

  constructor(uri: vscode.Uri, kdoc: KaitaiDocument, onDispose: () => void) {
    this.uri = uri;
    this.kdoc = kdoc;
    this.onDispose = onDispose;
  }

  watch(onChange: () => void) {
    try {
      const dir = vscode.Uri.joinPath(this.uri, '..');
      const name = this.uri.path.split('/').pop() ?? '';
      const pattern = new vscode.RelativePattern(dir, name);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern, true, false, false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const debounced = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(onChange, 200);
      };
      this.disposables.push(watcher, watcher.onDidChange(debounced), watcher.onDidCreate(debounced), {
        dispose: () => timer && clearTimeout(timer),
      });
    } catch {
      // Some file systems cannot be watched; the view then just does not live-update.
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.onDispose();
  }
}

class HexEditorProvider implements vscode.CustomReadonlyEditorProvider<HexDocument> {
  readonly docs = new Set<HexDocument>();
  private readonly context: vscode.ExtensionContext;
  private readonly session: Session;
  private lastActive?: vscode.WebviewPanel;

  constructor(context: vscode.ExtensionContext, session: Session) {
    this.context = context;
    this.session = session;
  }

  async openCustomDocument(uri: vscode.Uri): Promise<HexDocument> {
    const data = await vscode.workspace.fs.readFile(uri);
    const kdoc = this.session.open(uri, data);
    const doc: HexDocument = new HexDocument(uri, kdoc, () => {
      this.docs.delete(doc);
      // Another custom document for the same URI may still exist (it should not, but be safe).
      if (![...this.docs].some((d) => d.kdoc === kdoc)) this.session.close(kdoc);
    });
    doc.watch(() => void this.reload(doc));
    this.docs.add(doc);
    return doc;
  }

  private async reload(doc: HexDocument) {
    let data: Uint8Array;
    try {
      data = await vscode.workspace.fs.readFile(doc.uri);
    } catch {
      return; // deleted or unreadable; keep showing the last content
    }
    const old = doc.kdoc.data;
    if (old.byteLength === data.byteLength && old.every((b, i) => b === data[i])) return;
    for (const p of doc.panels) post(p, { type: 'data', data });
    await this.session.setData(doc.kdoc, data);
  }

  forDoc(kdoc: KaitaiDocument): vscode.WebviewPanel[] {
    return [...this.docs].filter((d) => d.kdoc === kdoc).flatMap((d) => [...d.panels]);
  }

  resolveCustomEditor(doc: HexDocument, panel: vscode.WebviewPanel): void {
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    panel.webview.html = html(panel.webview, root);
    doc.panels.add(panel);
    const kdoc = doc.kdoc;
    const session = this.session;

    const disposables: vscode.Disposable[] = [
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
            const { regions, keys } = keyedRegionsInRange(kdoc.roots, m.start, m.end, REGION_LIMIT);
            post(panel, {
              type: 'regions',
              requestId: m.requestId,
              version: kdoc.version,
              start: m.start,
              end: m.end,
              regions,
              keys,
              truncated: regions.length >= REGION_LIMIT || undefined,
            });
            break;
          }
          case 'find': {
            const size = kdoc.data.byteLength;
            const found = kdoc.result ? findStep(kdoc.roots, size, m.what, m.direction, m.from) : undefined;
            post(panel, {
              type: 'found',
              requestId: m.requestId,
              range: found && { start: found.start, end: found.end },
              label: found && 'label' in found ? (found as { label: string }).label : undefined,
            });
            break;
          }
          case 'revealInTree': {
            const node = findDeepestNode(kdoc.roots, m.offset);
            const range = node?.range ?? { start: m.offset, end: m.offset + 1 };
            session.select(kdoc, range, 'command', { reveal: true, node });
            break;
          }
          case 'command': {
            session.setActive(kdoc);
            const id = COMMANDS[m.command];
            if (id) void vscode.commands.executeCommand(id);
            break;
          }
        }
      }),
      panel.onDidChangeViewState(() => this.updateActive()),
      panel.onDidDispose(() => {
        for (const d of disposables) d.dispose();
        doc.panels.delete(panel);
        if (this.lastActive === panel) this.lastActive = undefined;
        this.updateActive();
      }),
    ];
    this.updateActive();
  }

  /**
   * The session's active document follows the focused hex panel. When focus moves to another editor
   * (say, the .ksy beside it), a hex panel that is still visible stays the target of tree, inspector
   * and commands; only when none is visible does the active document go away.
   */
  updateActive() {
    const panels = [...this.docs].flatMap((d) => [...d.panels].map((p) => ({ p, d })));
    const active = panels.find((x) => x.p.active);
    if (active) {
      this.lastActive = active.p;
      this.session.setActive(active.d.kdoc);
      return;
    }
    const last = panels.find((x) => x.p === this.lastActive && x.p.visible);
    this.session.setActive(last?.d.kdoc);
  }
}

const REGION_LIMIT = 20000;
const COMMANDS: Record<string, string> = {
  goToOffset: 'kaitai.goToOffset',
  loadSpec: 'kaitai.loadTemplate',
  exportJson: 'kaitai.exportJson',
};

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

function nonce() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function html(webview: vscode.Webview, root: vscode.Uri) {
  const n = nonce();
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'hex.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'hex.css'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'nonce-${n}'`,
    `script-src 'nonce-${n}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" nonce="${n}" href="${style}">
<title>Kaitai Hex Editor</title>
</head>
<body>
<div id="app" tabindex="0" role="grid" aria-label="Hex view"></div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
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
    session.onDidParse((doc) => {
      for (const p of provider.forDoc(doc)) post(p, parsedMessage(doc));
    }),
    session.onDidChangeSelection((e) => {
      if (e.source === 'hex') return;
      const { start, end } = e.range;
      for (const p of provider.forDoc(e.doc)) post(p, { type: 'select', start, end, reveal: e.reveal });
    }),
    session.onDidHighlight((e) => {
      for (const p of provider.forDoc(e.doc)) post(p, { type: 'highlight', start: e.range?.start, end: e.range?.end });
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('kaitai.hexEditor.bytesPerRow')) return;
      const value = bytesPerRow();
      for (const d of provider.docs) for (const p of d.panels) post(p, { type: 'config', bytesPerRow: value });
    }),
  );
}
