# Changelog

## [0.3.0] — 2026-04-20

### Changed

- Bumped `@cyanheads/mcp-ts-core` from `^0.4.1` to `^0.5.3`. The 0.5.x release adds a `format-parity` lint rule that verifies every field in a tool's `output` schema is rendered by its `format()` function — catching silent divergence between `structuredContent` (forwarded by clients like Claude Code) and `content[]` (forwarded by clients like Claude Desktop).
- `hn_get_stories` `format()`: meta line now leads with `id:N | type | …` and renders `time` as both ISO date and raw Unix timestamp (`2026-04-20 (t:1776717572)`); header includes raw `offset:N`.
- `hn_get_thread` `format()`: comment lines now include `depth:N | parent:N` annotations; visual indent is capped at 10 levels so a synthetic deep depth doesn't OOM `String.repeat`; root meta includes `type:N`; comment timestamps render with both formatted date and raw value; summary is always rendered (previously suppressed when fully loaded).
- `hn_get_user` `format()`: `created` and submission `time` now render with both formatted date and raw Unix timestamp.
- `hn_search_content` `format()`: header includes raw `p:N`; `createdAt` now renders the full ISO string (was truncated to date); comment results carry the parent story id in the heading; story results suppress the redundant self-referential parent ref.
- Dropped redundant `async` modifier on `HnService.fetchItem`/`fetchUser`/`fetchFeed` — they delegate directly to `withRetry()` and gain nothing from the wrapper.
- Synced project skills from `mcp-ts-core@0.5.3`: updated `add-tool` (1.4 → 1.6), `api-config` (1.1 → 1.2), `design-mcp-server` (2.3 → 2.4), `field-test` (1.1 → 1.2), `maintenance` (1.2 → 1.3), `polish-docs-meta` (1.3 → 1.4), `setup` (1.2 → 1.3).
- Bumped MCP SDK badge in `README.md` to `^1.29.0` and TypeScript badge to `^6.0.3`.

## [0.2.0] — 2026-04-19

### Added

- Upstream resilience for HN Firebase and Algolia calls: `withRetry` + `fetchWithTimeout` wrap the full fetch-and-parse pipeline in `HnService`, with a 10-second per-request timeout, HTML-error-body detection (for rate-limited responses served as 200 OK), and `ctx.signal` wired through for cancellation.
- Sparse-upstream test fixtures for `hn_get_stories` covering omitted `score`/`by`/`time`/`title` fields and verifying `format()` does not fabricate meta.
- `add-app-tool` skill (v1.2) for scaffolding MCP App tool + UI resource pairs.

### Changed

- Bumped `@cyanheads/mcp-ts-core` from `^0.2.10` to `^0.4.1`.
- Bumped `@biomejs/biome` (2.4.10 → 2.4.12), `@types/node` (25.5.0 → 25.6.0), `typescript` (6.0.2 → 6.0.3), `vitest` (4.1.2 → 4.1.4).
- Dropped the `overrides` block (`path-to-regexp`, `picomatch`, `brace-expansion`) — fresh resolution picks up clean transitive versions and `bun audit` now reports zero vulnerabilities.
- `HnService` methods (`fetchItem`, `fetchUser`, `fetchFeed`, `fetchItems`, `search`) now accept `ctx: Context` for correlated logs and cancellation; added a local `toRequestContext()` adapter to reconcile `exactOptionalPropertyTypes` differences between `Context` and `RequestContext`.
- `hn_get_stories` output schema: `title`, `score`, `by`, and `time` are now optional. The handler uses conditional spreads so upstream absence is preserved instead of being fabricated into `''`, `0`, or epoch zero. `format()` falls back to `[type]` when the title is unknown and omits meta segments that would otherwise render as blank.
- `hn_get_thread` and `hn_get_user` now throw `notFound()` for missing items/users instead of plain `Error`, giving the LLM a classified error code.
- Algolia HTTP error paths now surface as `ServiceUnavailable` via `fetchWithTimeout` + retry instead of raw `Error`.
- Synced project skills from `mcp-ts-core@0.4.1`: updated `add-prompt`, `add-resource`, `add-service`, `add-test`, `add-tool`, `api-testing`, `api-workers`, `design-mcp-server`, `devcheck`, `field-test`, `maintenance`, `migrate-mcp-ts-template`, `polish-docs-meta`, `setup`.

### Fixed

- Per-item failures inside batch `fetchItems` calls are now tolerated (logged and nulled) rather than bubbling up and failing the whole feed after retries exhaust.

## [0.1.9] — 2026-03-30

### Changed

- Bumped `@cyanheads/mcp-ts-core` from `^0.2.7` to `^0.2.10`
- Bumped `@biomejs/biome` from `^2.4.9` to `^2.4.10`
- Updated author field and added funding metadata in `package.json`
- Updated `add-tool` skill (v1.1): expanded tool response design guidance — partial success, batch input, format function content-completeness, error classification
- Updated `add-resource` skill (v1.1): added tool coverage guidance for resource definitions
- Updated `design-mcp-server` skill (v2.1): live API probing, tool-first design philosophy, batch input design, error design patterns, resilience planning, naming conventions

