// Tracks opened images across extension-host restarts. Adding the first workspace
// folder restarts the extension host, so everything needed to reload a session
// (its reference and pending edits) lives in globalState.

import * as vscode from 'vscode';
import { formatRef, parseRef } from './core/reference.ts';
import type { Credentials } from './core/registry.ts';
import { RegistryClient } from './core/registry.ts';
import { ImageSession } from './core/session.ts';

export const SCHEME = 'oci-layer';
export const BASE_SCHEME = 'oci-layer-base';

interface StoredSession {
  /** Reference the user opened or last pushed to, e.g. docker.io/library/alpine:3.20. */
  display: string;
  /** Digest-pinned reference the overlay is based on. */
  pinned?: string;
}

const SESSIONS_KEY = 'ociLayers.sessions';
const upperKey = (id: string) => `ociLayers.upper.${id}`;
const credKey = (registry: string) => `ociLayers.credentials.${registry}`;

function config() {
  return vscode.workspace.getConfiguration('ociLayers');
}

export class SessionStore implements vscode.Disposable {
  private readonly loading = new Map<string, Promise<ImageSession>>();
  private readonly loaded = new Map<string, ImageSession>();
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _onDidLoad = new vscode.EventEmitter<{ id: string; session: ImageSession }>();
  readonly onDidLoad = this._onDidLoad.event;
  private readonly _onDidChange = new vscode.EventEmitter<string>();
  /** Fires with a session id when its pending changes or base image change. */
  readonly onDidChange = this._onDidChange.event;

  readonly client: RegistryClient;
  private readonly ctx: vscode.ExtensionContext;

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
    const insecure = (host: string) => (config().get<string[]>('insecureRegistries') ?? []).includes(host);
    this.client = new RegistryClient({
      // Getter so configuration changes apply without recreating the client.
      get corsProxy() {
        return config().get<string>('corsProxy') || undefined;
      },
      insecure,
      getCredentials: (registry) => this.getCredentials(registry),
    });
  }

  dispose(): void {
    for (const id of this.persistTimers.keys()) this.flush(id);
    this._onDidLoad.dispose();
    this._onDidChange.dispose();
  }

  // ---- credentials --------------------------------------------------------

  async getCredentials(registry: string): Promise<Credentials | undefined> {
    const raw = await this.ctx.secrets.get(credKey(registry));
    return raw ? (JSON.parse(raw) as Credentials) : undefined;
  }

  async setCredentials(registry: string, creds: Credentials | undefined): Promise<void> {
    if (creds) await this.ctx.secrets.store(credKey(registry), JSON.stringify(creds));
    else await this.ctx.secrets.delete(credKey(registry));
  }

  // ---- sessions -----------------------------------------------------------

  private stored(): Record<string, StoredSession> {
    return this.ctx.globalState.get<Record<string, StoredSession>>(SESSIONS_KEY) ?? {};
  }

  private async setStored(id: string, s: StoredSession | undefined): Promise<void> {
    const all = this.stored();
    if (s) all[id] = s;
    else delete all[id];
    await this.ctx.globalState.update(SESSIONS_KEY, all);
  }

  info(id: string): StoredSession | undefined {
    return this.stored()[id];
  }

  ids(): string[] {
    return Object.keys(this.stored());
  }

  /** Whether a (possibly not loaded) session has persisted uncommitted edits. */
  hasPending(id: string): boolean {
    const upper = this.ctx.globalState.get<unknown[]>(upperKey(id));
    return Array.isArray(upper) && upper.length > 0;
  }

  get(id: string): ImageSession | undefined {
    return this.loaded.get(id);
  }

  all(): [string, ImageSession][] {
    return [...this.loaded];
  }

  async create(reference: string): Promise<string> {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
    await this.setStored(id, { display: reference });
    return id;
  }

  async remove(id: string): Promise<void> {
    clearTimeout(this.persistTimers.get(id));
    this.persistTimers.delete(id);
    this.loaded.delete(id);
    this.loading.delete(id);
    await this.setStored(id, undefined);
    await this.ctx.globalState.update(upperKey(id), undefined);
  }

  /** Load (once) the session behind a URI authority, pulling layers with a progress notification. */
  load(id: string): Promise<ImageSession> {
    let p = this.loading.get(id);
    if (p) return p;
    const s = this.info(id);
    if (!s) return Promise.reject(vscode.FileSystemError.FileNotFound(`unknown image session ${id}`));
    p = Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Opening ${s.display}`, cancellable: false },
        async (progress) => {
          const session = await ImageSession.open(this.client, s.pinned ?? s.display, {
            platform: config().get<string>('platform') ?? 'linux/amd64',
            maxBytes: (config().get<number>('maxImageSizeMB') ?? 512) * 2 ** 20,
            progress: (message) => progress.report({ message }),
          });
          // Opened by digest after a reload: keep the tag the user works against.
          if (s.pinned) session.ref = { ...parseRef(s.display), digest: undefined };
          session.overlay.restore(this.ctx.globalState.get(upperKey(id)));
          await this.setStored(id, { display: s.display, pinned: session.pinned });
          this.loaded.set(id, session);
          this._onDidLoad.fire({ id, session });
          return session;
        },
      ),
    );
    p.catch(() => this.loading.delete(id));
    this.loading.set(id, p);
    return p;
  }

  /** Record pending edits (debounced) and notify listeners. */
  changed(id: string): void {
    clearTimeout(this.persistTimers.get(id));
    this.persistTimers.set(
      id,
      setTimeout(() => this.flush(id), 300),
    );
    this._onDidChange.fire(id);
  }

  private flush(id: string): void {
    this.persistTimers.delete(id);
    const session = this.loaded.get(id);
    if (session) void this.ctx.globalState.update(upperKey(id), session.overlay.serialize());
  }

  async committed(id: string, display: string): Promise<void> {
    const session = this.loaded.get(id)!;
    await this.setStored(id, { display, pinned: session.pinned });
    this.flush(id);
    this._onDidChange.fire(id);
  }
}

export function sessionUri(id: string, path = '/'): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: id, path });
}

export function displayName(session: ImageSession): string {
  return formatRef(session.ref).replace(/^docker\.io\/(library\/)?/, '');
}
