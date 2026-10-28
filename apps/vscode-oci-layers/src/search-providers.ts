// Search over opened images.
// - Quick Open and the Search view use the proposed fileSearchProvider2 / textSearchProvider2 APIs.
//   VS Code only grants proposed APIs in extension development mode or with
//   --enable-proposed-api, so registration is best-effort.
// - "Find File in Image" and "Find Text in Image" commands use stable API and work everywhere.

import * as vscode from 'vscode';
import { findFiles, searchText, type TextMatch } from './core/search.ts';
import { SCHEME, type SessionStore, sessionUri } from './session-store.ts';

const globOf = (g: vscode.GlobPattern) => (typeof g === 'string' ? g : g.pattern);
const range = (s: TextMatch['start'], e: TextMatch['end']) =>
  new vscode.Range(s.line, s.character, e.line, e.character);

/** Returns true if the proposed providers were registered. */
export function registerSearchProviders(ctx: vscode.ExtensionContext, store: SessionStore): boolean {
  try {
    ctx.subscriptions.push(
      vscode.workspace.registerFileSearchProvider2(SCHEME, {
        async provideFileSearchResults(pattern, options, token) {
          const out: vscode.Uri[] = [];
          for (const folder of options.folderOptions) {
            const session = await store.load(folder.folder.authority);
            const paths = findFiles(session.overlay, pattern, {
              includes: folder.includes,
              excludes: folder.excludes.map(globOf),
              maxResults: options.maxResults ? options.maxResults - out.length : undefined,
              isCancelled: () => token.isCancellationRequested,
            });
            out.push(...paths.map((p) => sessionUri(folder.folder.authority, `/${p}`)));
          }
          return out;
        },
      }),
      vscode.workspace.registerTextSearchProvider2(SCHEME, {
        async provideTextSearchResults(query, options, progress, token) {
          let limitHit = false;
          let found = 0;
          for (const folder of options.folderOptions) {
            const id = folder.folder.authority;
            const session = await store.load(id);
            const res = searchText(session.overlay, query, {
              includes: folder.includes,
              excludes: folder.excludes.map(globOf),
              maxResults: options.maxResults ? options.maxResults - found : undefined,
              maxFileSize: options.maxFileSize,
              isCancelled: () => token.isCancellationRequested,
              onMatch: (m) =>
                progress.report(
                  new vscode.TextSearchMatch2(
                    sessionUri(id, `/${m.path}`),
                    [{ sourceRange: range(m.start, m.end), previewRange: range(m.previewStart, m.previewEnd) }],
                    m.preview,
                  ),
                ),
            });
            found += res.matches;
            limitHit ||= res.limitHit;
          }
          return { limitHit };
        },
      }),
    );
    return true;
  } catch (e) {
    // "Extension ... CANNOT use API proposal": fall back to the commands below.
    console.info(
      `oci-layers: proposed search APIs unavailable (${(e as Error).message}); use the Find in Image commands`,
    );
    return false;
  }
}

const MAX_TEXT_RESULTS = 2000;

export function registerSearchCommands(
  // biome-ignore lint/suspicious/noExplicitAny: command arguments are untyped
  register: (name: string, fn: (...args: any[]) => unknown) => void,
  store: SessionStore,
  pickSession: (arg?: unknown) => Promise<string | undefined>,
): void {
  register('ociLayers.findFile', async (arg?: unknown) => {
    const id = await pickSession(arg);
    const session = id && store.get(id);
    if (!id || !session) return;
    const items = findFiles(session.overlay, '').map((p) => {
      const slash = p.lastIndexOf('/');
      return { label: p.slice(slash + 1), description: `/${p.slice(0, slash)}`, path: p };
    });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `Find file in ${store.info(id)?.display}`,
      matchOnDescription: true,
    });
    if (pick) await vscode.window.showTextDocument(sessionUri(id, `/${pick.path}`));
  });

  register('ociLayers.findText', async (arg?: unknown) => {
    const id = await pickSession(arg);
    const session = id && store.get(id);
    if (!id || !session) return;
    const pattern = await vscode.window.showInputBox({
      prompt: `Find text in ${store.info(id)?.display} (prefix with "re:" for a regular expression)`,
      value: vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection) || undefined,
    });
    if (!pattern) return;
    const isRegExp = pattern.startsWith('re:');
    const items: (vscode.QuickPickItem & { m: TextMatch })[] = [];
    const { limitHit } = searchText(
      session.overlay,
      { pattern: isRegExp ? pattern.slice(3) : pattern, isRegExp },
      {
        maxResults: MAX_TEXT_RESULTS,
        onMatch: (m) =>
          items.push({ label: m.preview.split('\n')[0].trim(), description: `/${m.path}:${m.start.line + 1}`, m }),
      },
    );
    if (!items.length) return vscode.window.showInformationMessage(`No results for "${pattern}".`);
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `${items.length}${limitHit ? '+' : ''} results for "${pattern}"`,
      matchOnDescription: true,
    });
    if (pick)
      await vscode.window.showTextDocument(sessionUri(id, `/${pick.m.path}`), {
        selection: range(pick.m.start, pick.m.end),
      });
  });
}
