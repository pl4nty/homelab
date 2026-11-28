# github-events

MCP server that polls GitHub every minute for timeline events (labels, reviews, comments, merged, closed, reopened) on pull requests matching `GITHUB_QUERY`. It serves them as [MCP Events](https://modelcontextprotocol.io/extensions/events/overview) over `events/poll`, and fires a Claude Code scheduled task through its [API trigger](https://code.claude.com/docs/en/routines) at most every 2 minutes. Events carry no comment text, and live in memory only.

Upstream repositories can't send webhooks to it, hence polling.
