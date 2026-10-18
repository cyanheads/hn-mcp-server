# hn-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `hn_get_stories` | Fetch stories from an HN feed (top, new, best, ask, show, jobs). Returns enriched story objects with title, URL, score, author, and comment count. | `feed` (enum), `count`, `offset` | `readOnlyHint` |
| `hn_get_thread` | Get an item and its comment tree as a threaded discussion. Resolves child comments by ranked breadth-first traversal, resumable through a cursor. With depth 0, returns just the item — doubles as an item lookup. | `itemId`, `depth`, `maxComments`, `cursor` | `readOnlyHint` |
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
- The HN Firebase API documents no rate limit; HN Search (Algolia) limits each IP to 10,000 requests per hour. Neither documents a 429 status or a `Retry-After` header

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
| `count` | integer 1–1,000 | `30` | Served at most 100 per call; a larger value is served at 100 (see Per-call Caps). Larger counts take longer — each item is a separate fetch. |
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
| `stories[].descendants` | number? | HN's count of live comments in the thread (`descendants`); dead and deleted comments are not counted. Absent for jobs. |
| `stories[].text` | string? | Body text for Ask HN / text posts. |
| `feed` | string | Which feed was fetched. |

**Enrichment**: `total`, `offset`, `hasMore`, plus `truncated` / `shown` / `cap` only while more stories remain (`hasMore`), with a `notice` naming the next `offset` and, below the 100 cap, suggesting a larger `count`; above it, the `notice` says the call was served at 100 and `cap` reads 100. The last page carries none of them. An empty page gets a `notice` saying why (empty feed, offset past the end, or every item on the page dead/deleted). Items whose fetch failed after retries are listed in `failedIds`, and the `notice` names them with the retry (same `offset`, or the ID to `hn_get_thread`); a page where every item failed throws the classified upstream error instead.

**Errors**: `upstream_rejected`, `upstream_rate_limited`, `upstream_unavailable`, `upstream_html`, `upstream_malformed`.

### `hn_get_thread`

The highest-value tool. Fetches an item and resolves its comment tree, handling traversal that would otherwise require dozens of sequential item fetches. Returns a flat comment list ordered by ranked BFS — at each level, comments appear in HN's ranked order before descending to the next depth. On wide threads (many direct replies), this favors breadth over depth; callers page on with `nextCursor`, raise `depth`, or call again with a specific comment's `itemId` to drill into a subtree.

**Input**

| Field | Type | Default | Notes |
|:------|:-----|:--------|:------|
| `itemId` | integer | — | Required. Story, comment, job, poll, or poll option. |
| `depth` | integer 0–100 | `3` | `0` = item only, no comments. Served at most 10 per call; a larger value is served at 10 (see Per-call Caps). Ignored with `cursor`, which carries the depth it was issued with. |
| `maxComments` | integer 1–1,000 | `50` | Comments in one response, across all depth levels. Served at most 200 per call; a larger value is served at 200 (see Per-call Caps). |
| `cursor` | string? | — | `nextCursor` from a previous call with the same `itemId`. Omit (or send empty) to start from the top. |

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `item` | object | `id`, `type`, and optional `by`, `time`, `title`, `url`, `text`, `score`, `descendants`; `parent` (comment roots), `poll` (poll-option roots), `parts` (poll roots), and `deleted: true` / `dead: true` only when HN sets them. |
| `item.storyId` | number? | Comment roots only, at every `depth` including `0`: the story or poll the discussion belongs to (see OP on a comment root). Absent when it could not be found. |
| `item.options[]` | array? | Poll roots only, at every `depth` including `0`: `{ id, text?, score?, deleted?, dead? }` in `parts` order. Deleted and dead options are kept and marked; a failed option fetch goes to `failedIds`. Not counted in `maxComments` or `totalLoaded`. |
| `comments[].id` | number | |
| `comments[].by` | string? | |
| `comments[].time` | number? | |
| `comments[].text` | string? | HTML stripped. |
| `comments[].depth` | number | `0` = direct reply to root. |
| `comments[].parentId` | number | The root or a comment — possibly a dead or deleted one omitted from the list (see Dead and Deleted Items). |
| `comments[].childCount` | number | Direct children — may exceed what was resolved. |
| `comments[].isOp` | `true`? | Present only when the comment author submitted the thread's story or poll — the root itself, or for a comment root the story at `item.storyId`. Absent when either author is unknown; a `notice` says so when the story was not found or has no author. |

