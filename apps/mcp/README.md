# mcp-servers

Remote MCP server for Microsoft 365 built with the [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk), designed to work with [Claude custom connectors](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers).

## Structure

```text
apps/mcp/
├── Dockerfile
├── pyproject.toml
├── README.md
├── main.py        # MCPServer, Entra auth, OAuth proxy
└── tools/
    ├── graph.py       # Microsoft Graph (Outlook email & calendar)
    ├── google_maps.py # Google Maps Routes API
    └── flowsavvy.py   # FlowSavvy task management
```

## Tools

Only the FlowSavvy tools are registered. `main.py` leaves the Graph and Google Maps imports commented out. The cluster-1 ToolHive `selfhost` server runs this image, but both VirtualMCPServers hide its tools in favour of the official FlowSavvy connector.

|Tool|Description|
|---|---|
|`search_emails`|Free-text search over the user's mailbox|
|`list_emails`|List emails from a folder with optional unread and date-range filters|
|`read_email`|Read the full content of a specific email by ID|
|`list_calendar_events`|List calendar events with optional date-range filter|
|`search_calendar_events`|Search calendar events by subject or body text|
|`compute_route`|Compute a route between natural-language origin/destination with optional departure or arrival time|
|`list_flowsavvy_tasks`|List all tasks and events from FlowSavvy schedule|
|`create_flowsavvy_task`|Create a new task in FlowSavvy|

## Configuration

Register an application in [Microsoft Entra ID](https://portal.azure.com) and grant **delegated** Microsoft Graph permissions `Mail.Read` and `Calendars.Read`.

This server is an MCP Resource Server and uses Entra as the external Authorization Server. It validates incoming bearer tokens against Entra JWKS, then uses `OnBehalfOfCredential` to call Microsoft Graph.

```env
AZURE_TENANT_ID=common           # or your specific tenant ID
AZURE_CLIENT_ID=<app-client-id>
AZURE_CLIENT_SECRET=<app-client-secret>
GOOGLE_MAPS_API_KEY=<your-key>   # optional, for compute_route tool
FLOWSAVVY_COOKIE=<cookie-value>  # optional, Identity.Cookie value for FlowSavvy tools
```

Using `common` as the tenant ID supports both personal Microsoft accounts and work/school accounts.

## Running

```bash
docker build -t mcp apps/mcp
docker run -p 8000:8000 \
  -e AZURE_TENANT_ID=common \
  -e AZURE_CLIENT_ID=... \
  -e AZURE_CLIENT_SECRET=... \
  mcp
```

## Adding to Claude

1. Go to **Claude** → **Settings** → **Connectors** → **Add custom connector**
2. Enter `https://your-server.example.com/mcp`
3. Configure OAuth against your Entra app (no DCR required)
4. Claude sends bearer tokens to this MCP server, which exchanges them on-behalf-of the user for Graph calls
