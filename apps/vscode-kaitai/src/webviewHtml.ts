// Webview pages with their bundled script and stylesheet inlined. vscode.dev cannot serve webview resources of an
// extension installed from a location (such as http://localhost), so nothing is loaded through asWebviewUri.
import * as vscode from 'vscode';

const decoder = new TextDecoder();

/** Root of the bundled webview assets (`dist/webview`). */
export const webviewRoot = (context: vscode.ExtensionContext) =>
  vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');

/** Full HTML for `<name>.js` + `<name>.css` from `root`, under a nonce-only CSP. */
export async function webviewHtml(root: vscode.Uri, name: string, title: string, body: string): Promise<string> {
  const read = (ext: string) => vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, `${name}.${ext}`));
  const [js, css] = (await Promise.all([read('js'), read('css')])).map((b) =>
    // Keep the bundle from closing its own element; drop source map links, which cannot resolve inline.
    decoder
      .decode(b)
      .replace(/<\/(script|style)/gi, '<\\/$1')
      .replace(/^\/[/*]# sourceMappingURL=.*$/gm, ''),
  );
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${css}</style>
<title>${title}</title>
</head>
<body>
${body}
<script nonce="${nonce}">${js}</script>
</body>
</html>`;
}