**Enrichment**: `totalLoaded` (this page), `totalAvailable` (HN's `descendants`, a count of live comments only — comment and job roots omit it), and, only while comments remain unread, `truncated` with `truncationReason`:

| Reason | Stopped by | Continue with |
|:-------|:-----------|:--------------|
| `count` | `maxComments`, or the 1,000-item ceiling one call examines | `nextCursor` |
| `size` | the 64,000-byte budget on the rendered `format()` text | `nextCursor` |
| `rate_limited` | an upstream 429 — nothing more is fetched that call | `nextCursor`, after the wait the notice names |
| `depth` | replies below the depth limit | a larger `depth`, or as `itemId` a comment at the last level that shows replies, or an omitted one the `notice` names |

A cursor reason wins over a depth cut on the same page; the depth cut is carried in the cursor and reported on the page where the cursor runs out. Its lever names only the drill-in targets that page can vouch for: a comment it returns at the last level with replies, the dead or deleted comments it met there with replies (by ID), and, for a cut carried from an earlier page, a comment that page showed with replies or named as omitted. A page `nextCursor` continues names the omitted ones it met in a sentence of its own, since the cut it carries forward is a single flag. `shown` / `cap` accompany `count` and `size`, with `cap` the `maxComments` served. A terminal page — nothing left to fetch, nothing below the depth limit — carries no `truncated`, reason, cursor, or cut notice, including a thread that loads in full at exactly `maxComments`. `failedIds` lists comments and poll options whose fetch failed after retries, and `notice` carries dropped deleted/dead counts, the failed IDs with the retry, then the next step for the reason above. A failure is never blamed on the limits, and the root is returned even when every comment failed.

**Errors**: `item_not_found`, `invalid_cursor` (a cursor that decodes to no state this tool issued — an altered payload, or one longer than any it issues — or one passed with a different `itemId` than it was issued for; logged at `notice`), plus the five upstream reasons.

#### Resumable traversal

The cursor is a base64url binary payload carrying `itemId`, `depth`, the running comment count, the depth-cut flag, the unvisited frontier as `(id, parentId)` pairs grouped by level and parent, and the story a comment root resolved to (`0` when none). Each call re-fetches the root, re-seeds the BFS from the frontier, and walks it in chunks no larger than the comments still wanted, so a dead, deleted, missing, or failed item never pushes a later sibling out of the page. A page comes back short only when the traversal has nothing left.

```text
0x01                                      format version
varint itemId, depth, offset, depthCut (0|1), groupCount
per (level, parentId) group:
  varint level, zigzag(parentId - itemId), idCount
  zigzag varint per ID: delta from the previous ID, the first from parentId
varint storyId (0 = none or unresolved)
  if non-zero: varint author byte length, then the author as UTF-8
```

Decisions:

- **Explicit frontier, not an offset.** HN re-ranks `kids` continuously; an offset into a ranked list would skip or repeat comments between pages. The frontier names the exact comments still owed, and the server keeps no session state.
- **Packed frontier, both formats decoded.** `nextCursor` renders on both response surfaces, and as decimal JSON in base64 it cost about 12.5 characters per frontier ID — on a wide thread's first page, more than the comments it pages. Varint deltas bring it to about 3. The decoder still reads the JSON format earlier releases issued, `limit` included, through the same checks, so a caller paging across an upgrade keeps its place; rejecting it would turn a call that resumed into an error. Anything else — an unknown format byte, a truncated payload, trailing bytes, a state that fails validation — is `invalid_cursor`. Every count the payload claims must be backed by its bytes, so decoding stays linear in the cursor's length. The tool decodes cursors itself rather than through the framework's `decodeCursor`, which writes a second log record carrying the caller's whole cursor.
- **Read the way 0.5.21 read it.** 0.5.21 decoded with lenient base64 (`-`/`_` mapped to `+`/`/`, then `Buffer.from(…, 'base64')`, which takes padding or none, skips characters outside the alphabet — whitespace among them — and stops at the first `=`), then parsed the payload as UTF-8 with invalid bytes replaced, so whitespace before `{` or between tokens and invalid UTF-8 inside a key it ignores all resumed. Both formats keep exactly that transport, so every string 0.5.21 accepted decodes to the same state — checked differentially against its decoder — and the two formats tolerate the same things. Strictness lives in the payload's structure, not the characters around it.
- **A length bound.** A cursor longer than 150,000 characters is `invalid_cursor` before it is read. That is over four times the longest a real thread issues: 33,604 characters for a 0.5.21 JSON cursor and 8,990 packed, both at depth 10 on HN's most-commented story.
- **Fixed byte budget, not an input.** 64,000 bytes of rendered `format()` text, measured with the same renderer `format()` uses (the root block, poll options included, plus each comment). It cuts only between comments and always keeps a page's first comment, so a single oversized comment is returned whole. The enrichment trailer sits outside the budget.
- **Failed comments lead the next cursor.** They stay listed in `failedIds` and are retried first when the caller continues, never skipped. With no cursor to continue, the retry is the same call again, or the ID as `itemId`.
- **A rate limit ends the call.** A 429 stops the batch (see Batch Fetching) and nothing further is fetched — every deeper level would pay its own retry ladder. The cursor resumes from the failed items.
- **Per-call item ceiling.** One call examines at most 1,000 frontier items, so a frontier of dead or deleted comments — or a crafted cursor — cannot run unbounded upstream fetches.
- **Omitted cut comments are named where they are met.** The cursor carries the depth cut as one flag, so the page where it runs out cannot tell which comments the cut fell below, or whether any of them was shown. Naming each omitted one on the page that meets it keeps every cut subtree reachable without widening the cursor. A page that reports a carried cut and shows no comment with replies of its own points back to the earlier pages, rather than claiming one is shown.
- **Ten names below depth 10, all of them at 10.** Below the depth cap the `notice` names the first 10 and counts the rest, since a larger `depth` reaches every one. At the cap an ID is the only way into those replies, so every one is named, bounded by the 1,000 items one call examines.

#### OP on a comment root

A comment names only its `parent`, so for a comment root the tool follows `parent` links up to the first item that is not a comment — the story or poll — one request per link, at every `depth`. That item becomes `item.storyId`, and `isOp` compares each reply with its author. Story, poll, job, and poll-option roots make no extra request: `isOp` compares with the root's own author.

The lookup never fails the call. A failed or missing ancestor, an ancestor with no `parent`, 64 links without reaching a story, or the time budget leaves `storyId` out and marks no reply `isOp`; a story with no author keeps `storyId` and marks none. Each case puts a sentence in `notice`, and a failed ancestor stays out of `failedIds`, which lists only items whose replies the response is missing. A 429 while looking takes the poll-option path: nothing more is fetched and `nextCursor` resumes. A cancellation propagates.

Decisions:

- **Firebase `parent` walk, not Algolia.** Algolia's `story_id` costs a constant two requests, but it has no record of a deleted comment, and `/items/<id>` returns the comment's whole subtree (287 KB for one top-level comment of a 3,090-comment story). The walk covers deleted and dead roots and ancestors, stays on one upstream, and costs one small request per level.
- **A 64-link ceiling and one 20-second budget.** The deepest comment in 22 of HN's largest threads is 32 links below its story; the ceiling doubles that. Every link, retry, and backoff shares one deadline counted from the start of the call, so a slow root fetch leaves the lookup less time instead of stretching the call toward the 60-second client timeout.
- **The cursor carries the story.** A continued page marks against the story the first page found, author included, without walking up again. A cursor issued before the story was found, or by a release that did not carry one, looks again. A story the cursor names is ignored for any root that is not a comment.
- **Omit, never `false`.** `isOp` stays `true`-or-absent; an unknown story author omits it, and the `notice` is what says the marks are missing.

### `hn_get_user`

Fetches an HN user profile and optionally resolves one page of their submissions into full items. Without `includeSubmissions`, returns just the profile. `submissionOffset` moves the page window, so a prolific account's older history stays reachable rather than being capped at the first `submissionCount` IDs.

**Input**

| Field | Type | Default | Notes |
|:------|:-----|:--------|:------|
| `username` | string | — | Required, trimmed, case-sensitive. |
| `includeSubmissions` | boolean | `false` | |
| `submissionCount` | integer 1–1,000 | `10` | Page size, served at most 50 per call; a larger value is served at 50 (see Per-call Caps). |
| `submissionOffset` | integer ≥ 0 | `0` | Submissions to skip, counting back from the most recent. Unbounded — a 15k-submission history is walkable. |

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `user.id` | string | |
| `user.karma` | number | |
| `user.created` | number | Unix seconds. |
| `user.about` | string? | HTML stripped. |
| `user.totalSubmissions` | number | Full history length, not the page size. |
| `submissions[]` | array? | `id`, `type`, and optional `parent` (comments), `poll` (poll options), `title`, `url`, `text`, `score`, `time`, `descendants`. Absent when `includeSubmissions` is false or the user has never submitted; empty when the window holds no live items. |

**Enrichment**: `submissionOffset` echoes the applied offset; `notice` names the window and the next offset while more remain (and, above the 50 cap, that the call was served at 50), or reports the valid range when the offset is past the end; `truncated` / `shown` / `cap` fire only when submissions remain beyond the page, with `cap` the page size served. Submissions whose fetch failed after retries are listed in `failedIds`, and the `notice` names them with the retry (same `submissionOffset`, or the ID to `hn_get_thread`); a window where every submission failed throws the classified upstream error instead.

**Errors**: `user_not_found`, plus the five upstream reasons.

### `hn_search_content`

Wraps Algolia's HN Search API. Supports relevance-sorted and date-sorted search with tag and numeric filters, by keyword, by filters alone, or both.

**Input**

| Field | Type | Default | Notes |
|:------|:-----|:--------|:------|
| `query` | string? | — | Trimmed; a supplied blank is rejected at the schema. Omit for a filter-only search, which needs at least one of `tags`, `author`, `storyId`, `minPoints`, or a `dateRange` bound — `sort`, `count`, `page`, and `view` don't count. Algolia handles stemming and relevance, and requires every token. A query with no whitespace that starts with `http://`, `https://` (either followed by an optional `www.`), or `www.` (case-insensitive) is searched without that prefix unless nothing would remain, so a page submitted under the other scheme or without `www.` still matches. Dropping required tokens only widens the match; a bare domain can widen past the 1,000-hit window (`paulgraham.com` matches about 1,800 stories), where `tags` and `dateRange` still narrow it. |
| `tags` | enum `story \| comment \| poll \| job \| ask_hn \| show_hn \| front_page` | — | Single tag. Omit to search all types. `pollopt` is left out as a filter: Algolia's poll-option records carry no text and no parent poll. Untagged searches still return them, through `author`, `dateRange`, and `minPoints` (an option's points are its votes), typed `pollopt`. `front_page` is Algolia's tag for the stories on the front page right now (about 30); a story loses it when it drops off, and no filter selects past front pages. The nearest proxy is `story` with `dateRange` and `minPoints`; without a query, the default `relevance` sort ranks by points. |
| `author` | string | — | Sent as typed as Algolia's `author_<name>` tag, which matches the HN username exactly and case-sensitively (`animats` finds nothing by `Animats`). The server can't recover the casing: HN's and Algolia's user endpoints are case-sensitive too, and an author-restricted query misses short names, so an empty author-filtered first page names the casing rule and `hn_get_user`, which answers `user_not_found` for a mis-cased name. Omit rather than passing a blank string. |
| `storyId` | positive integer | — | Sent as a `story_<id>` tag, ANDed with the other tags. Takes a story or poll root id: `hits[].storyId`, a poll hit's own `id` (poll hits carry no `storyId`), or from `hn_get_thread` the root's `id`, or its `item.storyId` when the root is a comment. A comment id matches nothing. |
| `sort` | enum `relevance \| date` | `relevance` | |
| `dateRange` | `{ start?, end? }` | — | ISO 8601 bounds (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or `YYYY-MM-DDThh:mm[:ss[.sss]]` with optional `Z` / `±hh:mm`), advertised as a `pattern`; calendar-invalid values are rejected at the schema. Converted to `created_at_i>start` and `created_at_i<end`, so both bounds are exclusive; date-only and offset-less values read as UTC. At least one bound, and `start` before `end`, compared as exact instants to the millisecond. |
| `minPoints` | integer ≥ 0 | — | Stories and polls only — Algolia stores `points: null` on comments and jobs, so any `points>=N` filter drops them. Rejected with `tags: "comment"` or `"job"`. |
| `count` | integer 1–1,000 | `30` | Served at most 50 per call (see Per-call Caps). Above 50, the search runs at `count` 50 and `page` (`page` × `count`) / 50 — the page of 50 that starts at the requested page's first hit, so `{count: 100, page: 2}` serves hits 200–249. A non-zero `page` whose first hit begins no page of 50 (`{count: 75, page: 1}`) fails with `count_page_unaligned`. |
| `page` | integer ≥ 0 | `0` | Counted in pages of `count` hits. |
| `view` | enum `full \| compact` | `full` | `compact` omits `text` and `highlights.text`. |