### Fixed

- Formatting fix in `get-thread.tool.test.ts` assertion

## [0.1.8] — 2026-03-28

### Changed

- Bumped `@cyanheads/mcp-ts-core` from `^0.2.6` to `^0.2.7`

## [0.1.7] — 2026-03-28

### Changed

- Bumped `@cyanheads/mcp-ts-core` from `^0.2.4` to `^0.2.6`

## [0.1.6] — 2026-03-28

### Changed

- Bumped `@cyanheads/mcp-ts-core` from `^0.1.28` to `^0.2.4`
- Bumped `@biomejs/biome` from `^2.4.8` to `^2.4.9`
- Bumped `vitest` from `^4.1.1` to `^4.1.2`
- Added `overrides` for `path-to-regexp`, `picomatch`, and `brace-expansion` (security patches)
- Improved `format()` output across all 4 tools: markdown headers, item IDs, dates, full text rendering, and actionable hints
- Updated test assertions to match new format output

### Added

- `report-issue-framework` skill for filing bugs against `@cyanheads/mcp-ts-core`
- `report-issue-local` skill for filing bugs against this server
- `LOGS_DIR` env var documented in README
- GitHub repo metadata sync step in `polish-docs-meta` skill
- Description propagation rule (package.json → README → server.json → Dockerfile)

## [0.1.5] — 2026-03-23

### Changed

- Renamed all tools with `hn_` prefix for namespacing: `get_stories` → `hn_get_stories`, `get_thread` → `hn_get_thread`, `get_user` → `hn_get_user`, `search_hn` → `hn_search_content`
- Renamed `search-hn.tool.ts` → `search-content.tool.ts` (and corresponding test) to match new tool name
- Updated cross-reference descriptions in tool schemas to use new prefixed names
- Updated README, CLAUDE.md, and test suites with new tool names

## [0.1.4] — 2026-03-23

### Changed

- Bumped `@cyanheads/mcp-ts-core` from `^0.1.25` to `^0.1.28`
- Bumped `typescript` from `^5.9.3` to `^6.0.2`
- Bumped `vitest` from `^4.1.0` to `^4.1.1`
- Added `remotes` entry to `server.json` with public streamable-http URL
- Simplified `tsconfig.json`: removed `baseUrl`, updated path alias to relative form

## [0.1.3] — 2026-03-21

### Changed

- Bumped `@cyanheads/mcp-ts-core` from `^0.1.23` to `^0.1.25`
- Added publishing instructions to `CLAUDE.md` agent protocol

## [0.1.2] — 2026-03-21

### Changed

- Bumped `@cyanheads/mcp-ts-core` from `^0.1.23` to `^0.1.24`
- Added publishing instructions to `CLAUDE.md` agent protocol

## [0.1.1] — 2026-03-21

### Changed

- Renamed package from `hn-mcp-server` to `@cyanheads/hn-mcp-server` (scoped npm package)
- Bumped `@cyanheads/mcp-ts-core` from `^0.1.22` to `^0.1.23`
- Added `@hono/otel` dependency for OpenTelemetry integration
- Dockerfile now conditionally installs OpenTelemetry peer dependencies via `OTEL_ENABLED` build arg (defaults to true)
- Updated `server.json` npm identifiers to scoped package name
- Updated README install commands to use scoped package name

## [0.1.0] — 2026-03-21

Initial release.

### Added

- **Tools:** `get_stories`, `get_thread`, `get_user`, `search_hn` — 4 read-only tools covering HN feeds, threaded discussions, user profiles, and full-text search
- **Service layer:** HN Firebase API client with concurrency-limited batch fetching, Algolia search client with filtering and pagination
- **HTML processing:** Entity decoding, tag stripping with code block and link preservation
- **Transports:** stdio and streamable-http via `@cyanheads/mcp-ts-core`
- **Configuration:** `HN_CONCURRENCY_LIMIT` env var for tuning batch fetch parallelism
- **Tests:** Comprehensive test suite covering all tools, service layer, and server config
- **Docs:** README with full tool documentation, design document, HN API reference, project structure tree
- **Infra:** Dockerfile, biome config, vitest config, devcheck config, server.json metadata, LICENSE (Apache-2.0), bunfig.toml

### Fixed

- `search_hn` totalPages calculation now uses `Math.ceil(nbHits / count)` instead of Algolia's `nbPages` (which reflects Algolia's own page size, not the requested count)

### Changed

- Updated `server.json` name to reverse-DNS format (`io.github.cyanheads/hn-mcp-server`), added `HN_CONCURRENCY_LIMIT` env var, set `runtimeHint` to `bun`
- Expanded `package.json` with `mcpName`, `homepage`, `bugs`, `author`, `packageManager`, and HN-specific keywords
- Added OCI image description and source labels to Dockerfile
- Customized `CLAUDE.md` agent protocol with HN-specific patterns, examples, and structure
