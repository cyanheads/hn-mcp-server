# hn-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `hn_get_stories` | Fetch stories from an HN feed (top, new, best, ask, show, jobs). Returns enriched story objects with title, URL, score, author, and comment count. | `feed` (enum), `count`, `offset` | `readOnlyHint` |
| `hn_get_thread` | Get an item and its comment tree as a threaded discussion. Resolves child comments by ranked breadth-first traversal. With depth 0, returns just the item — doubles as an item lookup. | `itemId`, `depth`, `maxComments` | `readOnlyHint` |
| `hn_get_user` | Get an HN user profile with karma, about, and optionally one page of their submissions resolved into full items. | `username`, `includeSubmissions`, `submissionCount`, `submissionOffset` | `readOnlyHint` |
| `hn_search_content` | Search Hacker News stories, comments, polls, and jobs via Algolia — by keyword, by filters alone, or both. Supports filtering by content type, author, parent story, date range, and minimum points. | `query`, `tags`, `author`, `storyId`, `sort`, `dateRange`, `minPoints`, `count`, `page`, `view` | `readOnlyHint` |

### Resources

None. Item and user lookups are handled by `hn_get_thread` (depth 0) and `hn_get_user` respectively — both add value over raw API responses by resolving nested IDs.

### Prompts

None. Data-oriented server with no recurring interaction patterns that benefit from structured prompt templates.

---

## Overview

