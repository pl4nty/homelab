# github-channel

[Claude Code channel](https://code.claude.com/docs/en/channels) that pushes GitHub pull request changes and notifications into a running Claude Code session, so Claude reacts within a minute instead of on a schedule.

Channels are a research preview. Claude Code spawns the server as a local stdio subprocess, so it can't run in the cluster behind ToolHive.

## Events

The server polls GitHub every `POLL_SECONDS` and sends one `<channel source="github">` event per change.

- `kind="pr"`: a pull request that matches `GITHUB_QUERY` changed. The event lists added or removed labels, a new review, the review decision, new comments, more unresolved review threads, the check rollup, draft state, and merged or closed. Each poll is one GraphQL search, which costs a few points of the 5,000 per hour.
- `kind="notification"`: a new or updated unread [notification](https://docs.github.com/en/rest/activity/notifications) thread that isn't one of those pull requests. It honours `X-Poll-Interval` and `If-Modified-Since`, so unchanged polls don't count against the rate limit.

Events never include comment or review text, because anyone can write it. Claude reads the pull request itself.

The first run records a baseline and sends nothing. State persists in `STATE_FILE`, so changes made while Claude Code was closed arrive on the next start.

GitHub doesn't send notifications for label changes, or for threads you ignore. The search covers both.

## Configuration

|Variable|Default|
|---|---|
|`GITHUB_TOKEN`|`gh auth token`. Classic token with `repo` or `notifications` scope; fine-grained tokens can't read notifications|
|`GITHUB_QUERY`|`is:pr is:open archived:false author:<you>`|
|`POLL_SECONDS`|`60`|
|`NOTIFICATIONS`|`true`|
|`STATE_FILE`|`~/.cache/github-channel/state.json`|
|`GITHUB_API_URL`|`https://api.github.com`|

## Running

Download a binary from the `github-channel` [releases](https://github.com/pl4nty/homelab/releases), or run `bun index.ts`. Add it to `.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "github-channel-windows-x64.exe",
      "env": { "GITHUB_QUERY": "is:pr is:open author:pl4nty repo:microsoft/winget-pkgs" }
    }
  }
}
```

Then start Claude Code with the channel. Custom channels aren't on the approved allowlist, so they need the development flag:

```sh
claude --dangerously-load-development-channels server:github
```
