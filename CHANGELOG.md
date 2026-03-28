# Changelog

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
