# Miniflux Rewriter

A webhook service that receives POSTs from Miniflux when new entries are added, applies rewrite rules to them, and updates them using the Miniflux API.

This app was a one-shot with GitHub Copilot agent mode and Claude 3.7 Sonnet.

## Features

- Receives webhooks from Miniflux for new entries
- Applies configurable rewrite rules based on feed ID
- Currently implemented rules:
  - AI Summary: Prepends an AI-generated summary to the content using OpenAI

## Setup

### Rules

Rules are configured in a `rules.yaml` file. For example:

```yaml
feed_rules:
  # Feed ID: List of rule names to apply
  "853":
    - ai_summary
```

Modify this file to include the feed IDs you want to apply rules to.

### Environment Variables

Create a `.env` file with the following variables:

```env
MINIFLUX_API_URL=http://your-miniflux-instance/v1
MINIFLUX_API_KEY=
WEBHOOK_SECRET=
```

### Setting Up the Webhook in Miniflux

1. In Miniflux, go to Settings > Integrations
2. Enable Webhooks with a URL pointing to your rewriter instance: `http://your-rewriter-instance:8080`
3. Copy the webhook secret to the `.env` file
4. In Settings > API Keys, create a new API key
5. Copy the token to the `.env` file

### Docker

Run the container using the pre-built image:

```bash
docker run -p 8080:8080 --env-file .env -v ./rules.yaml:/app/data/rules.yaml ghcr.io/pl4nty/miniflux-rewriter
```

## Adding New Rules

To add new rewriting rules:

1. Add a function for the rule, and call it from `apply_rules()`
2. Test with custom config
