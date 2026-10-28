const utf8 = new TextDecoder();

export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class GitHub {
  constructor(token, repo) {
    this.token = token;
    this.repo = repo;
  }

  async api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body && JSON.stringify(body),
    });
    const json = res.status === 204 ? null : await res.json();
    if (!res.ok)
      throw Object.assign(new Error(`GitHub ${res.status}: ${json?.message ?? res.statusText}`), {
        status: res.status,
      });
    return json;
  }

  async defaultBranch() {
    return (await this.api('')).default_branch;
  }

  async tree(ref) {
    const t = await this.api(`/git/trees/${encodeURI(ref)}?recursive=1`);
    return t.tree.filter((e) => e.type === 'blob').map((e) => e.path);
  }

  async read(path, ref) {
    const f = await this.api(`/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`);
    const bin = atob(f.content.replace(/\n/g, ''));
    return { text: utf8.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))), sha: f.sha };
  }

  // Creates the branch from the default branch if it doesn't exist yet. Returns true if created.
  async ensureBranch(branch) {
    try {
      await this.api(`/git/ref/heads/${encodeURI(branch)}`);
      return false;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const base = await this.api(`/git/ref/heads/${encodeURI(await this.defaultBranch())}`);
    await this.api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: base.object.sha } });
    return true;
  }

  async write(path, branch, text, sha, message) {
    const r = await this.api(`/contents/${encodeURI(path)}`, {
      method: 'PUT',
      body: { message, content: toBase64(text), branch, sha },
    });
    return { sha: r.content.sha, url: r.commit.html_url };
  }
}
