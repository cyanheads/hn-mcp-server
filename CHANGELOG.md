# Changelog

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
