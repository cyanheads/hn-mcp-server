# hn-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `get_stories` | Fetch stories from an HN feed (top, new, best, ask, show, jobs). Returns enriched story objects with title, URL, score, author, and comment count. | `feed` (enum), `count`, `offset` | `readOnlyHint` |
| `get_thread` | Get an item and its comment tree as a threaded discussion. Recursively resolves child comments. With depth 0, returns just the item — doubles as an item lookup. | `itemId`, `depth`, `maxComments` | `readOnlyHint` |
| `get_user` | Get an HN user profile with karma, about, and optionally their most recent submissions resolved into full items. | `username`, `includeSubmissions`, `submissionCount` | `readOnlyHint` |
| `search_hn` | Search Hacker News stories and comments via Algolia. Supports filtering by content type, author, date range, and minimum points. | `query`, `tags`, `author`, `sort`, `dateRange`, `minPoints`, `count`, `page` | `readOnlyHint` |

### Resources

None. Item and user lookups are handled by `get_thread` (depth 0) and `get_user` respectively — both add value over raw API responses by resolving nested IDs.

### Prompts

None. Data-oriented server with no recurring interaction patterns that benefit from structured prompt templates.

---

## Overview

MCP server wrapping the [Hacker News API](https://github.com/HackerNews/API) (Firebase) and [HN Search API](https://hn.algolia.com/api) (Algolia). Gives LLM agents the ability to browse HN feeds, read threaded discussions, search for topics, and look up users and items — all read-only.

The server's primary value-add over raw API calls:

1. **Batch resolution** — feeds return ID arrays; the server fetches and enriches them into complete story objects in one tool call
2. **Thread traversal** — comment trees require recursive `kids` resolution; the server walks the tree and returns a structured, readable discussion
3. **User enrichment** — user profiles include submission IDs only; the server optionally resolves recent submissions into full items
4. **Unified search** — wraps Algolia's HN search with a clean interface for finding discussions by topic

## Requirements

- Read-only access to all public HN data (stories, comments, jobs, polls, users, feeds)
- Full-text search across stories and comments via Algolia
- Threaded comment tree resolution with configurable depth/size limits
- Concurrent batch fetching with configurable concurrency limits
- No authentication required (both APIs are public)
- No rate limit documented for HN Firebase API; Algolia has standard rate limits

---

## Tool Details

### `get_stories`

Browse curated HN feeds. Internally fetches the feed's ID array, slices by offset/count, then batch-fetches each item in parallel.

```ts
input: z.object({
  feed: z.enum(['top', 'new', 'best', 'ask', 'show', 'jobs'])
    .describe('Which HN feed to fetch. "top" includes jobs. "ask" and "show" are Ask HN / Show HN posts.'),
  count: z.number().min(1).max(100).default(30)
    .describe('Number of stories to return. Each story is fetched individually — larger counts take longer.'),
  offset: z.number().min(0).default(0)
    .describe('Number of stories to skip from the start of the feed. Use with count for pagination.'),
})

output: z.object({
  stories: z.array(z.object({
    id: z.number().describe('Item ID — use with get_thread to read comments.'),
    title: z.string().describe('Story title.'),
    url: z.string().optional().describe('External link URL. Absent for Ask HN / text posts.'),
    score: z.number().describe('Upvote count.'),
    by: z.string().describe('Author username.'),
    time: z.number().describe('Unix timestamp.'),
    descendants: z.number().optional().describe('Total comment count. Absent for jobs.'),
    text: z.string().optional().describe('Body text for Ask HN / text posts. Use get_thread for full discussion.'),
    type: z.string().describe('Item type (story, job).'),
  })).describe('Stories from the feed, ordered by HN ranking.'),
  feed: z.string().describe('Which feed was fetched.'),
  total: z.number().describe('Total items in the feed (up to 500 for top/new/best, 200 for ask/show/jobs).'),
  offset: z.number().describe('Offset used.'),
  hasMore: z.boolean().describe('Whether more stories are available beyond this page.'),
})
```

### `get_thread`

The highest-value tool. Fetches an item and recursively resolves its comment tree. Handles the tree traversal that would otherwise require dozens of sequential item fetches. Returns a flat comment list ordered by ranked BFS — at each level, comments appear in HN's ranked order before descending to the next depth. On wide threads (many direct replies), this favors breadth over depth; callers can increase `depth` or use a smaller `maxComments` with higher depth to trade coverage for conversational depth.

```ts
input: z.object({
  itemId: z.number()
    .describe('ID of the story, comment, or poll to fetch the thread for.'),
  depth: z.number().min(0).max(10).default(3)
    .describe('How many levels of replies to resolve. 0 = just the item, no comments. 1 = direct replies only. '
      + 'Deeper threads on popular stories can be very large — start with 2-3 and go deeper if needed.'),
  maxComments: z.number().min(1).max(200).default(50)
    .describe('Maximum total comments to include across all depth levels. '
      + 'Traversal stops when this limit is reached. Comments are resolved breadth-first by HN ranking.'),
})

output: z.object({
  item: z.object({
    id: z.number(),
    type: z.string(),
    by: z.string().optional(),
    time: z.number().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    text: z.string().optional(),
    score: z.number().optional(),
    descendants: z.number().optional(),
  }).describe('The root item (story, comment, or poll).'),
  comments: z.array(z.object({
    id: z.number(),
    by: z.string().optional(),
    time: z.number().optional(),
    text: z.string().optional(),
    depth: z.number().describe('Nesting level (0 = direct reply to root).'),
    parentId: z.number().describe('Parent item ID.'),
    childCount: z.number().describe('Number of direct child comments (may exceed what was resolved).'),
  })).describe('Flat comment list ordered by ranked BFS traversal. Use depth/parentId to reconstruct nesting.'),
  totalLoaded: z.number().describe('Number of comments actually fetched and included.'),
  totalAvailable: z.number().optional()
    .describe('Total comment count from the root item (descendants field). '
      + 'If totalLoaded < totalAvailable, increase maxComments or depth to see more.'),
})
```

### `get_user`

Fetches an HN user profile and optionally resolves their most recent submissions into full items. Without `includeSubmissions`, returns just the profile. With it, batch-fetches recent submissions so the agent gets actionable content in one call.

```ts
input: z.object({
  username: z.string()
    .describe('HN username. Case-sensitive.'),
  includeSubmissions: z.boolean().default(false)
    .describe('Resolve the user\'s most recent submissions into full items. '
      + 'Without this, only submission IDs are returned.'),
  submissionCount: z.number().min(1).max(50).default(10)
    .describe('Number of recent submissions to resolve. Only used when includeSubmissions is true.'),
})

output: z.object({
  user: z.object({
    id: z.string().describe('Username.'),
    karma: z.number().describe('Karma score.'),
    created: z.number().describe('Account creation time (Unix timestamp).'),
    about: z.string().optional().describe('Self-description (HTML).'),
    totalSubmissions: z.number().describe('Total number of submissions.'),
  }).describe('User profile.'),
  submissions: z.array(z.object({
    id: z.number().describe('Item ID — use with get_thread to read comments.'),
    type: z.string().describe('Item type (story, comment, job, poll).'),
    title: z.string().optional().describe('Title (stories/jobs/polls).'),
    url: z.string().optional().describe('External link URL.'),
    text: z.string().optional().describe('Body text (HTML).'),
    score: z.number().optional().describe('Score/upvotes.'),
    time: z.number().optional().describe('Unix timestamp.'),
    descendants: z.number().optional().describe('Comment count (stories/polls).'),
  })).optional().describe('Recent submissions, most recent first. Only present when includeSubmissions is true.'),
})
```

### `search_hn`

Wraps Algolia's HN Search API. Supports relevance-sorted and date-sorted search with tag and numeric filters.

```ts
input: z.object({
  query: z.string()
    .describe('Search terms. Supports simple keywords — Algolia handles stemming and relevance.'),
  tags: z.enum(['story', 'comment', 'ask_hn', 'show_hn', 'front_page']).optional()
    .describe('Filter results by content type. Single tag only — Algolia supports combining tags, '
      + 'but a single filter covers most use cases. Omit to search all types.'),
  author: z.string().optional()
    .describe('Filter results to a specific author. Useful for finding a user\'s posts on a topic '
      + '(get_user only shows recent submissions).'),
  sort: z.enum(['relevance', 'date']).default('relevance')
    .describe('Sort order. "relevance" for best match, "date" for most recent first.'),
  dateRange: z.object({
    start: z.string().optional().describe('Start date (ISO 8601). Results created after this date.'),
    end: z.string().optional().describe('End date (ISO 8601). Results created before this date.'),
  }).optional()
    .describe('Filter to a date window. Useful for finding discussions about recent events.'),
  minPoints: z.number().min(0).optional()
    .describe('Minimum score/points. Filters out low-engagement content.'),
  count: z.number().min(1).max(50).default(30)
    .describe('Number of results to return.'),
  page: z.number().min(0).default(0)
    .describe('Page number for pagination (0-indexed).'),
})

output: z.object({
  hits: z.array(z.object({
    id: z.number().describe('HN item ID — use with get_thread to read the discussion.'),
    title: z.string().optional().describe('Story title (present for stories).'),
    url: z.string().optional().describe('External link URL.'),
    author: z.string().describe('Author username.'),
    points: z.number().optional().describe('Score/upvotes.'),
    numComments: z.number().optional().describe('Comment count.'),
    createdAt: z.string().describe('Creation time (ISO 8601).'),
    storyTitle: z.string().optional().describe('Parent story title (present for comment results).'),
    storyId: z.number().optional().describe('Parent story ID (present for comment results).'),
    text: z.string().optional().describe('Comment or story body text (HTML).'),
  })).describe('Search results ranked by sort order.'),
  totalHits: z.number().describe('Total matching results across all pages.'),
  page: z.number().describe('Current page number.'),
  totalPages: z.number().describe('Total pages available.'),
  query: z.string().describe('The query that was searched.'),
})
```

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `hn` | HN Firebase API + Algolia Search API | All tools |

Single service with two internal API clients:

- **Firebase client** — `fetchItem(id)`, `fetchUser(username)`, `fetchFeed(type)`, batch helpers with concurrency limiting
- **Algolia client** — `search(params)` mapping to the Algolia search/search_by_date endpoints

Both are simple HTTP GET interfaces with no auth, no connection state, and JSON responses. One service directory keeps it cohesive.

### Batch Fetching

The Firebase API has no batch endpoint — each item is a separate HTTP GET. The service layer provides:

- `fetchItems(ids)` — parallel fetch with configurable concurrency limit (default 10)
- Failed individual fetches return `null` (item may be deleted/dead) — callers filter

This is the performance-critical path. `get_stories` fetching 30 items and `get_thread` fetching 50+ comments both depend on efficient batching.

## Conventions

### HTML Handling

The HN API returns HTML in `title`, `text`, and `about` fields. Raw HTML is noisy for LLM consumption. The service layer strips HTML to plain text before returning data:

- `<p>` tags → double newline
- `<a href="...">` → preserve URL in parentheses
- `<pre><code>` → preserve as-is (code blocks)
- `<i>` → strip tags, keep content
- All other tags → strip

This applies uniformly across all tools. No raw HTML reaches tool output.

### Dead and Deleted Items

The API returns `dead: true` and `deleted: true` on items. Policy:

- **Deleted items** — omit entirely. They have no useful content (fields are stripped by HN).
- **Dead items** — omit by default. Dead items are flagged/killed by mods or filters; including them adds noise. If a future use case warrants it, add a `showDead` flag.

Null results from batch fetches (item genuinely missing or API error) are also silently filtered.

### URL Normalization

The API occasionally returns empty strings for `url` (e.g., job posts). Normalize `""` to `undefined` so optional URL fields are consistently absent-or-present, never empty.

### Formatting

Each tool provides a `format` function that shapes output for LLM readability:

- `get_stories` — numbered list: rank, title, score, comment count, URL
- `get_thread` — root item summary, then indented comment tree using depth metadata
- `get_user` — profile summary, optionally followed by numbered submission list
- `search_hn` — numbered results with title, author, points, date

Format functions produce `text` content blocks. Keep them concise — agents can always access the structured output for details.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `HN_CONCURRENCY_LIMIT` | No | Max concurrent HTTP requests for batch item fetches. Default: `10`. |

No API keys — both APIs are public. Framework-level config (`MCP_TRANSPORT_TYPE`, `MCP_LOG_LEVEL`, etc.) handled by `mcp-ts-core`.

## Implementation Order

1. Config and server setup (replace echo stubs)
2. HN service — Firebase client (fetchItem, fetchUser, fetchFeed, fetchItems)
3. HN service — Algolia client (search)
4. `get_stories` tool
5. `get_user` tool
6. `get_thread` tool
7. `search_hn` tool

Each step is independently testable. `get_stories` and `get_user` can ship before the more complex `get_thread`.
