import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { describe, itemTypes, type TimelineItem } from './events';

const token = process.env.GITHUB_TOKEN!.replace(/^Bearer /, '');
const pollSeconds = Number(process.env.POLL_SECONDS || 60);
const webhookUrl = process.env.CLAUDE_WEBHOOK_URL;
const webhookToken = process.env.CLAUDE_WEBHOOK_TOKEN;
const eventName = 'github.pull_request';

type Change = { repo: string; number: number; title: string; url: string; events: string[] };
type Event = { seq: number; timestamp: string; data: Change };

const buffer: Event[] = [];
let seq = 0;
let baselined = false;
let since = new Date().toISOString();
const sent = new Map<string, string>();
let pausedUntil = 0;
let pending: Change[] = [];
let nextFire = 0;

async function graphql(query: string, variables: Record<string, unknown>) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 403 || res.status === 429) {
    const retry = Number(res.headers.get('retry-after'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    pausedUntil = retry ? Date.now() + retry * 1000 : reset ? reset * 1000 : Date.now() + 60_000;
  }
  if (!res.ok) throw new Error(`graphql ${res.status}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(errors.map((e: { message: string }) => e.message).join('; '));
  if (data.rateLimit?.remaining < 100) pausedUntil = Date.parse(data.rateLimit.resetAt);
  return data;
}

const { viewer } = await graphql('{ viewer { login } }', {});
const query = process.env.GITHUB_QUERY || `is:pr archived:false author:${viewer.login}`;

// the search index lags behind writes, so each window overlaps the last and sent item ids are skipped
const overlap = 5 * 60_000;

async function pollPulls() {
  const now = new Date().toISOString();
  const from = new Date(Date.parse(since) - overlap).toISOString();
  let cursor: string | null = null;
  do {
    const data = await graphql(
      `query($q: String!, $after: String, $since: DateTime!) {
        rateLimit { remaining resetAt }
        search(type: ISSUE, query: $q, first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ... on PullRequest {
              url title number
              repository { nameWithOwner }
              timelineItems(since: $since, first: 100, itemTypes: [${itemTypes.join(', ')}]) {
                nodes {
                  __typename
                  ... on Node { id }
                  ... on LabeledEvent { createdAt actor { login } label { name } }
                  ... on UnlabeledEvent { createdAt actor { login } label { name } }
                  ... on PullRequestReview { createdAt author { login } state }
                  ... on IssueComment { createdAt author { login } }
                  ... on MergedEvent { createdAt actor { login } }
                  ... on ClosedEvent { createdAt actor { login } }
                  ... on ReopenedEvent { createdAt actor { login } }
                  ... on ReadyForReviewEvent { createdAt actor { login } }
                  ... on ConvertToDraftEvent { createdAt actor { login } }
                }
              }
            }
          }
        }
      }`,
      { q: `${query} updated:>=${from.replace(/\.\d+Z$/, '+00:00')}`, after: cursor, since: from },
    );
    for (const pull of data.search.nodes) {
      if (!pull.url) continue;
      const events: string[] = [];
      for (const item of pull.timelineItems.nodes as TimelineItem[]) {
        if (sent.has(item.id)) continue;
        sent.set(item.id, item.createdAt);
        const event = describe(item);
        if (event) events.push(event);
      }
      if (!events.length || !baselined) continue;
      const change = {
        repo: pull.repository.nameWithOwner,
        number: pull.number,
        title: pull.title,
        url: pull.url,
        events,
      };
      buffer.push({ seq: ++seq, timestamp: new Date().toISOString(), data: change });
      pending.push(change);
    }
    cursor = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null;
  } while (cursor);
  for (const [id, at] of sent) if (at < from) sent.delete(id);
  while (buffer.length && Date.parse(buffer[0].timestamp) < Date.now() - 86_400_000) buffer.shift();
  baselined = true;
  since = now;
}

// the fire endpoint allows 30 runs per hour per scheduled task, so changes are batched at most every 2 minutes
async function fire() {
  if (!webhookUrl || !pending.length || Date.now() < nextFire) return;
  nextFire = Date.now() + 120_000;
  const text = pending
    .map((c) => `${c.repo}#${c.number} ${c.title}\n${c.url}\n${c.events.map((e) => `- ${e}`).join('\n')}`)
    .join('\n\n');
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${webhookToken}`,
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`fire ${res.status} ${await res.text()}`);
  pending = [];
}

async function poll() {
  if (Date.now() >= pausedUntil) {
    try {
      await pollPulls();
    } catch (e) {
      console.error(e);
    }
  }
  try {
    await fire();
  } catch (e) {
    console.error(e);
  }
  setTimeout(poll, pollSeconds * 1000);
}
await poll();

const PollRequest = z.object({
  method: z.literal('events/poll'),
  params: z.object({
    name: z.string(),
    arguments: z.unknown().optional(),
    cursor: z.string().nullable().optional(),
    maxAgeMs: z.number().optional(),
    maxEvents: z.number().optional(),
  }),
});

function createServer() {
  const server = new Server(
    { name: 'github-events', version: '0.1.0' },
    { capabilities: { extensions: { 'io.modelcontextprotocol/events': {} } } },
  );
  server.setRequestHandler(z.object({ method: z.literal('events/list') }), () => ({
    resultType: 'complete',
    events: [
      {
        name: eventName,
        description: `New timeline events (labels, reviews, comments, merged, closed, reopened, draft) on pull requests matching "${query}". Carries no comment text.`,
        delivery: ['poll'],
        inputSchema: { type: 'object', properties: {} },
        payloadSchema: {
          type: 'object',
          properties: {
            repo: { type: 'string' },
            number: { type: 'integer' },
            title: { type: 'string' },
            url: { type: 'string' },
            events: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    ],
  }));
  server.setRequestHandler(PollRequest, ({ params }) => {
    if (params.name !== eventName) throw new Error(`unknown event ${params.name}`);
    const after = params.cursor == null ? seq : Number(params.cursor);
    const oldest = Date.now() - (params.maxAgeMs ?? Number.POSITIVE_INFINITY);
    const matches = buffer.filter((e) => e.seq > after && Date.parse(e.timestamp) >= oldest);
    const events = matches.slice(0, params.maxEvents ?? 100);
    const last = events.at(-1)?.seq ?? after;
    return {
      resultType: 'complete',
      events: events.map((e) => ({
        eventId: String(e.seq),
        name: eventName,
        timestamp: e.timestamp,
        data: e.data,
        cursor: String(e.seq),
      })),
      cursor: String(last),
      truncated: buffer.length > 0 && after < buffer[0].seq - 1,
      hasMore: matches.length > events.length,
      nextPollMs: pollSeconds * 1000,
    };
  });
  return server;
}

Bun.serve({
  port: Number(process.env.PORT || 8080),
  async fetch(req) {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await createServer().connect(transport);
    return transport.handleRequest(req);
  },
});
