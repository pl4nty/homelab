// Outbound fetches: a per-host concurrency cap, a timeout, and retries on transient failures.
const queues = new Map<string, { active: number; waiting: (() => void)[] }>();
const LIMITS: Record<string, number> = { default: 8 };

async function acquire(host: string): Promise<() => void> {
  let q = queues.get(host);
  if (!q) {
    q = { active: 0, waiting: [] };
    queues.set(host, q);
  }
  const limit = LIMITS[host] ?? LIMITS.default;
  if (q.active >= limit) await new Promise<void>((resolve) => q.waiting.push(resolve));
  q.active++;
  return () => {
    q.active--;
    q.waiting.shift()?.();
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    url: string,
  ) {
    super(`${status} from ${new URL(url).host}`);
  }
}

export async function fetchBuffer(url: string, init: RequestInit = {}, tries = 3, timeoutMs = 30000): Promise<Buffer> {
  const host = new URL(url).host;
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    const release = await acquire(host);
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok || res.status === 206) return Buffer.from(await res.arrayBuffer());
      await res.body?.cancel();
      // 4xx other than throttling will not improve on retry.
      if (res.status < 500 && res.status !== 429 && res.status !== 408) throw new HttpError(res.status, url);
      last = new HttpError(res.status, url);
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && e.status !== 429 && e.status !== 408) throw e;
      last = e;
    } finally {
      release();
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  return JSON.parse((await fetchBuffer(url, init)).toString('utf8')) as T;
}