**Output**

| Field | Type | Notes |
|:------|:-----|:------|
| `hits[].id` | number | HN item ID — chains to `hn_get_thread`. |
| `hits[].type` | enum? | `story \| comment \| poll \| pollopt \| job`: the first `_tags` entry among those five, so `ask_hn`, `show_hn`, and `front_page` hits are stories. Absent when no tag names a type; never inferred from `title` or `storyId`. A poll option's `story_<id>` tag, which some older records carry, names the option itself, so no parent is read from it. |
| `hits[].title` | string? | Present for stories, polls, and jobs. |
| `hits[].url` | string? | |
| `hits[].domain` | string? | Bare hostname from `url`. |
| `hits[].author` | string | |
| `hits[].points` | number? | |
| `hits[].numComments` | number? | |
| `hits[].createdAt` | string | ISO 8601. |
| `hits[].storyTitle` | string? | Parent story title for comment hits. |
| `hits[].storyId` | number? | Equals `id` for story hits; the root story for comment hits. Absent for polls, poll options, and jobs — a poll's own `id` is its discussion root. |
| `hits[].text` | string? | Body text, HTML stripped: `comment_text`, else `story_text`, else `job_text`. Job bodies arrive only in `job_text`, which Algolia neither searches nor highlights, so `highlights.text` never carries one. Always absent under `view: "compact"`. |
| `hits[].highlights` | object? | `title`, `text` (both `<em>`-marked snippets; a literal `<em>` typed by the author is indistinguishable from a marker), and `matchedWords`. `text` is always absent under `view: "compact"`. |
| `query` | string? | The query that was searched, after any URL-prefix rewrite; the `content[]` heading reads from it. Absent for a filter-only search. |

