// OCI Distribution API client on top of fetch(), so it runs in the web extension host.
// Spec: https://github.com/opencontainers/distribution-spec/blob/main/spec.md

import { sha256 } from './bytes.ts';
import type { ImageRef } from './reference.ts';
import { refReference } from './reference.ts';

export const MT = {
  ociIndex: 'application/vnd.oci.image.index.v1+json',
  ociManifest: 'application/vnd.oci.image.manifest.v1+json',
  ociConfig: 'application/vnd.oci.image.config.v1+json',
  ociLayerGzip: 'application/vnd.oci.image.layer.v1.tar+gzip',
  dockerList: 'application/vnd.docker.distribution.manifest.list.v2+json',
  dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
  dockerConfig: 'application/vnd.docker.container.image.v1+json',
  dockerLayerGzip: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
} as const;

const MANIFEST_ACCEPT = [MT.ociIndex, MT.ociManifest, MT.dockerList, MT.dockerManifest].join(', ');

export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { os: string; architecture: string; variant?: string };
  annotations?: Record<string, string>;
  [k: string]: unknown;
}

export interface Manifest {
  schemaVersion: 2;
  mediaType?: string;
  config: Descriptor;
  layers: Descriptor[];
  annotations?: Record<string, string>;
  [k: string]: unknown;
}

export interface ImageConfig {
  created?: string;
  architecture?: string;
  os?: string;
  config?: Record<string, unknown>;
  rootfs: { type: 'layers'; diff_ids: string[] };
  history?: { created?: string; created_by?: string; comment?: string; empty_layer?: boolean; author?: string }[];
  [k: string]: unknown;
}

export interface ResolvedImage {
  manifest: Manifest;
  manifestMediaType: string;
  manifestDigest: string;
  config: ImageConfig;
  /** Digest of the multi-platform index the manifest was selected from, if any. */
  indexDigest?: string;
}

export interface Credentials { username: string; password: string }

export interface RegistryOptions {
  /** Prefix prepended to every request URL (CORS proxy for browsers). */
  corsProxy?: string;
  insecure?: (host: string) => boolean;
  getCredentials?: (registry: string) => Promise<Credentials | undefined>;
  fetch?: typeof fetch;
}

export class RegistryError extends Error {
  readonly status?: number;
  /** True when the request never got a response, e.g. a browser CORS block. */
  readonly network: boolean;
  constructor(message: string, status?: number, network = false) {
    super(message);
    this.status = status;
    this.network = network;
  }
}

interface Challenge { scheme: string; params: Record<string, string> }

function parseChallenge(header: string): Challenge {
  const sp = header.indexOf(' ');
  const scheme = (sp < 0 ? header : header.slice(0, sp)).toLowerCase();
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header.slice(sp + 1)))) params[m[1].toLowerCase()] = m[2] ?? m[3];
  return { scheme, params };
}

// Used when a browser cannot read WWW-Authenticate (registry did not expose it via CORS).
const KNOWN_REALMS: Record<string, Challenge> = {
  'registry-1.docker.io': { scheme: 'bearer', params: { realm: 'https://auth.docker.io/token', service: 'registry.docker.io' } },
  'ghcr.io': { scheme: 'bearer', params: { realm: 'https://ghcr.io/token', service: 'ghcr.io' } },
  'quay.io': { scheme: 'bearer', params: { realm: 'https://quay.io/v2/auth', service: 'quay.io' } },
};

function platformMatches(d: Descriptor, platform: string): boolean {
  const [os, arch, variant] = platform.split('/');
  const p = d.platform;
  if (!p || p.os !== os || p.architecture !== arch) return false;
  return !variant || p.variant === variant;
}

export class RegistryClient {
  private readonly tokens = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;
  private readonly opts: RegistryOptions;

  constructor(opts: RegistryOptions = {}) {
    this.opts = opts;
    const base = opts.fetch ?? ((...a) => fetch(...a));
    // Browsers report CORS rejections as an opaque "Failed to fetch" with no status. It is a
    // TypeError natively, but VS Code's web extension host wraps fetch, so do not rely on the class.
    this.fetchImpl = async (input, init) => {
      try {
        return await base(input, init);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        const url = new URL(String(input instanceof Request ? input.url : input));
        const hint = this.opts.corsProxy
          ? `check that the proxy ${this.opts.corsProxy} is reachable and allows this origin and host`
          : 'in VS Code for the Web this is usually CORS: set ociLayers.corsProxy (see README)';
        throw new RegistryError(`cannot reach ${url.host} (${(e as Error)?.message ?? e}); ${hint}`, undefined, true);
      }
    };
  }

