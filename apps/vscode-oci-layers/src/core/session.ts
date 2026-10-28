// An opened image: resolved manifest + merged filesystem + pending edits.

import { decompressLayer, gzip, sha256 } from './bytes.ts';
import { Overlay, Tree } from './overlay.ts';
import type { ImageRef } from './reference.ts';
import { formatRef, parseRef } from './reference.ts';
import type { Descriptor, ImageConfig, RegistryClient, ResolvedImage } from './registry.ts';
import { MT, RegistryError } from './registry.ts';
import { parseTar, writeTar } from './tar.ts';

export interface LayerInfo {
  descriptor: Descriptor;
  diffId?: string;
  createdBy?: string;
  comment?: string;
  created?: string;
}

export type Progress = (message: string) => void;

const enc = new TextEncoder();

export function layerInfos(r: ResolvedImage): LayerInfo[] {
  const history = (r.config.history ?? []).filter((h) => !h.empty_layer);
  return r.manifest.layers.map((descriptor, i) => ({
    descriptor,
    diffId: r.config.rootfs?.diff_ids?.[i],
    createdBy: history[i]?.created_by,
    comment: history[i]?.comment,
    created: history[i]?.created,
  }));
}

export class ImageSession {
  ref: ImageRef;
  resolved: ResolvedImage;
  readonly overlay: Overlay;
  private readonly client: RegistryClient;

  private constructor(ref: ImageRef, resolved: ResolvedImage, overlay: Overlay, client: RegistryClient) {
    this.ref = ref;
    this.resolved = resolved;
    this.overlay = overlay;
    this.client = client;
  }

  get layers(): LayerInfo[] { return layerInfos(this.resolved); }

  /** Pinned reference (repository@digest) of the image the overlay is based on. */
  get pinned(): string {
    return formatRef({ ...this.ref, tag: undefined, digest: this.resolved.manifestDigest });
  }

  static async open(
    client: RegistryClient,
    reference: string,
    opts: { platform: string; maxBytes?: number; progress?: Progress },
  ): Promise<ImageSession> {
    const ref = parseRef(reference);
    opts.progress?.(`Resolving ${formatRef(ref)}`);
    const resolved = await client.resolve(ref, opts.platform);
    const total = resolved.manifest.layers.reduce((n, l) => n + l.size, 0);
    if (opts.maxBytes && total > opts.maxBytes) {
      throw new RegistryError(`image layers total ${(total / 2 ** 20).toFixed(0)} MiB, above the ${(opts.maxBytes / 2 ** 20).toFixed(0)} MiB limit (ociLayers.maxImageSizeMB)`);
    }
    const tree = new Tree();
    const layers = resolved.manifest.layers;
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      opts.progress?.(`Layer ${i + 1}/${layers.length} ${l.digest.slice(7, 19)} (${(l.size / 2 ** 20).toFixed(1)} MiB)`);
      const tar = await decompressLayer(l.mediaType, await client.getBlob(ref, l.digest));
      tree.applyLayer(parseTar(tar));
    }
    return new ImageSession(ref, resolved, new Overlay(tree), client);
  }

  /** Copy a blob into `target` if it is not there already (cross-repo mount, else download + upload). */
  private async ensureBlob(target: ImageRef, d: Descriptor): Promise<void> {
    if (target.apiHost === this.ref.apiHost && target.repository === this.ref.repository) return;
    if (await this.client.hasBlob(target, d.digest)) return;
    if (target.apiHost === this.ref.apiHost && (await this.client.mountBlob(target, d.digest, this.ref.repository))) return;
    await this.client.uploadBlob(target, await this.client.getBlob(this.ref, d.digest), d.digest);
  }

  /**
   * Write pending edits as a new layer, push it and a new manifest to `target`,
   * then rebase the session on the pushed image.
   */
  async commit(target: ImageRef, message: string, progress?: Progress): Promise<{ ref: ImageRef; digest: string; layer: Descriptor }> {
    const entries = this.overlay.toLayerEntries();
    if (!entries.length) throw new Error('nothing to commit');
    const now = new Date();
    progress?.('Building layer');
    const tar = writeTar(entries);
    const diffId = await sha256(tar);
    const blob = await gzip(tar);
    const isDocker = this.resolved.manifestMediaType === MT.dockerManifest;
    const layer: Descriptor = { mediaType: isDocker ? MT.dockerLayerGzip : MT.ociLayerGzip, digest: await sha256(blob), size: blob.length };

    const { manifest } = this.resolved;
    for (const [i, d] of manifest.layers.entries()) {
      if (Array.isArray(d.urls)) continue; // foreign (non-distributable) layer: never copied
      progress?.(`Copying layer ${i + 1}/${manifest.layers.length} to ${target.repository}`);
      await this.ensureBlob(target, d);
    }
    progress?.(`Uploading new layer (${(blob.length / 1024).toFixed(1)} KiB)`);
    if (!(await this.client.hasBlob(target, layer.digest))) await this.client.uploadBlob(target, blob, layer.digest);

    const config: ImageConfig = structuredClone(this.resolved.config);
    config.created = now.toISOString();
    config.rootfs = { type: 'layers', diff_ids: [...(config.rootfs?.diff_ids ?? []), diffId] };
    config.history = [
      ...(config.history ?? []),
      { created: config.created, created_by: 'vscode oci-layers: commit', comment: message || undefined },
    ];
    const configBytes = enc.encode(JSON.stringify(config));
    const configDesc: Descriptor = { ...manifest.config, digest: await sha256(configBytes), size: configBytes.length };
    progress?.('Uploading config');
    if (!(await this.client.hasBlob(target, configDesc.digest))) await this.client.uploadBlob(target, configBytes, configDesc.digest);

    const newManifest = { ...structuredClone(manifest), config: configDesc, layers: [...manifest.layers, layer] };
    const manifestBytes = enc.encode(JSON.stringify(newManifest));
    progress?.(`Pushing manifest to ${formatRef(target)}`);
    const digest = await this.client.putManifest(target, target.tag ?? (await sha256(manifestBytes)), manifestBytes, this.resolved.manifestMediaType);

    this.ref = { ...target, digest: undefined };
    this.resolved = { manifest: newManifest, manifestMediaType: this.resolved.manifestMediaType, manifestDigest: digest, config };
    this.overlay.flatten();
    return { ref: { ...target, digest }, digest, layer };
  }
}
