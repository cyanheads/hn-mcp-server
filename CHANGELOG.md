# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.5.7](changelog/0.5.x/0.5.7.md) — 2026-05-30

enrichment adoption — ranked-feed and search tools surface result context (counts, query echo, empty-result guidance) in a typed enrichment block reaching both structuredContent JSON and content[] markdown trailer

## [0.5.6](changelog/0.5.x/0.5.6.md) — 2026-05-28

@cyanheads/mcp-ts-core ^0.9.6 → ^0.9.13: 413 body cap, HTTP session-init gate, quieter client-error logging, GET /mcp surfaces keywords; dep refresh; package.json keyword additions

## [0.5.5](changelog/0.5.x/0.5.5.md) — 2026-05-23

Fix duplicate `hono` installs causing `@hono/otel` crash on every HTTP request. `hono ^4.12.22` added as direct dependency to force deduplication.

## [0.5.4](changelog/0.5.x/0.5.4.md) — 2026-05-23

Maintenance. `@cyanheads/mcp-ts-core ^0.9.1 → ^0.9.6`, `zod` added as explicit dependency. `manifest.json` + `.mcpbignore` scaffolded for MCPB bundle support. Install badges added to README. New scripts: `list-skills`, `lint:packaging`, `bundle`, `audit:refresh`.

## [0.5.3](changelog/0.5.x/0.5.3.md) — 2026-05-21

Field-test refinements to two `format()` output paths. `hn_get_stories` now distinguishes offset-past-end from genuinely-empty feeds. `hn_get_user` no longer duplicates the item type when rendering a typeless submission. Also migrates the project to the framework's directory-based changelog convention.

## [0.5.2](changelog/0.5.x/0.5.2.md) — 2026-05-16

Maintenance + capability release. Adopts the MCP spec server-level `instructions` field on `createApp()` so clients forward orientation text (item types, ID reuse, case-sensitive usernames, sparsity) to the model. Framework `^0.8.20 → ^0.9.1` brings Workers `nodejs_compat` fix, SSRF hardening, gated `tasks` capability, build-time-only lint.

## [0.5.1](changelog/0.5.x/0.5.1.md) — 2026-05-11

`hn_get_thread` schema patch: `comments[].isOp` and `omitted` are now absence-by-default. `isOp` changed `z.boolean()` → `z.literal(true).optional()`; `omitted` made optional. Wire payload shrinks on the common case (no OP reply, no moderation truncation); `format()` output unchanged.

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-05-11

Enrichment release. Four new fields: `domain` on stories/search hits (hostname extracted from `url`), `highlights` on search hits (Algolia `_highlightResult` with `<em>…</em>` preserved), `isOp` on thread comments (author equals root item author), `omitted: { deleted, dead }` counters on threads. Closes #1, #2, #3, #4.

## [0.4.3](changelog/0.4.x/0.4.3.md) — 2026-05-11 · 🛡️ Security

Maintenance. Framework `^0.8.17 → ^0.8.20` (bundles `hono` security patches GHSA-p77w-8qqv-26rm / GHSA-qp7p-654g-cw7p / GHSA-hm8q-7f3q-5f36). Engine bumps `bun >=1.3` / `node >=24`, Dockerfile base `oven/bun:1.3`. `@hono/otel` + `pino-pretty` moved to devDependencies. New `api-telemetry` skill.

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-05-05

Bundles two releases. (1) `hn_search_content` `dateRange` rejects unparseable dates via Zod `.refine()`. (2) Framework `^0.7.0 → ^0.8.17` brings the typed-error-contract API; adopted contracts on `hn_get_thread` (`item_not_found`) and `hn_get_user` (`user_not_found`); search empty-result message names applied filters.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-04-24

Framework `^0.5.3 → ^0.7.0` (20 releases). `.describe()` now required recursively on array-element schemas — added to `stories[]`, `comments[]`, `submissions[]`, `hits[]`. New skills `api-linter`, `release-and-publish`, `security-pass`. `.github/ISSUE_TEMPLATE/` scaffolded.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-04-20

Framework `^0.4.1 → ^0.5.3` adopts the `format-parity` lint rule. `format()` output expanded across all four tools: meta lines lead with `id:N`, dual ISO + Unix timestamps, comment depth/parent annotations, indent capped at 10 levels.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-04-19

Upstream resilience. `withRetry` + `fetchWithTimeout` wrap HN Firebase + Algolia fetches with 10s per-request timeout, HTML-error-body detection (for rate-limited 200 OK responses), and `ctx.signal` cancellation. `hn_get_stories` schema fields made optional to preserve upstream sparsity. Framework `^0.2.10 → ^0.4.1`.

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-03-30

Framework `^0.2.7 → ^0.2.10`. Biome patch. Skill refreshes — `add-tool` v1.1 (tool response design), `add-resource` v1.1 (tool coverage guidance), `design-mcp-server` v2.1 (live API probing, batch input design, resilience planning).

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-03-28

Framework patch `^0.2.6 → ^0.2.7`.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-03-28

Framework patch `^0.2.4 → ^0.2.6`.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-03-28 · 🛡️ Security

Framework `^0.1.28 → ^0.2.4`. `format()` output overhauled across all tools (markdown headers, IDs, dates, actionable hints). Security overrides for `path-to-regexp`, `picomatch`, `brace-expansion`. New `report-issue-framework` / `report-issue-local` skills.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-03-23 · ⚠️ Breaking

Tool rename pass: all four tools gain `hn_` namespace prefix (`get_stories` → `hn_get_stories`, `get_thread` → `hn_get_thread`, `get_user` → `hn_get_user`, `search_hn` → `hn_search_content`). Breaking for any caller using the unprefixed names.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-03-23

TypeScript major `^5.9.3 → ^6.0.2`. Framework `^0.1.25 → ^0.1.28`. Vitest patch. `remotes` entry on `server.json` with public streamable-http URL. `tsconfig.json` simplified (relative path alias).

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-03-21

Framework patch `^0.1.23 → ^0.1.25`.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-03-21

Framework patch `^0.1.23 → ^0.1.24`. Publishing instructions added to CLAUDE.md.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-03-21

Renamed package to scoped `@cyanheads/hn-mcp-server`. Conditional OpenTelemetry install via `OTEL_ENABLED` Docker build arg. Framework `^0.1.22 → ^0.1.23`.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-03-21

Initial release. Four read-only tools (`hn_get_stories`, `hn_get_thread`, `hn_get_user`, `hn_search_content`) over HN Firebase + Algolia. Concurrency-limited batch fetching, HTML stripping with code-block/link preservation, stdio + streamable-http transports.
