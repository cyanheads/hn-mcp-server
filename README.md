# hn-mcp-server

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

MCP server for [Hacker News](https://news.ycombinator.com). Wraps the HN Firebase API and Algolia Search API to give LLM agents read-only access to feeds, threaded discussions, user profiles, and full-text search.

Built on [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core).

## Tools

| Tool | Description |
|:-----|:------------|
| `get_stories` | Fetch stories from an HN feed (top, new, best, ask, show, jobs) with pagination |
| `get_thread` | Get an item and its comment tree as a threaded discussion with depth/count controls |
| `get_user` | Fetch a user profile with optional recent submission resolution |
| `search_hn` | Search stories and comments via Algolia with type, author, date, and score filters |

## Quick Start

### Claude Desktop / Cursor

Add to your MCP client config:

```json
{
  "mcpServers": {
    "hn-mcp-server": {
      "command": "npx",
      "args": ["-y", "hn-mcp-server", "run", "start:stdio"]
    }
  }
}
```

### HTTP Transport

```bash
MCP_TRANSPORT_TYPE=http npx hn-mcp-server run start:http
```

The server starts on `http://localhost:3010/mcp` by default.

## Configuration

All configuration is via environment variables. No API keys required — HN APIs are public.

| Variable | Default | Description |
|:---------|:--------|:------------|
| `MCP_TRANSPORT_TYPE` | `stdio` | Transport: `stdio` or `http` |
| `MCP_HTTP_PORT` | `3010` | HTTP server port |
| `MCP_HTTP_HOST` | `localhost` | HTTP server host |
| `MCP_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `notice`, `warning`, `error` |
| `HN_CONCURRENCY_LIMIT` | `10` | Max concurrent requests for batch item fetches (1–50) |

## Development

```bash
bun install
bun run dev:stdio       # Dev mode (stdio, auto-reload)
bun run test            # Run test suite
bun run devcheck        # Lint + format + typecheck + audit
bun run build           # Compile for production
```

## License

[Apache-2.0](LICENSE)
