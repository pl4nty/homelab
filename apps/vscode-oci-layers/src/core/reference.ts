// Image reference parsing, following Docker's normalisation rules
// (https://github.com/distribution/reference).

export interface ImageRef {
  /** Registry host as written by the user, e.g. "docker.io", "ghcr.io", "localhost:5000". */
  registry: string;
  /** Host to send API requests to (docker.io -> registry-1.docker.io). */
  apiHost: string;
  repository: string;
  tag?: string;
  digest?: string;
}

export function parseRef(input: string): ImageRef {
  let rest = input.trim();
  if (!rest) throw new Error('empty image reference');
  let digest: string | undefined;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!/^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/.test(digest)) throw new Error(`invalid digest "${digest}"`);
  }
  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error(`invalid tag "${tag}"`);
  }
  let registry = 'docker.io';
  const slash = rest.indexOf('/');
  if (slash >= 0) {
    const first = rest.slice(0, slash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      registry = first;
      rest = rest.slice(slash + 1);
    }
  }
  if (registry === 'index.docker.io') registry = 'docker.io';
  if (registry === 'docker.io' && !rest.includes('/')) rest = `library/${rest}`;
  if (!/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(rest)) {
    throw new Error(`invalid repository "${rest}"`);
  }
  if (!tag && !digest) tag = 'latest';
  return {
    registry,
    apiHost: registry === 'docker.io' ? 'registry-1.docker.io' : registry,
    repository: rest,
    tag,
    digest,
  };
}

export function formatRef(ref: ImageRef): string {
  let s = `${ref.registry}/${ref.repository}`;
  if (ref.tag) s += `:${ref.tag}`;
  if (ref.digest) s += `@${ref.digest}`;
  return s;
}

/** The tag or digest to request from the manifests endpoint. */
export function refReference(ref: ImageRef): string {
  return ref.digest ?? ref.tag ?? 'latest';
}
