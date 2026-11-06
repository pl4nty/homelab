import * as vscode from 'vscode';
import { formatRef, parseRef } from './core/reference.ts';
import { RegistryError } from './core/registry.ts';
import { BaseFileSystemProvider, ImageFileSystemProvider } from './fs-provider.ts';
import { LayersView } from './layers-view.ts';
import { ChangeDecorations, type ChangeState, ImageSourceControl } from './scm.ts';
import { registerSearchCommands, registerSearchProviders } from './search-providers.ts';
import { BASE_SCHEME, displayName, SCHEME, SessionStore, sessionUri } from './session-store.ts';

export function activate(ctx: vscode.ExtensionContext): void {
  const store = new SessionStore(ctx);
  const fs = new ImageFileSystemProvider(store);
  const baseFs = new BaseFileSystemProvider(store);
  const controls = new Map<string, ImageSourceControl>();
  const decorations = new ChangeDecorations(controls);
  const layers = new LayersView(store);

  ctx.subscriptions.push(
    store,
    vscode.workspace.registerFileSystemProvider(SCHEME, fs, { isCaseSensitive: true }),
    vscode.workspace.registerFileSystemProvider(BASE_SCHEME, baseFs, { isCaseSensitive: true, isReadonly: true }),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.window.createTreeView('ociLayers.layers', { treeDataProvider: layers }),
    store.onDidLoad(({ id, session }) => {
      controls.get(id)?.dispose();
      controls.set(id, new ImageSourceControl(id, session));
      layers.refresh();
      decorations.refresh();
    }),
    store.onDidChange((id) => {
      controls.get(id)?.refresh();
      layers.refresh();
      decorations.refresh();
    }),
    {
      dispose: () =>
        controls.forEach((c) => {
          c.dispose();
        }),
    },
  );

  // Reload sessions whose workspace folders survived a window reload / extension host restart.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === SCHEME) store.load(folder.uri.authority).catch((e) => showError(e));
  }
  // Hosts that do not persist untitled workspaces (e.g. a reloaded browser tab) drop our folders,
  // stranding uncommitted edits. Offer to reopen them. Clean sessions are left alone: globalState
  // is shared by all windows, so they may belong to another window.
  const openIds = new Set(
    (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === SCHEME).map((f) => f.uri.authority),
  );
  const orphans = store.ids().filter((id) => !openIds.has(id) && store.hasPending(id));
  if (orphans.length) {
    const names = orphans.map((id) => store.info(id)!.display).join(', ');
    void vscode.window
      .showInformationMessage(`OCI Layers: uncommitted changes to ${names}.`, 'Reopen', 'Discard')
      .then(async (choice) => {
        if (choice === 'Reopen') {
          const start = vscode.workspace.workspaceFolders?.length ?? 0;
          vscode.workspace.updateWorkspaceFolders(
            start,
            0,
            ...orphans.map((id) => ({ uri: sessionUri(id), name: store.info(id)!.display })),
          );
        } else if (choice === 'Discard') {
          for (const id of orphans) await store.remove(id);
        }
      });
  }

  // Forget sessions whose folder was removed by the user.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed) if (f.uri.scheme === SCHEME) void closeSession(f.uri.authority, false);
    }),
  );

  async function closeSession(id: string, removeFolder: boolean): Promise<void> {
    controls.get(id)?.dispose();
    controls.delete(id);
    await store.remove(id);
    layers.refresh();
    if (removeFolder) {
      const idx =
        vscode.workspace.workspaceFolders?.findIndex((f) => f.uri.scheme === SCHEME && f.uri.authority === id) ?? -1;
      if (idx >= 0) vscode.workspace.updateWorkspaceFolders(idx, 1);
    }
  }

  /** Session targeted by a command: SCM arg, resource arg, active editor, or the only one open. */
  async function pickSession(arg?: unknown): Promise<string | undefined> {
    if (arg && typeof arg === 'object') {
      if ('rootUri' in arg && (arg as vscode.SourceControl).rootUri?.scheme === SCHEME)
        return (arg as vscode.SourceControl).rootUri!.authority;
      if ('sessionId' in arg) return (arg as ChangeState).sessionId;
      if (arg instanceof vscode.Uri && arg.scheme === SCHEME) return arg.authority;
      if ('id' in arg && typeof (arg as { id: unknown }).id === 'string' && store.get((arg as { id: string }).id))
        return (arg as { id: string }).id;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === SCHEME) return active.authority;
    const all = store.all();
    if (all.length <= 1) return all[0]?.[0];
    const pick = await vscode.window.showQuickPick(
      all.map(([id, s]) => ({ label: displayName(s), id })),
      { placeHolder: 'Select image' },
    );
    return pick?.id;
  }

  function showError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    const actions =
      e instanceof RegistryError && (e.status === 401 || e.status === 403)
        ? ['Sign In']
        : e instanceof RegistryError && e.network
          ? ['Configure Proxy']
          : [];
    void vscode.window.showErrorMessage(`OCI Layers: ${msg}`, ...actions).then((a) => {
      if (a === 'Sign In') void vscode.commands.executeCommand('ociLayers.signIn');
      if (a === 'Configure Proxy')
        void vscode.commands.executeCommand('workbench.action.openSettings', 'ociLayers.corsProxy');
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: command arguments are untyped
  const command = (name: string, fn: (...args: any[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(name, async (...args) => {
        try {
          return await fn(...args);
        } catch (e) {
          showError(e);
        }
      }),
    );

  command('ociLayers.openImage', async (reference?: string) => {
    reference ??= await vscode.window.showInputBox({
      prompt: 'Image reference',
      placeHolder: 'e.g. alpine:3.20, ghcr.io/owner/image:tag, localhost:5000/app@sha256:…',
      validateInput: (v) => {
        try {
          parseRef(v);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    });
    if (!reference) return;
    const ref = parseRef(reference);
    const id = await store.create(formatRef({ ...ref, digest: ref.tag ? undefined : ref.digest }));
    try {
      await store.load(id);
    } catch (e) {
      await store.remove(id);
      throw e;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    // Note: adding the first folder restarts the extension host; the session reloads from globalState.
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
      uri: sessionUri(id),
      name: displayName(store.get(id)!),
    });
    await vscode.commands.executeCommand('workbench.view.scm');
  });

  command('ociLayers.closeImage', async (arg?: unknown) => {
    const id = await pickSession(arg);
    if (!id) return;
    if (store.get(id)?.overlay.isDirty()) {
      const ok = await vscode.window.showWarningMessage(
        'Discard uncommitted changes and close the image?',
        { modal: true },
        'Close',
      );
      if (ok !== 'Close') return;
    }
    await closeSession(id, true);
  });

  command('ociLayers.commit', async (arg?: unknown) => {
    const id = await pickSession(arg);
    const session = id && store.get(id);
    const control = id && controls.get(id);
    if (!id || !session || !control) return;
    if (!session.overlay.isDirty()) return vscode.window.showInformationMessage('No changes to commit.');
    let message = control.scm.inputBox.value.trim();
    if (!message) {
      const m = await vscode.window.showInputBox({ prompt: 'Layer message (stored as the history comment)' });
      if (m === undefined) return;
      message = m;
    }
    const current = formatRef({ ...session.ref, digest: undefined });
    const targetStr = await vscode.window.showInputBox({
      prompt: session.resolved.indexDigest
        ? 'Push to (this was a multi-platform image: pushing to the same tag replaces it with a single-platform manifest)'
        : 'Push to',
      value: current,
      validateInput: (v) => {
        try {
          parseRef(v);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    });
    if (!targetStr) return;
    const target = parseRef(targetStr);
    if (target.digest) throw new Error('push target must be a tag, not a digest');
    const changed = session.overlay.changes();
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: 'Committing layer' },
      () =>
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Commit layer' }, (p) =>
          session.commit(target, message, (m) => p.report({ message: m })),
        ),
    );
    // The SourceControl label is fixed at creation; recreate it in case the target repository changed.
    control.dispose();
    controls.set(id, new ImageSourceControl(id, session));
    await store.committed(id, formatRef({ ...target, digest: undefined }));
    fs.fire(changed.map((c) => ({ type: vscode.FileChangeType.Changed, uri: sessionUri(id, `/${c.path}`) })));
    baseFs.fire(
      changed.map((c) => ({
        type: vscode.FileChangeType.Changed,
        uri: vscode.Uri.from({ scheme: BASE_SCHEME, authority: id, path: `/${c.path}` }),
      })),
    );
    const pinned = formatRef(res.ref);
    const action = await vscode.window.showInformationMessage(
      `Pushed ${formatRef({ ...target, digest: undefined })} (${res.digest.slice(0, 19)})`,
      'Copy Reference',
    );
    if (action) await vscode.env.clipboard.writeText(pinned);
  });

  const discard = async (states: ChangeState[]) => {
    if (!states.length) return;
    const ok = await vscode.window.showWarningMessage(
      states.length === 1 ? `Discard changes to /${states[0].change.path}?` : `Discard ${states.length} changes?`,
      { modal: true },
      'Discard',
    );
    if (ok !== 'Discard') return;
    const ids = new Set<string>();
    for (const s of states) {
      store.get(s.sessionId)?.overlay.discard(s.change.path);
      ids.add(s.sessionId);
    }
    fs.fire(states.map((s) => ({ type: vscode.FileChangeType.Changed, uri: s.resourceUri })));
    for (const id of ids) store.changed(id);
  };

  command('ociLayers.discard', (...args: unknown[]) =>
    discard(args.flat().filter((a): a is ChangeState => !!a && typeof a === 'object' && 'change' in a)),
  );

  command('ociLayers.discardAll', async (arg?: unknown) => {
    const id = await pickSession(arg);
    const session = id && store.get(id);
    if (!id || !session) return;
    await discard(
      session.overlay
        .changes()
        .map((change) => ({ sessionId: id, change, resourceUri: sessionUri(id, `/${change.path}`) })),
    );
  });

  command('ociLayers.openChange', (state?: ChangeState) => {
    const cmd = state?.command;
    if (cmd) return vscode.commands.executeCommand(cmd.command, ...(cmd.arguments ?? []));
  });

  command('ociLayers.copyReference', async (ref?: string) => {
    if (ref) await vscode.env.clipboard.writeText(ref);
  });

  command('ociLayers.refreshLayers', () => layers.refresh());

  registerSearchProviders(ctx, store);
  registerSearchCommands(command, store, pickSession);

  command('ociLayers.signIn', async (registry?: string) => {
    if (typeof registry !== 'string') {
      const id = await pickSession();
      registry = await vscode.window.showInputBox({
        prompt: 'Registry',
        value: id ? store.get(id)?.ref.registry : 'docker.io',
      });
    }
    if (!registry) return;
    const username = await vscode.window.showInputBox({ prompt: `Username for ${registry}` });
    if (username === undefined) return;
    const password = await vscode.window.showInputBox({
      prompt: `Password or access token for ${registry}`,
      password: true,
    });
    if (password === undefined) return;
    await store.setCredentials(registry, { username, password });
    void vscode.window.showInformationMessage(`Saved credentials for ${registry}.`);
  });

  command('ociLayers.signOut', async () => {
    const registry = await vscode.window.showInputBox({ prompt: 'Registry to forget credentials for' });
    if (registry) await store.setCredentials(registry, undefined);
  });
}

export function deactivate(): void {}
