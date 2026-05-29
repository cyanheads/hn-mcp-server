# Agent Protocol

**Server:** hn-mcp-server
**Version:** 0.5.6
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getHnService, filterLiveItems, normalizeUrl, stripHtml } from '@/services/hn/hn-service.js';

export const getStories = tool('hn_get_stories', {
  description: 'Fetch stories from an HN feed (top, new, best, ask, show, jobs).',
  annotations: { readOnlyHint: true },
  input: z.object({
    feed: z.enum(['top', 'new', 'best', 'ask', 'show', 'jobs']).describe('Which HN feed to fetch.'),
    count: z.number().min(1).max(100).default(30).describe('Number of stories to return.'),
    offset: z.number().min(0).default(0).describe('Number of stories to skip for pagination.'),
  }),
  output: z.object({
    stories: z.array(z.object({
      id: z.number().describe('Item ID.'),
      title: z.string().describe('Story title.'),
      // ...
    })).describe('Stories from the feed.'),
    feed: z.string().describe('Which feed was fetched.'),
    total: z.number().describe('Total items in the feed.'),
  }),

  async handler(input, ctx) {
    const hn = getHnService();
    const feedIds = await hn.fetchFeed(input.feed);
    const sliced = feedIds.slice(input.offset, input.offset + input.count);
    const items = filterLiveItems(await hn.fetchItems(sliced));
    ctx.log.info('Fetched stories', { feed: input.feed, count: items.length });
    return { stories: items.map(/* ... */), feed: input.feed, total: feedIds.length };
  },

  // format() populates MCP content[] — the ONLY field most LLM clients forward to the model.
  // structuredContent (from output) is for programmatic use. Make format() content-complete.
  format: (result) => {
    const lines = result.stories.map((s) => {
      const meta = [`${s.score} pts`, `by ${s.by}`, `id:${s.id}`].join(' | ');
      return `### ${s.title}\n${meta}${s.url ? `\n${s.url}` : ''}`;
    });
    return [{ type: 'text', text: `## ${result.feed} stories\n\n${lines.join('\n\n')}` }];
  },
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
const ServerConfigSchema = z.object({
  concurrencyLimit: z.coerce.number().min(1).max(50).default(10)
    .describe('Max concurrent HTTP requests for batch item fetches.'),
});
let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= ServerConfigSchema.parse({
    concurrencyLimit: process.env.HN_CONCURRENCY_LIMIT,
  });
  return _config;
}
```

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.sample` | Request LLM completion from the client. **Check for presence first:** `if (ctx.sample) { ... }` |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'item_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'HN reports no item exists for the given itemId.',
    recovery: 'Verify the itemId via hn_search_content or hn_get_stories.' },
],
async handler(input, ctx) {
  const root = await hn.fetchItem(input.itemId, ctx);
  if (!root) {
    throw ctx.fail('item_not_found', `Item ${input.itemId} not found`, {
      itemId: input.itemId,
      ...ctx.recoveryFor('item_not_found'),
    });
  }
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

**Service-layer:** services don't have `ctx.fail`, but can carry the contract reason via `data: { reason: 'X' }` on a factory throw. The auto-classifier preserves `data` on the wire so clients see the same `error.data.reason` they'd see from `ctx.fail`. See framework CLAUDE.md and `api-errors` skill for the full auto-classification table and all factories.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # Server-specific env vars (Zod schema)
  services/
    hn/
      hn-service.ts                     # HN Firebase + Algolia API client
      types.ts                          # HN domain types
  mcp-server/
    tools/definitions/
      get-stories.tool.ts              # hn_get_stories — Fetch stories from an HN feed
      get-thread.tool.ts               # hn_get_thread — Get item + comment tree
      get-user.tool.ts                 # hn_get_user — Fetch user profile + submissions
      search-content.tool.ts           # hn_search_content — Search via Algolia
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case with `hn_` prefix | `hn_search_content` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + UI resource pair (interactive HTML UI) |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Post-wrapup ship workflow: verification gate, push, publish to npm/MCP Registry/GHCR |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run list-skills` | Print skills index from project `skills/` |
| `bun run lint:mcp` | Validate MCP tool/resource definitions |
| `bun run lint:packaging` | Validate env-var alignment between `manifest.json` and `server.json` |
| `bun run bundle` | Build and pack as `.mcpb` for Claude Desktop install |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit (clears stale lockfile false positives) |
| `bun run test` | Run tests |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getHnService } from '@/services/hn/hn-service.js';
```

---

## Publishing

Run the `release-and-publish` skill — it runs the verification gate (`devcheck`, `rebuild`, `test`), pushes commits and tags, and publishes to every applicable destination. The full reference:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/hn-mcp-server:<version> \
  -t ghcr.io/cyanheads/hn-mcp-server:latest \
  --push .

mcp-publisher publish
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging — no `console` calls
- [ ] Handlers throw on failure — `ctx.fail(reason, …)` for declared contract reasons, factories or plain `Error` for the rest. No try/catch.
- [ ] Domain failure modes declared in `errors[]` with `recovery` strings (≥5 words, lint-validated); `ctx.recoveryFor('reason')` spread into throw `data` to mirror onto the wire
- [ ] Service-layer throws carry `data: { reason, recovery: { hint } }` so format()-only clients see the recovery hint
- [ ] Wrapping HN/Algolia: schemas reflect real upstream sparsity (HN omits fields freely); `format()` preserves uncertainty rather than fabricating from missing data
- [ ] Tests cover at least one sparse payload case per tool that wraps upstream items
- [ ] Tests use `createMockContext({ errors: tool.errors })` when the test exercises `ctx.fail`
- [ ] Registered in `createApp()` tools array
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
