# github-events

MCP server that turns GitHub pull request activity into [MCP Events](https://modelcontextprotocol.io/extensions/events/overview) and fires a [Claude Code scheduled task](https://code.claude.com/docs/en/routines#api-trigger) through its API trigger.

GitHub can't send webhooks for repositories you don't administer, such as upstream pull requests, so the server polls. Every `POLL_SECONDS` it runs one GraphQL search for pull requests matching `GITHUB_QUERY` that were updated since the last poll, and reads their timeline since then: labels added or removed, reviews, comments, merged, closed, reopened, and draft state. The search index lags behind GitHub, so each poll overlaps the last by 5 minutes and skips timeline items it already saw.

Events never include comment or review text, because anyone can write it.

## Events

The server advertises `io.modelcontextprotocol/events` and offers one event, `github.pull_request`, over `poll` delivery. `events/poll` replays from a cursor for 24 hours. Events are kept in memory, so a restart starts from now.

## Claude webhook

When `CLAUDE_WEBHOOK_URL` is set, changes are POSTed to it as the `text` of a `/fire` request, which the scheduled task's prompt reads from its `<routine-fire-payload>` block. The endpoint allows 30 fires per hour per task, so changes are batched at most every 2 minutes.

## Configuration

|Variable|Default|
|---|---|
|`GITHUB_AUTHORIZATION`|Required. `Authorization` header for GitHub, such as `Bearer <token>`|
|`GITHUB_QUERY`|`is:pr archived:false author:<token owner>`|
|`POLL_SECONDS`|`60`|
|`CLAUDE_WEBHOOK_URL`|The scheduled task's `/fire` URL|
|`CLAUDE_WEBHOOK_TOKEN`|The scheduled task's API trigger token|
|`PORT`|`8080`|