**Enrichment**: `criteria`, `totalHits` (Algolia's `nbHits`, passed through), `totalHitsExact`, `page`, `totalPages`, and `reachableHits`, plus `truncated` / `shown` / `cap` only while more pages remain (`page + 1 < totalPages`), with a `notice` naming the next `page` and, below the 50 cap, suggesting a larger `count`. The last page Algolia serves carries none of the three. After a `count` above the cap, `page`, `totalPages`, `cap`, and `criteria.count` all describe the search as run, in pages of 50, and every page the `notice` names comes with `count: 50`. An empty page gets a `notice`: past the end it names the last valid page (`totalPages - 1`) and `page: 0` to start over — one lever when the search has one page, where the two are the same — or `page: 0` alone when the last page is unknown; an empty first page names the filters to relax, and the `storyId` source when one was set.

- **Applied criteria.** `criteria` records what the search ran with, on every successful page, empty and past-the-end pages included: each filter that was set (`tags`, `author`, `storyId`, `minPoints`, `dateRange`), then `sort`, `count`, and `view` with their defaults filled. Unset filters are absent. It is built from the params passed to `hn.search`, so `author` is the trimmed name and `count` the page size sent (50 when the caller's `count` was above the cap); `dateRange` holds the exclusive bounds as applied, in ISO 8601 UTC at whole seconds (start rounded down, end rounded up), from the same conversion that builds the request's `numericFilters`. `query` stays an output field and `page` its own enrichment field. The `content[]` trailer renders it as one `**criteria:**` line with `author` escaped inside its quotes; `structuredContent` keeps it raw. `ctx.enrich.echo()` was not used: it takes one string and renders it unescaped.
- **Count exactness.** `totalHitsExact` reads `exhaustive.nbHits`, else `exhaustiveNbHits`. Algolia flags keyword searches and broad filter-only searches as estimates, and those estimates can be off by orders of magnitude (all comments: about 300,000; one UTC day alone: 9,891, exact). With `totalHitsExact: false` the next-page `notice` reads "of about N". The field is omitted when Algolia sends neither flag, and on a page past the ceiling, where Algolia flags its `nbHits: 0` as exact. Exactness is a field rather than a notice because nearly every keyword search would otherwise carry one.
- **Capped coverage.** Algolia serves at most 1,000 hits per search, and `nbPages` already reflects that ceiling. `reachableHits: 1000` appears on every page of a search whose `totalHits` exceeds it; an exact count can still be capped. The last page served of such a search sets no `truncated`, which means only that another page exists; its `notice` names the ceiling, the total, and narrower `dateRange` windows to reach the rest. A page that straddles hit 1,000 returns only the remainder and counts as that last page. Below the ceiling, an out-of-range page keeps the real `nbHits` / `nbPages` with zero hits; past it, Algolia answers `nbHits: 0`, `nbPages: 0`, which is why the last valid page can be unknown.
- **One notice.** `notice` is last-wins in the framework, so the handler composes one string: the page-state sentence first (next page, capped coverage, past the end, or what to relax), then sentences the inputs call for, in input order — `query` (the dropped URL prefix on every page, plus, on an empty first page, that submissions often omit `#fragments` and tracking parameters), `tags` (with `front_page`, that it covers only the current front page, on an empty first page or whenever `dateRange` is set), `author` (the exact-casing rule, on an empty first page), `storyId` (where to get one, on an empty first page), then `count` (that a value above the cap was served at 50, whenever more pages remain or the page served is numbered differently from the one requested, plus that renumbering). None replaces another.

**Errors**: `missing_query_or_filter` (no query and no filter), `invalid_date_range` (a `dateRange` with no bound, or `start` not before `end`), `min_points_unscored_type` (`minPoints` with `tags: "comment"` or `"job"`), `count_page_unaligned` (a `count` above 50 with a non-zero `page` whose first hit begins no page of 50; the hint names the largest `count` up to 50, and its `page`, that start at that hit, and, when that count is under 25, the page of 50 holding the hit — `{count: 53, page: 1}` names `count: 1, page: 53`, or `count: 50, page: 1` for hits 50–99), plus the five upstream reasons. The four input checks run in the handler, before any upstream call, so each carries its declared reason and recovery hint; a schema refinement would surface only as `invalid_arguments`. Only an omitted `query` enables a filter-only search: a supplied blank still fails at the schema, following the rule that a supplied-but-empty value is rejected rather than read as omitted. A bare `dateRange: {}` fails as `invalid_date_range`, not `missing_query_or_filter`.

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

- `fetchItems(ids)` — parallel fetch with a configurable concurrency limit (default 10), returning one slot per ID in input order: `item` (HN returned it, possibly dead or deleted), `absent` (HN answered `null`), or `failed` (the fetch failed after retries; carries the classified error)
- A per-item failure fills a `failed` slot so one bad item does not fail the batch, and callers report its ID rather than dropping it: unlike an absent item, it may load on a later call
- An `upstream_rate_limited` failure stops the batch. In-flight fetches settle, and every slot not yet started is reported `failed` with that error, so a throttled upstream costs one retry ladder, not one per remaining item
- A caller abort rethrows, ending the batch
- With a `deadline` (a `Date.now()` instant), a fetch still retrying when it passes fails its slot with a `Timeout` instead of finishing its retry ladder; the story lookup in `hn_get_thread` is its one caller
- `settlePage(slots)` serves the paged tools (`hn_get_stories`, `hn_get_user`): live items plus failed IDs, and a throw of the first failure's classified error when every slot failed. `hn_get_thread` reads the slots itself, since it counts deleted and dead comments, carries failed ones in its cursor, and returns its root regardless

This is the performance-critical path. `hn_get_stories` fetching 30 items and `hn_get_thread` fetching 50+ comments both depend on efficient batching.

## Conventions

### HTML Handling

The HN API returns HTML in body fields: `text` and `about`, and Algolia's `comment_text` / `story_text`. Raw HTML is noisy for LLM consumption, so `stripHtml` turns each body into plain text before it reaches either output surface:

- `<p>` tags → a blank line
- `<pre><code>` → kept verbatim, leading indent included, with entities decoded
- `<a href="...">` → the href alone when the link text is the href or a `...`-truncated prefix of it; otherwise `text (href)`. HN cuts long link text short and older items encode `/` in the text but not the href, so the two are compared after decoding, with highlight markers set aside and any entity the cut left partial (the `&#3` of `&#38;`) dropped
- All other tags → stripped, content kept
- Named and numeric HTML entities → decoded exactly once; a reference to U+0000, U+0001, a surrogate, or a value past U+10FFFF decodes to U+FFFD, and a name outside the declared set (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`) stays as typed

Titles are not HTML, though some carry entities: `The <Dialog> Element` and `AT&T` arrive as typed, while items 1031 (`&#34;Remember Me&#34; …`) and 3409539 (`Apple&#8217;s …`) arrive encoded on both APIs, and Algolia encodes 26915706 as `Using &lt;details&gt; …` where Firebase sends it raw. Every title projection therefore takes `decodeHtmlEntities` alone and never `stripHtml`, so a title that looks like a tag survives. No raw HTML from a body reaches tool output.

While the strip rewrites the rest, code blocks and highlight markers are held by masks that open with U+0000 and close with U+0001. Distinct delimiters keep typed text between two adjacent masks from borrowing the close of one and the open of the next to spell a third. `stripHtml` removes both characters from its input first and decoding never produces either, so no upstream text can spell a mask: a typed `@@CODE_0@@` or `CODE_0` passes through unchanged. Each scan runs forward once, so the strip stays linear on any input.

Algolia highlight snippets keep their `<em>…</em>` markers. `stripHtmlPreservingEm` runs the same strip over a body snippet and carries the markers through, including into a collapsed link, where they stay on the matched characters of the href. A title snippet is entity-decoded between its markers and never tag-stripped, so a decoded `&lt;em&gt;` joins the markers it cannot be told from. `<em>` is the only marker on both surfaces: `format()` sees only the validated output, so a literal `<em>` typed inside a snippet is indistinguishable from a marker, and the `highlights` descriptions say so.

### Dead and Deleted Items

The API returns `dead: true` and `deleted: true` on items. Policy:

- **Deleted items** — omit entirely. They have no useful content (fields are stripped by HN).
- **Dead items** — omit by default. Dead items are flagged/killed by mods or filters; including them adds noise. If a future use case warrants it, add a `showDead` flag.

This policy covers items resolved into a list — comments, feed stories, submissions. Two things are shown and marked instead: the root an `hn_get_thread` call asked for (`deleted: true` / `dead: true`, a `[deleted]` / `[dead]` heading marker, and its replies still walked), and a poll's options, where dropping a deleted one would misstate the poll.

An omitted comment's replies are still walked. `hn_get_thread` queues a dead or deleted comment's `kids` as it does a live comment's, so its live replies come back at their true `depth` with `parentId` naming the omitted comment, and an omitted comment with replies at the last allowed level reports the depth cut. Since no response shows that comment, the `notice` names its ID as the `itemId` to drill into, on the page where the walk meets it. The omitted comment costs nothing against `maxComments`, `totalLoaded`, or the byte budget, but counts toward the per-call item ceiling and the notice's dropped counts. HN's `descendants` counts those replies and never a dead or deleted comment, so paging a thread to the end reaches `descendants`, less what lies below the depth limit. Omitting the comment rather than listing a placeholder keeps `comments.length` equal to `totalLoaded` and comparable with `totalAvailable`; a caller that needs the omitted comment passes its ID as `itemId`.

Absent items (HN answers `null`: no item under that ID) are also filtered. A fetch that failed is not filtered with them: it is reported by ID in `failedIds` (see Batch Fetching), since the item may exist and load on a later call.

Pagination advances by the requested window, not by the live-item count — otherwise a window full of dead items would be re-fetched forever. `hn_get_thread`'s cursor advances the same way: every visited item leaves the frontier, live or not.

### Per-call Caps

A size input — a page size, or `hn_get_thread`'s `depth` — keeps a per-call cap and accepts values up to a hard ceiling that guards against absurd input. A value between the two is served at the cap rather than rejected, since it has one obvious reading and every tool already has a lever that reaches the rest (a page, a cursor, or a deeper comment as `itemId`): a rejection would only cost the caller a round trip. Above the ceiling the call is still rejected.

| Tool | Input | Cap | Ceiling | Rest via |
|:--|:--|--:|--:|:--|
| `hn_get_stories` | `count` | 100 | 1,000 | `offset` |
| `hn_search_content` | `count` | 50 | 1,000 | `count: 50` with the `page` the notice names |
| `hn_get_user` | `submissionCount` | 50 | 1,000 | `submissionOffset` |
| `hn_get_thread` | `maxComments` | 200 | 1,000 | `nextCursor` |
| `hn_get_thread` | `depth` | 10 | 100 | a depth-9 comment's id as `itemId` |

- **Served window.** The call serves the first cap's worth of the window the caller asked for, and `cap` reports the size served. On the offset-paged tools that is the same offset with the size clamped; on `hn_get_thread`, the walk runs with `maxComments` and `depth` clamped, and the cursor carries the depth served, so no issued cursor exceeds 10 and one that claims more is still `invalid_cursor`.
- **Disclosure.** The `notice` says the value was served at the cap (`count 150 is above the per-call cap of 100, so this call served count: 100.`) whenever the cap withheld something the caller could fetch next, beside the concrete next value. A capped page that already reaches the end of the list gets no sentence: nothing was withheld. Every tool phrases it through `servedAtCap()` (`src/mcp-server/tools/served-at-cap.ts`).
- **Thread limits.** For `maxComments` the sentence rides a `count` stop, between "Stopped at maxComments 200" and the `nextCursor` lever; a page stopped by the byte budget, the item ceiling, or a rate limit gets none, since the cap did not stop it. For `depth` it rides the depth-cut notice, before the lever that names a depth-9 comment to pass as `itemId`, and only when the depth served is 10 — so a tree no deeper than 10 levels gets none. A cursor's depth applies over the one passed with it, so on the cursor page where a carried cut is reported, the sentence appears when the depth passed again is above 10 and the cursor carries 10.
- **Search pages.** `hn_search_content`'s `page` counts in units of `count`, so the page as served is renumbered: the search runs at `count` 50 from the requested page's first hit (`page` × `count`), and `page`, `totalPages`, and `criteria.count` describe that page of 50 — a saved result reads as the search it actually ran. Algolia's `offset`/`length` parameters can serve any window, but their responses drop `page`, `nbPages`, and `hitsPerPage`, and a window that begins mid-page-of-50 (`{count: 75, page: 1}`) has no page number at that size; such a call is rejected with `count_page_unaligned` and a hint naming a `count` and `page` that start at the same hit. When that count is under 25, the hint also names the page of 50 holding the hit: covering 50 hits from an exact start that small takes three or more calls, where pages of 50 take two at the cost of re-reading the hits before it. That combination was rejected before caps were served, so no call that succeeded changed.

### Upstream Failures

Every upstream failure reaches the client as a classified error carrying `data.reason` and `data.recovery.hint`, so a `content[]`-only client gets an actionable next move instead of a plumbing string. The service maps the failure onto five reasons, each declared in every tool's `errors[]` contract:

| Reason | Fires on | JSON-RPC code |
|:-------|:---------|:--------------|
| `upstream_rejected` | 4xx other than 429 — the request was rejected and the same input fails again | `InvalidParams` |
| `upstream_rate_limited` | 429. A `Retry-After` header passes through unchanged as `data.retryAfter`, and the hint names it (`retry after 120 seconds`, or the HTTP-date verbatim) | `RateLimited` |
| `upstream_unavailable` | 5xx | `ServiceUnavailable` |
| `upstream_html` | HTML error page served with a 200 status | `ServiceUnavailable` |
| `upstream_malformed` | 200 status with a body that is not JSON | `ServiceUnavailable` |

The last two are 200-status failures that would otherwise reach the client as a raw `SyntaxError` from `JSON.parse`, whose message names the token it choked on — upstream body content.

The code travels with the reason rather than with the HTTP status. The framework's finer status ladder would split one reason across several codes — HN answers an unknown path with 401, and a 500 or 504 would surface as `InternalError` or `Timeout`, blurring the codes that mean "this server broke" and "this server's own fetch timed out". The exact status stays on `data.status`.

The HTTP-status wrapper sits *outside* `withRetry`, not inside it: retry eligibility, `Retry-After` honoring, timeouts, and caller aborts all classify against the framework's original error, and only `errorSource: 'FetchHttpError'` throws are rewritten. The upstream URL and the verbatim response body are dropped from the client-facing message and data, and kept on the `cause` chain for server-side logs. A 429's `Retry-After` is the one cause field copied forward. `withRetry` itself waits out a value of up to 30 seconds, so the one that surfaces is either longer (the call failed fast) or the last one seen once retries ran out.

### URL Normalization

The API occasionally returns empty strings for `url` (e.g., job posts). Normalize `""` to `undefined` so optional URL fields are consistently absent-or-present, never empty.

### Formatting

Each tool provides a `format` function that shapes output for LLM readability:

- `hn_get_stories` — ranked list: rank, title, domain, id/type/score/author/comment count/date, URL, body text
- `hn_get_thread` — a type-aware heading (the title for story, job, and poll roots; `Comment by <author>`; `Poll option by <author> on poll <id>`; a `[deleted]` / `[dead]` marker), a meta line with id/type/`parent:`/`poll:`/`parts:`/score/author/comment count/date, a poll's options, then the comment list indented by depth, with author, id/depth/parent/reply count/date, and an OP marker
- `hn_get_user` — profile summary, then a submission list with id, `parent:` / `poll:`, type, score, comment count, date, URL, and body text
- `hn_search_content` — a heading quoting the query (or marking a filter-only search), then per-hit heading (the title + domain for stories, polls, and jobs; the parent story for comment hits; `Poll option by <author>` for a poll option, followed by a line pointing to `hn_get_thread` for its text and poll), a metadata line with id, `type:` when the hit has one, author, score, comment count, and date, URL, body text, and a `> match —` footer carrying the title snippet, matched terms, and body snippet. An untyped hit renders without `type:`, by title or as a comment

Format functions produce `text` content blocks. They must render everything the LLM needs: different clients forward different surfaces, so `content[]` and `structuredContent` have to carry the same data.

Upstream text is interpolated into Markdown, so `format()` fences it at the render boundary (`src/mcp-server/tools/markdown-escape.ts`). `structuredContent` keeps the provider text:

- **Bodies** — item and comment text, `about`, hit text, and the highlight body. Every line gets `> ` after any indent, and an empty line a bare `>`, so no body line can pass for a comment header, heading, or rule. The one escape inside a body is the leading `[` of a line that could open a link reference definition: after any spaces, tabs, and quote or list markers, a `[` whose label closes into `]:` on that line, or one with no `]` after it, whose label may close on a later line. CommonMark applies definitions document-wide, even from inside a quote, so a live one would turn `[1]`, `[deleted]`, or `[pdf]` in server text into a link. It renders `> \[1]: url`. Indentation is no exemption: four or more spaces make a line code at the top level but continuation text after a list item, so a code line shaped `[x]: y` takes the `\` too. `[1] see`, `x [1]: y`, and a `[1] https://…` footnote line are unchanged. Nothing else is escaped, which keeps code intact; escaping would mangle `Vec<T>` and `*` in code that `format()` cannot tell from prose. A blank line follows each body before any server line, since a quote absorbs the next non-blank line through lazy continuation — `hn_get_thread` separates comments with one, and its byte budget counts it.
- **Single-line fields** — titles, title highlights, and poll-option text, plus two caller strings `hn_search_content` echoes: the query in its quoted heading and `author` in its `criteria` trailer line. Only `\`, `*`, backtick, the `]` of `](`, and `<` before a letter, `/`, `!`, or `?` are escaped, plus `"` where the field sits in `story:"…"`, `Comment on "…"`, or the search's quoted query and author, and `|` in the title highlight inside the search footer, whose segments ` | ` separates. Any line break becomes a space. What this guarantees: the field cannot close or open the server's markup around it — the `**…**` in `hn_get_user`, a quote, a footer segment, a new line — and it reads as typed in raw text. It is not a full Markdown escape: `_under_` can still render as emphasis in a renderer, and a typed `&copy;` as ©. `a < b`, `[pdf]`, `snake_case`, and `a | b` outside the footer are unchanged. Highlight markers pass through as `<em>…</em>`.
- **Verbatim** — usernames, URLs, IDs, and server tokens (`Comment by <author>`, `[deleted]`, `parent:` / `poll:`).
- **Search footer** — `> match — title: … | terms: … | body: …`, after an unquoted blank line, which a quoted body never produces, so a body line reading `match — terms: x` cannot pass for the footer. The body snippet comes last and continues on quoted lines of its own, so no body text precedes a server-authored part.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `HN_CONCURRENCY_LIMIT` | No | Max concurrent HTTP requests for batch item fetches (integer, 1–50). Default: `10`. |

No API keys — both APIs are public. Framework-level config (`MCP_TRANSPORT_TYPE`, `MCP_LOG_LEVEL`, etc.) handled by `mcp-ts-core`.