MCP server wrapping the [Hacker News API](https://github.com/HackerNews/API) (Firebase) and [HN Search API](https://hn.algolia.com/api) (Algolia). Gives LLM agents the ability to browse HN feeds, read threaded discussions, search for topics, and look up users and items — all read-only.

The server's primary value-add over raw API calls:

1. **Batch resolution** — feeds return ID arrays; the server fetches and enriches them into complete story objects in one tool call
2. **Thread traversal** — comment trees require recursive `kids` resolution; the server walks the tree and returns a structured, readable discussion
3. **User enrichment** — user profiles include submission IDs only; the server optionally resolves a page of submissions into full items
4. **Unified search** — wraps Algolia's HN search with a clean interface for finding discussions by topic

## Requirements

- Read-only access to all public HN data (stories, comments, jobs, polls, users, feeds)
- Full-text search across stories and comments via Algolia
- Threaded comment tree resolution with configurable depth/size limits
- Concurrent batch fetching with configurable concurrency limits
- No authentication required (both APIs are public)
- No rate limit documented for HN Firebase API; Algolia has standard rate limits

---

## Conventions used below

Every tool splits its response across three surfaces:

- **Output** — the tool's `output` schema, returned as `structuredContent` and rendered into `content[]` by `format()`.
- **Enrichment** — the `enrichment` block: pagination totals, truncation flags, and agent-facing notices. Reaches both surfaces, keyed separately from the data.
- **Errors** — the `errors[]` contract: the `reason` values a caller can switch on, each with a recovery hint.

Fields marked optional are absent (not null) when HN omits them — the APIs populate fields sparsely.

---

## Tool Details

### `hn_get_stories`

Browse curated HN feeds. Fetches the feed's ID array, slices by offset/count, then batch-fetches each item in parallel.

**Input**

| Field | Type | Default | Notes |
|:------|:-----|:--------|:------|
| `feed` | enum `top \| new \| best \| ask \| show \| jobs` | — | Required. `top` includes jobs. |
| `count` | integer 1–100 | `30` | Larger counts take longer — each item is a separate fetch. |
| `offset` | integer ≥ 0 | `0` | Items to skip from the start of the feed. |

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `stories[].id` | number | Item ID — chains to `hn_get_thread`. |
| `stories[].type` | string | `story` or `job`. |
| `stories[].title` | string? | |
| `stories[].url` | string? | Absent for Ask HN / text posts. |
| `stories[].domain` | string? | Bare hostname from `url`, leading `www.` stripped. |
| `stories[].score` | number? | |
| `stories[].by` | string? | |
| `stories[].time` | number? | Unix seconds. |
| `stories[].descendants` | number? | Total comment count. Absent for jobs. |
| `stories[].text` | string? | Body text for Ask HN / text posts. |
| `feed` | string | Which feed was fetched. |

**Enrichment**: `total`, `offset`, `hasMore`, plus `truncated` / `shown` / `cap` only while more stories remain (`hasMore`), with a `notice` naming the next `offset` and, below the 100 maximum, suggesting a larger `count`. The last page carries none of them. An empty page gets a `notice` saying why (empty feed, offset past the end, or every item on the page dead/deleted).

**Errors**: `upstream_rejected`, `upstream_rate_limited`, `upstream_unavailable`, `upstream_html`, `upstream_malformed`.

### `hn_get_thread`

The highest-value tool. Fetches an item and resolves its comment tree, handling traversal that would otherwise require dozens of sequential item fetches. Returns a flat comment list ordered by ranked BFS — at each level, comments appear in HN's ranked order before descending to the next depth. On wide threads (many direct replies), this favors breadth over depth; callers raise `maxComments` alongside `depth`, or call again with a specific comment's `itemId` to drill into a subtree.

**Input**

| Field | Type | Default | Notes |
|:------|:-----|:--------|:------|
| `itemId` | integer | — | Required. Story, comment, job, or poll. |
| `depth` | integer 0–10 | `3` | `0` = item only, no comments. |
| `maxComments` | integer 1–200 | `50` | Total across all depth levels. |

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `item` | object | `id`, `type`, and optional `by`, `time`, `title`, `url`, `text`, `score`, `descendants`. |
| `comments[].id` | number | |
| `comments[].by` | string? | |
| `comments[].time` | number? | |
| `comments[].text` | string? | HTML stripped. |
| `comments[].depth` | number | `0` = direct reply to root. |
| `comments[].parentId` | number | |
| `comments[].childCount` | number | Direct children — may exceed what was resolved. |
| `comments[].isOp` | `true`? | Present only when the comment author matches the root author. |

**Enrichment**: `totalLoaded`, `totalAvailable` (only when HN reports `descendants` — comment and job roots omit it), `truncated` / `shown` / `cap` when `maxComments` stopped the traversal with comments left (not when `totalLoaded` has reached `totalAvailable`; kept whenever the cap is hit and `totalAvailable` is absent), and `notice` carrying dropped deleted/dead counts plus either how to get past the cap (a larger `maxComments`, or a comment id as `itemId` for its subtree) or a raise-`maxComments`-or-`depth` hint.

**Errors**: `item_not_found`, plus the five upstream reasons.

### `hn_get_user`

Fetches an HN user profile and optionally resolves one page of their submissions into full items. Without `includeSubmissions`, returns just the profile. `submissionOffset` moves the page window, so a prolific account's older history stays reachable rather than being capped at the first `submissionCount` IDs.

**Input**

| Field | Type | Default | Notes |
|:------|:-----|:--------|:------|
| `username` | string | — | Required, trimmed, case-sensitive. |
| `includeSubmissions` | boolean | `false` | |
| `submissionCount` | integer 1–50 | `10` | Page size. |
| `submissionOffset` | integer ≥ 0 | `0` | Submissions to skip, counting back from the most recent. Unbounded — a 15k-submission history is walkable. |

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `user.id` | string | |
| `user.karma` | number | |
| `user.created` | number | Unix seconds. |
| `user.about` | string? | HTML stripped. |
| `user.totalSubmissions` | number | Full history length, not the page size. |
| `submissions[]` | array? | `id`, `type`, and optional `title`, `url`, `text`, `score`, `time`, `descendants`. Absent when `includeSubmissions` is false or the user has never submitted; empty when the window holds no live items. |

**Enrichment**: `submissionOffset` echoes the applied offset; `notice` names the window and the next offset while more remain, or reports the valid range when the offset is past the end; `truncated` / `shown` / `cap` fire only when submissions remain beyond the page.

**Errors**: `user_not_found`, plus the five upstream reasons.

### `hn_search_content`

Wraps Algolia's HN Search API. Supports relevance-sorted and date-sorted search with tag and numeric filters, by keyword, by filters alone, or both.

**Input**

| Field | Type | Default | Notes |
|:------|:-----|:--------|:------|
| `query` | string? | — | Trimmed; a supplied blank is rejected at the schema. Omit for a filter-only search, which needs at least one of `tags`, `author`, `storyId`, `minPoints`, or a `dateRange` bound — `sort`, `count`, `page`, and `view` don't count. Algolia handles stemming and relevance. |
| `tags` | enum `story \| comment \| poll \| job \| ask_hn \| show_hn \| front_page` | — | Single tag. Omit to search all types. `pollopt` is left out: Algolia's poll-option records carry no text and no parent poll. |
| `author` | string | — | Omit rather than passing a blank string. |
| `storyId` | positive integer | — | Sent as a `story_<id>` tag, ANDed with the other tags. Takes a story or poll root id (`hits[].storyId` or the `hn_get_thread` root); a comment id matches nothing. |
| `sort` | enum `relevance \| date` | `relevance` | |
| `dateRange` | `{ start?, end? }` | — | ISO 8601 bounds (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or `YYYY-MM-DDThh:mm[:ss[.sss]]` with optional `Z` / `±hh:mm`), advertised as a `pattern`; calendar-invalid values are rejected at the schema. Converted to `created_at_i>start` and `created_at_i<end`, so both bounds are exclusive; date-only and offset-less values read as UTC. At least one bound, and `start` before `end`. |
| `minPoints` | integer ≥ 0 | — | Stories and polls only — Algolia stores `points: null` on comments and jobs, so any `points>=N` filter drops them. Rejected with `tags: "comment"` or `"job"`. |
| `count` | integer 1–50 | `30` | |
| `page` | integer ≥ 0 | `0` | |
| `view` | enum `full \| compact` | `full` | `compact` omits `text` and `highlights.text`. |

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `hits[].id` | number | HN item ID — chains to `hn_get_thread`. |
| `hits[].title` | string? | Present for stories. |
| `hits[].url` | string? | |
| `hits[].domain` | string? | Bare hostname from `url`. |
| `hits[].author` | string | |
| `hits[].points` | number? | |
| `hits[].numComments` | number? | |
| `hits[].createdAt` | string | ISO 8601. |
| `hits[].storyTitle` | string? | Parent story title for comment hits. |
| `hits[].storyId` | number? | Equals `id` for story hits. |
| `hits[].text` | string? | Body text, HTML stripped. Always absent under `view: "compact"`. |
| `hits[].highlights` | object? | `title`, `text` (both `<em>`-marked snippets), and `matchedWords`. `text` is always absent under `view: "compact"`. |
| `query` | string? | The query that was searched. Absent for a filter-only search. |

**Enrichment**: `totalHits`, `page`, `totalPages`, plus `truncated` / `shown` / `cap` only while more pages remain (`page + 1 < totalPages`), with a `notice` naming the next `page` and, below the 50 maximum, suggesting a larger `count`. The last page Algolia serves carries none of them. An empty page gets a `notice`: past the end it names the last valid page (`totalPages - 1`), or `page: 0` when that is unknown; an empty first page names the filters to relax, and the `storyId` source when one was set.

Algolia serves at most 1,000 hits per search, and `nbPages` already reflects that ceiling. Below it, an out-of-range page keeps the real `nbHits` / `nbPages` with zero hits; past it, Algolia answers `nbHits: 0`, `nbPages: 0`, which is why the last valid page can be unknown.

**Errors**: `missing_query_or_filter` (no query and no filter), `invalid_date_range` (a `dateRange` with no bound, or `start` not before `end`), `min_points_unscored_type` (`minPoints` with `tags: "comment"` or `"job"`), plus the five upstream reasons. The three input checks run in the handler, before any upstream call, so each carries its declared reason and recovery hint; a schema refinement would surface only as `invalid_arguments`. Only an omitted `query` enables a filter-only search: a supplied blank still fails at the schema, following the rule that a supplied-but-empty value is rejected rather than read as omitted. A bare `dateRange: {}` fails as `invalid_date_range`, not `missing_query_or_filter`.

#### Result projection

Algolia's `_highlightResult` repeats the matched field's full value with `<em>` markers, so a long comment can arrive twice per hit — once as `text`, once as `highlights.text`. `view: "compact"` drops that pair and keeps everything else, including `matchedWords`, so a caller can scan many results and then pass a hit `id` to `hn_get_thread` for the body.

The projection is applied to the hit before either output surface is built, so `structuredContent` and `content[]` stay equivalent by construction — compact is an explicit projection, not a render-time truncation. `full` remains the default so existing callers are unaffected.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `hn` | HN Firebase API + Algolia Search API | All tools |

Single service (`HnService`) with two internal API clients:

- **Firebase client** — `fetchItem(id, ctx)`, `fetchUser(username, ctx)`, `fetchFeed(type, ctx)`, plus `fetchItems(ids, ctx)` for concurrency-limited batches
- **Algolia client** — `search(params, ctx)` mapping to the Algolia `search` / `search_by_date` endpoints

Both are simple HTTP GET interfaces with no auth, no connection state, and JSON responses. One service directory keeps it cohesive.

### Batch Fetching

The Firebase API has no batch endpoint — each item is a separate HTTP GET. The service layer provides:

- `fetchItems(ids)` — parallel fetch with a configurable concurrency limit (default 10), preserving input order
- Per-item failures after exhausted retries are logged and yield `null` so one bad item does not fail the batch — callers filter

This is the performance-critical path. `hn_get_stories` fetching 30 items and `hn_get_thread` fetching 50+ comments both depend on efficient batching.

## Conventions

### HTML Handling

The HN API returns HTML in `title`, `text`, and `about` fields. Raw HTML is noisy for LLM consumption. The service layer strips HTML to plain text before returning data:

- `<p>` tags → double newline
- `<a href="...">` → preserve URL in parentheses
- `<pre><code>` → preserve as-is (code blocks)
- All other tags → strip, keep content
- Named and numeric HTML entities → decoded

This applies uniformly across all tools. No raw HTML reaches tool output.

Algolia highlight snippets are the one exception: `stripHtmlPreservingEm` runs the same strip but keeps the `<em>…</em>` markers that carry which terms matched.

### Dead and Deleted Items

The API returns `dead: true` and `deleted: true` on items. Policy:

- **Deleted items** — omit entirely. They have no useful content (fields are stripped by HN).
- **Dead items** — omit by default. Dead items are flagged/killed by mods or filters; including them adds noise. If a future use case warrants it, add a `showDead` flag.

Null results from batch fetches (item genuinely missing or API error) are also silently filtered.

Pagination advances by the requested window, not by the live-item count — otherwise a window full of dead items would be re-fetched forever.

### Upstream Failures

Every upstream failure reaches the client as a classified error carrying `data.reason` and `data.recovery.hint`, so a `content[]`-only client gets an actionable next move instead of a plumbing string. The service maps the failure onto five reasons, each declared in every tool's `errors[]` contract:

| Reason | Fires on | JSON-RPC code |
|:-------|:---------|:--------------|
| `upstream_rejected` | 4xx other than 429 — the request was rejected and the same input fails again | `InvalidParams` |
| `upstream_rate_limited` | 429 | `RateLimited` |
| `upstream_unavailable` | 5xx | `ServiceUnavailable` |
| `upstream_html` | HTML error page served with a 200 status | `ServiceUnavailable` |
| `upstream_malformed` | 200 status with a body that is not JSON | `ServiceUnavailable` |

The last two are 200-status failures that would otherwise reach the client as a raw `SyntaxError` from `JSON.parse`, whose message names the token it choked on — upstream body content.

The code travels with the reason rather than with the HTTP status. The framework's finer status ladder would split one reason across several codes — HN answers an unknown path with 401, and a 500 or 504 would surface as `InternalError` or `Timeout`, blurring the codes that mean "this server broke" and "this server's own fetch timed out". The exact status stays on `data.status`.

The HTTP-status wrapper sits *outside* `withRetry`, not inside it: retry eligibility, `Retry-After` honoring, timeouts, and caller aborts all classify against the framework's original error, and only `errorSource: 'FetchHttpError'` throws are rewritten. The upstream URL and the verbatim response body are dropped from the client-facing message and data, and kept on the `cause` chain for server-side logs.

### URL Normalization

The API occasionally returns empty strings for `url` (e.g., job posts). Normalize `""` to `undefined` so optional URL fields are consistently absent-or-present, never empty.

### Formatting

Each tool provides a `format` function that shapes output for LLM readability:

- `hn_get_stories` — ranked list: rank, title, domain, id/type/score/author/comment count/date, URL, body text
- `hn_get_thread` — root item summary, then the comment list indented by depth, with author, id/depth/parent/reply count/date, and an OP marker
- `hn_get_user` — profile summary, then a submission list with id, type, score, comment count, date, URL, and body text
- `hn_search_content` — a heading quoting the query (or marking a filter-only search), then per-hit heading (story title + domain, or the parent story for comment hits), metadata line, URL, body text, and a `> match —` footer carrying the highlight snippets and matched terms

Format functions produce `text` content blocks. They must render everything the LLM needs: different clients forward different surfaces, so `content[]` and `structuredContent` have to carry the same data.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `HN_CONCURRENCY_LIMIT` | No | Max concurrent HTTP requests for batch item fetches (integer, 1–50). Default: `10`. |

No API keys — both APIs are public. Framework-level config (`MCP_TRANSPORT_TYPE`, `MCP_LOG_LEVEL`, etc.) handled by `mcp-ts-core`.
