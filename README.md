<div align="center">
  <h1>@cyanheads/hn-mcp-server</h1>
  <p><b>Browse Hacker News feeds, threads, and user profiles with full-text search via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.17-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/hn-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/hn-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/hn-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun->=1.4.0-f9f1e1.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/hn-mcp-server/releases/latest/download/hn-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=hn-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaG4tbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22hn-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/hn-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://hn.caseyjhand.com/mcp](https://hn.caseyjhand.com/mcp)

</div>

---

## Overview

Feeds, threads, and profiles from the Hacker News Firebase API and Algolia Search API. Browse ranked feeds, read full comment threads, look up user profiles, and search stories, comments, polls, and jobs by keyword or by type, author, parent story, date, or score. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `hn_get_stories` | Fetch stories from an HN feed (top, new, best, ask, show, jobs), with title, URL, score, author, and comment count |
| `hn_get_thread` | Get an item and its comment tree as a threaded discussion, with depth and comment-count controls |
| `hn_get_user` | Fetch a user profile with karma, about, and optionally a page of resolved submissions |
| `hn_search_content` | Search stories, comments, polls, and jobs via Algolia by keyword, by filters alone, or both — type, author, parent story, date range, and minimum points |

## Capability reference

### `hn_get_stories` <sub>tool</sub>

- Six feed types: `top`, `new`, `best`, `ask`, `show`, `jobs`; `count` (1–100, default 30) and `offset` for pagination
- Returns id, type, title, url, domain, score, author, timestamp, comment count, and body text — each field omitted (not null) when HN doesn't provide it
- Enrichment reports `total`, `offset`, and `hasMore`; while more stories remain, `truncated` is set and `notice` names the next `offset`, and a `notice` explains empty pages (empty feed, offset past end, or every item on the page deleted/flagged). The last page carries no truncation

---

### `hn_get_thread` <sub>tool</sub>

- `itemId` plus `depth` (0–10, default 3; 0 returns the item with no comments) and `maxComments` (1–200, default 50) capping the total across all levels
- Breadth-first traversal ranked like HN — top-ranked top-level comments resolve first, replies fill in only after the level above is exhausted
- Flat comment list carries `depth`/`parentId` for tree reconstruction, plus `childCount` and an `isOp` flag when the comment author matches the root item's author
- `notice` reports deleted/dead comments omitted during traversal and, when `totalLoaded` is below `totalAvailable`, the hint to raise `maxComments`/`depth`; `truncated` is set only when `maxComments` stopped the traversal with comments left, not when a thread loads in full at exactly the cap

---

### `hn_get_user` <sub>tool</sub>

- `username` is case-sensitive and trimmed; `includeSubmissions` (default false) resolves recent submissions, with `submissionCount` (1–50, default 10) and `submissionOffset` paging through a long history
- Profile includes karma, creation date, and about text (HTML stripped); submissions filter out dead/deleted items
- Enrichment echoes `submissionOffset` and the offset to send next, or a notice when the requested offset is past the end of the history

---

### `hn_search_content` <sub>tool</sub>

- Free-text `query` plus `tags` (`story`/`comment`/`poll`/`job`/`ask_hn`/`show_hn`/`front_page`), `author`, `storyId`, `dateRange`, and `minPoints` filters; `sort` by relevance or date; `count` (1–50, default 30) and `page` for pagination
- `query` is optional when a filter is set — list Ask HN, Show HN, polls, or jobs on their own, or pass a story's `storyId` with `tags: "comment"` to search within one thread. No query and no filter fails with `missing_query_or_filter`
- `dateRange` bounds take ISO 8601 (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a date-time with optional offset), read as UTC and both exclusive; an empty or out-of-order range fails with `invalid_date_range`
- `minPoints` applies to stories and polls — comments and jobs carry no points, so pairing it with `tags: "comment"` or `"job"` fails with `min_points_unscored_type`
- `view: "compact"` drops the two body-text fields (`text`, `highlights.text`), which otherwise repeat a long comment twice per hit — pass a hit id to `hn_get_thread` to read the body
- Highlight metadata (`highlights.title`, `highlights.text`, `matchedWords`) shows which terms matched and where
- Enrichment reports `totalHits`, `page`, and the actual reachable `totalPages` — not derived from `totalHits`, since broad queries report far more hits than Algolia will serve. While more pages remain, `truncated` is set and `notice` names the next `page`; a page past the end gets a notice naming the last valid page (or `page: 0` past Algolia's 1,000-hit ceiling)

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

HN-specific:

- Two upstream APIs: HN's Firebase API for feeds, items, and users; Algolia's HN Search API for full-text search
- Concurrent batch fetching with configurable parallelism for item resolution (`HN_CONCURRENCY_LIMIT`)
- HTML entity decoding and tag stripping, preserving code blocks and links
- Server-level `instructions` forwarded to LLM clients on `initialize` — item types, ID reuse across tools, case-sensitive usernames, field sparsity
- No API keys required — both upstream APIs are public

Agent-friendly output:

- Graceful partial failure — `hn_get_thread` counts deleted and dead comments dropped during traversal and surfaces the count in `notice` rather than silently shrinking the result; `hn_get_stories` and `hn_get_user` filter dead/deleted items the same way
- Discriminated output contracts — typed error reasons (`item_not_found`, `upstream_rate_limited`, `upstream_html`, …) with per-reason recovery text, and a `depth`/`parentId` pair on every comment so callers reconstruct the tree without guessing nesting
- Pagination provenance — every paged tool echoes the offset it used (`offset`, `submissionOffset`, `page`) plus the exact next-offset value in `notice`, so an agent can resume a listing without recomputing state
- Response shaping — HTML stripping, URL normalization, and domain extraction remove upstream markup noise; `hn_search_content`'s `view: "compact"` drops the two body-text fields that otherwise duplicate a hit's full text

## Getting started

### Public Hosted Instance

A public instance is available at `https://hn.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "hn-mcp-server": {
      "type": "streamable-http",
      "url": "https://hn.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add to your MCP client configuration file:

```json
{
  "mcpServers": {
    "hn-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/hn-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "hn-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/hn-mcp-server"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "hn-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/hn-mcp-server:latest"
      ]
    }
  }
}
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js >= 24)

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
| `HN_CONCURRENCY_LIMIT` | Max concurrent HTTP requests for batch item fetches (integer, 1–50). | `10` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_HOST` | HTTP server host. | `localhost` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateful`, `stateless`, or `auto` (resolves to `stateful`). The server declares `stateless` in source, and the published Docker image and `.env.example` set it too; a meaningful env value still overrides. | `stateless` |
| `MCP_LOG_LEVEL` | Log level: `debug`, `info`, `notice`, `warning`, `error`. | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Dev mode (auto-reload):**

  ```sh
  MCP_TRANSPORT_TYPE=stdio bun --watch src/index.ts   # stdio
  MCP_TRANSPORT_TYPE=http bun --watch src/index.ts    # HTTP
  ```

- **Build and run:**

  ```sh
  bun run rebuild
  bun run start:stdio   # or start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  ```

### Docker

```sh
docker build -t hn-mcp-server .
docker run --rm -p 3010:3010 hn-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/hn-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits the HN service. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/services/hn/` | HN Firebase + Algolia API client and domain types. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- All tools are read-only — no auth scopes required
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
