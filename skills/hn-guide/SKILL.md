---
name: hn-guide
description: Find the Hacker News thread behind a link, search topics without Algolia's fuzzy matches, read large comment trees in full, and search what one user said, with the hn_* tools. Use when a task asks what HN thinks of something, needs the discussion of a URL or story, a user's posts on a topic, the most-discussed front-page stories, or the monthly Who is hiring threads.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Hacker News, read-only and keyless: live feeds, items, and profiles from HN's Firebase API, and full-text search over Algolia's HN index. Nothing posts, votes, or flags. A story carries its submitted `url`, never the linked page: read the page with a web-fetch tool when the task needs its content.

## Identifiers

| To reach | Take |
|:--|:--|
| A story's whole discussion | a feed story's or story hit's `id`; a comment hit's `storyId`; a comment root's `item.storyId` from `hn_get_thread` |
| One comment and its replies | the comment's `id`, from a search hit, a thread page, or a user's submissions |
| What a comment replied to | `parent` on a `hn_get_thread` comment root or a `hn_get_user` submission; search hits carry no parent |
| A user | a `by` or `author` field, copied exactly |

Usernames match case-sensitively on every tool: `Animats` exists, while `animats` answers `user_not_found` and empties an author-filtered search. When the name came from the user rather than a field, confirm it with `hn_get_user`; on `user_not_found`, keyword-search the name (text search ignores case) and read the `author` of the hits that differ from it only in case.

## Gates

- **Find a link's thread with a story search.** A URL query searches comment text too, and comments that paste the link crowd out the submission: for `https://paulgraham.com/greatwork.html` the first six hits were all comments. Search it with the story type. One URL is often submitted many times, each a separate thread: that essay has about 11 story submissions, from 1,008 points and 432 comments down to reposts with a handful of points. Take the one with the most comments, or read several when the question is about reception over time.
- **Quote a term to match it exactly.** Algolia's keyword matching is typo-tolerant and matches the last term as a prefix: `kubernetse` returns Kubernetes stories, and `zig` matches "Zigbee". Wrap a term in double quotes to match only that word, and put `-` before a word to exclude it. October 2026 stories for `zig` number "about 617"; for `"zig"`, exactly 28, and `"zig" -devlog` 27. The `<em>` span in `highlights.title` and `highlights.text` shows what actually matched; `highlights.text` is absent under the compact view and when `highlightsTextOmitted` is true, so read `highlights.title` and `matchedWords` there.
- **An estimate is not a count.** Report `totalHits` as a number only when `totalHitsExact` is true, and as "about N" otherwise. An unquoted estimate also counts the fuzzy matches: `rust` by one author is "about 1,633" with off-topic comments among the newest hits, `"rust"` an exact 906.
- **Relevance is not popularity.** With a query, title matches outrank body-only matches whatever their score: a 57-point story that mentions `"zig"` only in its text ranked below 1-point title matches. For the biggest stories on a topic, set a points floor, or rank the hits by `points` or `numComments` yourself.
- **One thread page is not the thread.** `hn_get_thread` walks breadth-first, so on a large story the default page holds only top-level comments: 50 of 544, every one at depth 0, no replies. Before summarizing a discussion, either follow `nextCursor` until it is absent, or drill into the first top-level comments: each comment's id as `itemId`, with a deeper depth, returns its subtree (one top-level comment returned 23 live replies over four levels in a single call). A story's thread is complete when the comments loaded across pages reach `totalAvailable`. A comment root reports no `totalAvailable`; its subtree is complete when `truncated` is absent.
- **Comments have no scores.** HN exposes no comment votes: thread comments carry no `score` and comment hits no `points`. "Top comments" are the first top-level comments `hn_get_thread` returns, in HN's ranking order. Never call one the most upvoted.
- **Feed order is HN's rank, not score.** `hn_get_stories` returns a feed in ranking order: on the top feed a 66-point story sat fifth, above a 1,137-point one. The `front_page` search tag returns the same 30 stories sorted by points instead. "Most discussed" is the highest `descendants` (feeds, threads) or `numComments` (search), and it often disagrees with score: 534 comments on a 387-point story, 364 on the 1,137-point one.
- **Hiring threads are not the jobs feed.** The `jobs` feed and the `job` type hold YC company job ads, scored 1 with no comments. The monthly "Ask HN: Who is hiring?" and "Ask HN: Who wants to be hired?" threads are stories posted on the 1st by the user `whoishiring`, and each posting is a top-level comment. Find the month's thread with an author search for `whoishiring` sorted by date; list its postings with `hn_get_thread` at depth 1, or search them with a comment search scoped to its `storyId` (`remote rust`).
- **A user's submissions are everything they posted.** `hn_get_user` returns every item type, newest first, with no topic filter, so an active user's page is mostly comments. For what a user said about a topic, search with the author filter and a quoted term, sorted by date for their recent views; each comment hit's `storyTitle` names the thread it was posted in.

## Workflows

**What HN thinks of a topic over a period.** A story search with the quoted term and a date range finds the threads about it; a comment search with the same term and range finds what was said inside other threads, where much of the discussion lives. Scan both with the compact view, choose the stories with the most comments, and read them per the thread gate. Cite item ids, since `https://news.ycombinator.com/item?id=<id>` opens any of them.
