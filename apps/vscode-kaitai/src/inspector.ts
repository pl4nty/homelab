// Value inspector: webview view `kaitai.inspector` that decodes the bytes at the caret of the active document.
import * as vscode from 'vscode';
import type { KaitaiDocument, Session } from './session.ts';
import type { FromInspector, ToInspector } from './shared/protocol.ts';

const BYTES = 16;

class InspectorProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly context: vscode.ExtensionContext;
  private readonly session: Session;

  constructor(context: vscode.ExtensionContext, session: Session) {
    this.context = context;
    this.session = session;
    this.disposables.push(
      session.onDidChangeSelection((e) => {
        if (e.doc === session.active) this.update();
      }),
      session.onDidChangeActive(() => this.update()),
      // The spec (and so its endian) may change.
      session.onDidParse((doc) => {
        if (doc === session.active) this.update();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const { webview } = view;
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(root, 'inspector.css'))}">
<title>Value Inspector</title>
</head>
<body>
<div id="root"></div>
<script src="${webview.asWebviewUri(vscode.Uri.joinPath(root, 'inspector.js'))}"></script>
</body>
</html>`;
    // These listeners go away with the view. The webview posts `ready` each time its page (re)loads.
    webview.onDidReceiveMessage((msg: FromInspector) => {
      if (msg.type === 'ready') this.update();
      else if (msg.type === 'copy') {
        void vscode.env.clipboard.writeText(msg.text);
        vscode.window.setStatusBarMessage(`Copied ${msg.label}: ${msg.text}`, 3000);
      }
    });
    view.onDidChangeVisibility(() => this.update());
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  private update() {
    if (this.view?.visible) void this.view.webview.postMessage(this.message(this.session.active));
  }

  private message(doc: KaitaiDocument | undefined): ToInspector {
    if (!doc) return { type: 'empty' };
    const { start, end } = doc.selection;
    const offset = Math.min(Math.max(0, start), doc.data.byteLength);
    // Copy, so the (transferable) message never aliases the document's buffer.
    const bytes = doc.data.slice(offset, offset + BYTES);
    const e = doc.template?.endian?.toLowerCase();
    return {
      type: 'bytes',
      offset,
      bytes,
      selectionLength: Math.max(0, end - start),
      endian: e === 'le' || e === 'be' ? e : undefined,
    };
  }

  dispose() {
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

export function registerInspector(context: vscode.ExtensionContext, session: Session): vscode.Disposable {
  const provider = new InspectorProvider(context, session);
  return vscode.Disposable.from(provider, vscode.window.registerWebviewViewProvider('kaitai.inspector', provider));
}
