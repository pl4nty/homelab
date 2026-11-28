const token = process.env.GITHUB_TOKEN!.replace(/^Bearer /, '');
const query = process.env.GITHUB_QUERY!;
const webhookUrl = process.env.CLAUDE_WEBHOOK_URL!;
const webhookToken = process.env.CLAUDE_WEBHOOK_TOKEN!;
const name = 'github.pull_request';

type Event = { eventId: string; name: string; timestamp: string; data: unknown; cursor: string };
const events: Event[] = [];
const seen = new Set<string>();
let since = new Date();
let pending: string[] = [];
let lastFire = 0;
let baselined = false;

const actor = 'actor { login } createdAt';
const types: Record<string, string> = {
  LabeledEvent: `${actor} label { name }`,
  UnlabeledEvent: `${actor} label { name }`,
  PullRequestReview: 'author { login } createdAt state',
  IssueComment: 'author { login } createdAt',
  MergedEvent: actor,
  ClosedEvent: actor,
  ReopenedEvent: actor,
};
const itemTypes = Object.keys(types).map((t) => t.replace(/(?<!^)[A-Z]/g, '_$&').toUpperCase());

async function poll() {
  // the search index lags, so windows overlap by 5 minutes and seen item ids are skipped
  const from = new Date(since.getTime() - 300_000).toISOString();
  since = new Date();
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      variables: { q: `${query} updated:>=${from.slice(0, 19)}Z`, since: from },
      query: `query($q: String!, $since: DateTime!) {
        search(type: ISSUE, query: $q, first: 100) { nodes { ... on PullRequest {
          url title repository { nameWithOwner } number
          timelineItems(since: $since, first: 100, itemTypes: [${itemTypes}]) { nodes {
            __typename ... on Node { id }
            ${Object.entries(types)
              .map(([t, f]) => `... on ${t} { ${f} }`)
              .join(' ')}
          } }
        } } }
      }`,
    }),
  });
  const { data, errors } = await res.json();
  if (errors) throw new Error(JSON.stringify(errors));
  for (const pr of data.search.nodes) {
    const changes = [];
    for (const item of pr.timelineItems.nodes) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const who = (item.actor ?? item.author)?.login ?? 'ghost';
      changes.push(`${item.__typename} ${item.label?.name ?? item.state ?? ''} by ${who}`.replace('  ', ' '));
    }
    if (!changes.length || !baselined) continue;
    const pull = { repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url, changes };
    const cursor = String(events.length + 1);
    events.push({ eventId: cursor, name, timestamp: new Date().toISOString(), data: pull, cursor });
    pending.push(`${pull.repo}#${pull.number} ${pull.title}\n${pull.url}\n${changes.map((c) => `- ${c}`).join('\n')}`);
  }
  baselined = true;
}

// the fire endpoint allows 30 runs per hour per scheduled task
async function fire() {
  if (!pending.length || Date.now() - lastFire < 120_000) return;
  lastFire = Date.now();
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${webhookToken}`,
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text: pending.join('\n\n') }),
  });
  if (!res.ok) throw new Error(`fire ${res.status} ${await res.text()}`);
  pending = [];
}

setInterval(() => poll().then(fire).catch(console.error), 60_000);
await poll().then(fire);

const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
  initialize: (params) => ({
    protocolVersion: params.protocolVersion,
    capabilities: { extensions: { 'io.modelcontextprotocol/events': {} } },
    serverInfo: { name: 'github-events', version: '0.1.0' },
  }),
  ping: () => ({}),
  'events/list': () => ({
    resultType: 'complete',
    events: [{ name, description: `Timeline events on pull requests matching "${query}"`, delivery: ['poll'] }],
  }),
  'events/poll': ({ cursor }) => {
    const after = cursor == null ? events.length : Number(cursor);
    return {
      resultType: 'complete',
      events: events.slice(after),
      cursor: String(events.length),
      truncated: false,
      hasMore: false,
      nextPollMs: 60_000,
    };
  },
};

Bun.serve({
  port: 8080,
  async fetch(req) {
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    const { id, method, params } = await req.json();
    if (id === undefined) return new Response(null, { status: 202 });
    const result = methods[method]?.(params ?? {});
    return Response.json(
      result
        ? { jsonrpc: '2.0', id, result }
        : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } },
    );
  },
});
