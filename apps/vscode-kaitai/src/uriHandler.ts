// vscode://pl4nty.kaitai-ide/open?data=<path|uri>&ksy=<path|uri>&offset=<n>&length=<n>
// Opens `data` in the Kaitai Hex Editor, applies `ksy`, and selects offset..offset+length.
// Used by the Wireshark dissector's "Open in Kaitai IDE" packet menu, and for shareable links.
import * as vscode from 'vscode';
import type { Session } from './session.ts';
import { parseOpenQuery } from './util/openQuery.ts';

export function registerUriHandler(session: Session): vscode.Disposable {
  return vscode.window.registerUriHandler({
    async handleUri(uri) {
      if (uri.path !== '/open') return void vscode.window.showErrorMessage(`Unknown Kaitai link: ${uri.path}`);
      const q = parseOpenQuery(uri.query);
      if (typeof q === 'string') return void vscode.window.showErrorMessage(q);
      const toUri = (s: string) =>
        /^[a-z][\w+.-]+:/i.test(s) && !/^[a-z]:[\\/]/i.test(s) ? vscode.Uri.parse(s) : vscode.Uri.file(s);
      const data = toUri(q.data);
      await vscode.commands.executeCommand('vscode.openWith', data, 'kaitai.hexEditor');
      // The editor registers the document asynchronously.
      let doc = session.get(data);
      for (let i = 0; !doc && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        doc = session.get(data);
      }
      if (!doc) return;
      if (q.ksy) await session.setSpec(doc, toUri(q.ksy));
      if (q.offset !== undefined) {
        const start = Math.min(q.offset, doc.data.byteLength);
        session.select(doc, { start, end: Math.min(start + (q.length ?? 0), doc.data.byteLength) }, 'command', {
          reveal: true,
        });
      }
    },
  });
}
