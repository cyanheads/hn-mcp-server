<div align="center">
  <h1>@cyanheads/hn-mcp-server</h1>
  <p><b>MCP server for Hacker News. Feeds, threaded discussions, user profiles, and full-text search via the HN Firebase and Algolia APIs. Runs over stdio or HTTP.</b></p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun->=1.2.0-f9f1e1.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

**Public Hosted Server:** [https://hn.caseyjhand.com/mcp](https://hn.caseyjhand.com/mcp)

</div>

---

## Tools

Four read-only tools for accessing Hacker News data:

| Tool Name | Description |
|:----------|:------------|
| `get_stories` | Fetch stories from an HN feed (top, new, best, ask, show, jobs) with pagination. |
| `get_thread` | Get an item and its comment tree as a threaded discussion with depth/count controls. |
| `get_user` | Fetch a user profile with karma, about, and optionally their recent submissions. |
| `search_hn` | Search stories and comments via Algolia with type, author, date, and score filters. |

### `get_stories`

Fetch stories from any HN feed with pagination support.

- Six feed types: `top`, `new`, `best`, `ask`, `show`, `jobs`
- Configurable count (1–100, default 30) and offset for pagination
- Returns enriched story objects with title, URL, score, author, comment count, and body text

---

### `get_thread`

Retrieve an item and its full comment tree via ranked breadth-first traversal.

- Depth control (0–10, default 3) — depth 0 doubles as a single-item lookup
- Comment limit (1–200, default 50) caps total comments across all levels
- Breadth-first traversal preserves HN's ranking order
- Flat comment list with `depth`/`parentId` for tree reconstruction

---

### `get_user`

Fetch a user profile with optional recent submission resolution.

- Profile includes karma, creation date, and about text (HTML stripped)
- Optionally resolves up to 50 most recent submissions into full items
- Submission resolution filters out dead/deleted items

---

### `search_hn`

Full-text search via the Algolia HN Search API.

- Filter by content type: `story`, `comment`, `ask_hn`, `show_hn`, `front_page`
- Filter by author, date range (ISO 8601), and minimum points
- Sort by relevance or date
- Pagination with page/count controls

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Structured logging with request correlation
- Runs locally (stdio/HTTP) from the same codebase

HN-specific:

- Concurrent batch fetching with configurable parallelism for item resolution
- HTML entity decoding and tag stripping with code block and link preservation
- No API keys required — HN APIs are public

## Getting Started

### Public Hosted Instance

A public instance is available at `https://hn.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "hn": {
      "type": "streamable-http",
      "url": "https://hn.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hn-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/hn-mcp-server@latest"]
    }
  }
}
```

Or with npx:

```json
{
  "mcpServers": {
    "hn-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/hn-mcp-server"]
    }
  }
}
```

### Prerequisites

- [Bun v1.2.0](https://bun.sh/) or higher (or Node.js >= 22)

### Installation

```sh
git clone https://github.com/cyanheads/hn-mcp-server.git
cd hn-mcp-server
bun install
```

## Configuration

All configuration is via environment variables. No API keys required — HN APIs are public.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `HN_CONCURRENCY_LIMIT` | Max concurrent HTTP requests for batch item fetches (1–50). | `10` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_HOST` | HTTP server host. | `localhost` |
| `MCP_LOG_LEVEL` | Log level: `debug`, `info`, `notice`, `warning`, `error`. | `info` |

## Running the Server

### Local Development

```sh
bun run dev:stdio       # Dev mode (stdio, auto-reload)
bun run dev:http        # Dev mode (HTTP, auto-reload)
bun run test            # Run test suite
bun run devcheck        # Lint + format + typecheck + audit
```

### Production

```sh
bun run build
bun run start:stdio     # or start:http
```

### Docker

```sh
docker build -t hn-mcp-server .
docker run -p 3010:3010 hn-mcp-server
```

## Project Structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point. |
| `src/config/` | Server-specific env var parsing with Zod. |
| `src/services/hn/` | HN Firebase + Algolia API client and domain types. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- All tools are read-only — no auth scopes required

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