  baseUrl(ref: Pick<ImageRef, 'apiHost'>): string {
    const host = ref.apiHost;
    const hostname = host.replace(/:\d+$/, '');
    const insecure = this.opts.insecure?.(host) || this.opts.insecure?.(hostname);
    return `${insecure ? 'http' : 'https'}://${host}`;
  }

  private proxied(url: string): string {
    return this.opts.corsProxy ? this.opts.corsProxy + url : url;
  }

  /**
   * Send a request, handling Bearer/Basic auth challenges.
   * `repos` lists every repository the request touches with the actions needed.
   */
  async request(
    ref: ImageRef,
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: Uint8Array; repos?: [string, string][] } = {},
  ): Promise<Response> {
    const repos = init.repos ?? [[ref.repository, 'pull']];
    const key = `${ref.apiHost}|${repos.map((r) => r.join(':')).join(' ')}`;
    const send = (auth?: string) => {
      const headers: Record<string, string> = { ...init.headers };
      if (auth) headers.Authorization = auth;
      return this.fetchImpl(this.proxied(url), { method, headers, body: init.body as BodyInit | undefined });
    };
    let res = await send(this.tokens.get(key));
    if (res.status !== 401) return res;

    const header = res.headers.get('www-authenticate');
    const challenge = header ? parseChallenge(header) : KNOWN_REALMS[ref.apiHost];
    if (!challenge) throw new RegistryError(`401 from ${ref.apiHost} without a readable WWW-Authenticate header (CORS?)`, 401);
    const creds = await this.opts.getCredentials?.(ref.registry);
    let auth: string;
    if (challenge.scheme === 'basic') {
      if (!creds) throw new RegistryError(`${ref.registry} requires credentials`, 401);
      auth = `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
    } else if (challenge.scheme === 'bearer') {
      auth = `Bearer ${await this.fetchToken(challenge, repos, creds)}`;
    } else {
      throw new RegistryError(`unsupported auth scheme "${challenge.scheme}"`, 401);
    }
    this.tokens.set(key, auth);
    res = await send(auth);
    if (res.status === 401 || res.status === 403) {
      throw new RegistryError(
        `${method} ${url}: ${res.status} ${await res.text().catch(() => '')}`.trim() +
          (creds ? '' : ' (sign in with "OCI Layers: Sign In to Registry")'),
        res.status,
      );
    }
    return res;
  }

  private async fetchToken(c: Challenge, repos: [string, string][], creds?: Credentials): Promise<string> {
    const u = new URL(c.params.realm);
    if (c.params.service) u.searchParams.set('service', c.params.service);
    for (const [repo, actions] of repos) u.searchParams.append('scope', `repository:${repo}:${actions}`);
    const headers: Record<string, string> = {};
    if (creds) headers.Authorization = `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
    const res = await this.fetchImpl(this.proxied(u.toString()), { headers });
    if (!res.ok) throw new RegistryError(`token request to ${u.host} failed: ${res.status}`, res.status);
    const body = (await res.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new RegistryError(`token response from ${u.host} has no token`);
    return token;
  }

  private async check(res: Response, what: string): Promise<Response> {
    if (!res.ok) throw new RegistryError(`${what}: ${res.status} ${await res.text().catch(() => '')}`.trim(), res.status);
    return res;
  }

  async getManifest(ref: ImageRef, reference = refReference(ref)) {
    const url = `${this.baseUrl(ref)}/v2/${ref.repository}/manifests/${reference}`;
    const res = await this.check(await this.request(ref, 'GET', url, { headers: { Accept: MANIFEST_ACCEPT } }), `GET manifest ${reference}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const json = JSON.parse(new TextDecoder().decode(bytes));
    const mediaType: string = json.mediaType ?? res.headers.get('content-type')?.split(';')[0] ?? MT.ociManifest;
    const digest = await sha256(bytes);
    if (reference.startsWith('sha256:') && reference !== digest) throw new RegistryError(`manifest digest mismatch for ${reference}`);
    return { bytes, json, mediaType, digest };
  }

  /** Resolve a reference to a single-platform manifest plus its config. */
  async resolve(ref: ImageRef, platform: string): Promise<ResolvedImage> {
    let m = await this.getManifest(ref);
    let indexDigest: string | undefined;
    if (m.mediaType === MT.ociIndex || m.mediaType === MT.dockerList || Array.isArray(m.json.manifests)) {
      const manifests = m.json.manifests as Descriptor[];
      const pick = manifests.find((d) => platformMatches(d, platform));
      if (!pick) {
        const avail = manifests.map((d) => d.platform && [d.platform.os, d.platform.architecture, d.platform.variant].filter(Boolean).join('/')).filter(Boolean);
        throw new RegistryError(`no manifest for platform ${platform}; available: ${avail.join(', ')}`);
      }
      indexDigest = m.digest;
      m = await this.getManifest(ref, pick.digest);
    }
    const manifest = m.json as Manifest;
    if (manifest.schemaVersion !== 2 || !manifest.config || !Array.isArray(manifest.layers)) {
      throw new RegistryError(`unsupported manifest type ${m.mediaType}`);
    }
    const config = JSON.parse(new TextDecoder().decode(await this.getBlob(ref, manifest.config.digest))) as ImageConfig;
    return { manifest, manifestMediaType: m.mediaType, manifestDigest: m.digest, config, indexDigest };
  }

  async getBlob(ref: ImageRef, digest: string): Promise<Uint8Array> {
    const url = `${this.baseUrl(ref)}/v2/${ref.repository}/blobs/${digest}`;
    const res = await this.check(await this.request(ref, 'GET', url), `GET blob ${digest}`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (digest.startsWith('sha256:') && (await sha256(data)) !== digest) throw new RegistryError(`blob digest mismatch for ${digest}`);
    return data;
  }

  async hasBlob(ref: ImageRef, digest: string): Promise<boolean> {
    const url = `${this.baseUrl(ref)}/v2/${ref.repository}/blobs/${digest}`;
    const res = await this.request(ref, 'HEAD', url, { repos: [[ref.repository, 'pull,push']] });
    return res.ok;
  }

  /** Try a cross-repository mount. Returns true if the blob now exists in `ref`. */
  async mountBlob(ref: ImageRef, digest: string, fromRepo: string): Promise<boolean> {
    const url = `${this.baseUrl(ref)}/v2/${ref.repository}/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(fromRepo)}`;
    const res = await this.request(ref, 'POST', url, { repos: [[ref.repository, 'pull,push'], [fromRepo, 'pull']] });
    if (res.status === 201) return true;
    // 202 means the registry started a regular upload session instead; abandon it.
    const loc = res.headers.get('location');
    if (res.status === 202 && loc) {
      await this.request(ref, 'DELETE', new URL(loc, this.baseUrl(ref)).toString(), { repos: [[ref.repository, 'pull,push']] }).catch(() => undefined);
    }
    return false;
  }

  /** Monolithic upload: POST to open a session, then PUT the bytes with ?digest=. */
  async uploadBlob(ref: ImageRef, data: Uint8Array, digest: string): Promise<void> {
    const repos: [string, string][] = [[ref.repository, 'pull,push']];
    const start = `${this.baseUrl(ref)}/v2/${ref.repository}/blobs/uploads/`;
    const res = await this.check(await this.request(ref, 'POST', start, { repos }), 'start upload');
    const loc = res.headers.get('location');
    if (!loc) throw new RegistryError('upload session has no Location header (CORS: expose "Location")');
    const u = new URL(loc, this.baseUrl(ref));
    u.searchParams.set('digest', digest);
    await this.check(
      await this.request(ref, 'PUT', u.toString(), {
        repos,
        body: data,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
      `upload blob ${digest}`,
    );
  }

  async putManifest(ref: ImageRef, reference: string, bytes: Uint8Array, mediaType: string): Promise<string> {
    const url = `${this.baseUrl(ref)}/v2/${ref.repository}/manifests/${reference}`;
    await this.check(
      await this.request(ref, 'PUT', url, { repos: [[ref.repository, 'pull,push']], body: bytes, headers: { 'Content-Type': mediaType } }),
      `PUT manifest ${reference}`,
    );
    return sha256(bytes);
  }
}
