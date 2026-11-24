// vscode://pl4nty.kaitai-ide/open?data=<path|uri>&ksy=<path|uri>&offset=<n>&length=<n>
// Opens `data` in the Kaitai Hex Editor, applies `ksy`, and selects offset..offset+length.
// Used by the Wireshark dissector's "Open in Kaitai IDE" packet menu, and for shareable links.
import * as vscode from 'vscode';
import type { Session } from './session.ts';
import { parseOpenQuery } from './util/openQuery.ts';

/** A URI with a scheme, or else a file path (`C:\x` is a path, not scheme `c`). */
const toUri = (s: string) => (/^[a-z][\w+.-]+:/i.test(s) ? vscode.Uri.parse(s) : vscode.Uri.file(s));

export function registerUriHandler(session: Session): vscode.Disposable {
  return vscode.window.registerUriHandler({
    async handleUri(uri) {
      if (uri.path !== '/open') return void vscode.window.showErrorMessage(`Unknown Kaitai link: ${uri.path}`);
      const q = parseOpenQuery(uri.query);
      if (typeof q === 'string') return void vscode.window.showErrorMessage(q);
      const data = toUri(q.data);
      await vscode.commands.executeCommand('vscode.openWith', data, 'kaitai.hexEditor');
      // The editor may register the document after the command returns.
      for (let i = 0; !session.get(data) && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
      const doc = session.get(data);
      if (!doc) return;
      if (q.ksy) await session.setSpec(doc, toUri(q.ksy));
      if (q.offset === undefined) return;
      const size = doc.data.byteLength;
      const start = Math.min(q.offset, size);
      session.select(doc, { start, end: Math.min(start + (q.length ?? 0), size) }, 'command', { reveal: true });
    },
  });
}
