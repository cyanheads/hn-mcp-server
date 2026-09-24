/**
 * @fileoverview Search Hacker News via Algolia with filtering and pagination.
 * @module mcp-server/tools/definitions/search-content.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  dateBoundToEpochMs,
  extractDomain,
  getHnService,
  normalizeUrl,
  stripHtml,
  stripHtmlPreservingEm,
} from '@/services/hn/hn-service.js';
import type { AlgoliaHighlightValue, AlgoliaHit } from '@/services/hn/types.js';

/** Largest page `count` accepts, mirrored in the input schema. */
const MAX_COUNT = 50;

/**
 * ISO 8601 calendar forms accepted for a date bound: `YYYY`, `YYYY-MM`,
 * `YYYY-MM-DD`, or `YYYY-MM-DDThh:mm[:ss[.sss]]` with an optional `Z` or
 * `±hh:mm` offset. Advertised as the bound's `pattern`; the captures feed the
 * calendar-range check the pattern cannot express.
 */
const DATE_BOUND_PATTERN =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))?)?)?)?$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * True when a pattern-matching bound names a real calendar instant — rejecting
 * `2024-02-30` or `T24:00`, which `Date.parse` would silently roll over. A value
 * the pattern rejects passes here, so it is reported once, as a format error.
 */
function isCalendarValid(value: string): boolean {
  const m = DATE_BOUND_PATTERN.exec(value);
  if (!m) return true;
  /** Omitted month and day read as 1; omitted time and offset fields as 0. */
  const field = (i: number, omitted: number) => Number(m[i] ?? omitted);
  const [year, month, day] = [field(1, 0), field(2, 1), field(3, 1)];
  const [hour, minute, second] = [field(4, 0), field(5, 0), field(6, 0)];
  const [offsetHour, offsetMinute] = [field(7, 0), field(8, 0)];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  return (
    days !== undefined &&
    day >= 1 &&
    day <= days &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

const dateBound = () =>
  z
    .string()
    .regex(
      DATE_BOUND_PATTERN,
      'must be an ISO 8601 date or date-time — YYYY, YYYY-MM, YYYY-MM-DD, or YYYY-MM-DDThh:mm[:ss[.sss]] with an optional Z or ±hh:mm offset.',
    )
    .refine(
      isCalendarValid,
      'is not a real calendar date or time — check the month, day, hour, minute, second, and offset ranges.',
    )
    .optional();

/** The filters a caller set, in the order notices name them. `sort`, `count`, `page`, and `view` are not filters. */
function appliedFilters(input: {
  tags?: string | undefined;
  author?: string | undefined;
  storyId?: number | undefined;
  minPoints?: number | undefined;
  dateRange?: { start?: string | undefined; end?: string | undefined } | undefined;
}): string[] {
  const filters: string[] = [];
  if (input.tags) filters.push('tags');
  if (input.author) filters.push('author');
  if (input.storyId != null) filters.push('storyId');
  if (input.minPoints != null) filters.push('minPoints');
  if (input.dateRange?.start || input.dateRange?.end) filters.push('dateRange');
  return filters;
}

/**
 * Notice for a page that came back empty. A page past the end names the last
 * valid page when Algolia reports one; past its 1,000-hit ceiling Algolia
 * answers `nbPages: 0`, so the last page is unknown and the notice resets to
 * page 0. Only a first page with no hits is a zero-match search.
 */
function emptyPageNotice(
  input: { query?: string | undefined; storyId?: number | undefined },
  filters: string[],
  page: number,
  totalHits: number,
  totalPages: number,
): string {
  if (page > 0) {
    return totalPages > 0
      ? `Page ${page} is past the last page of results (${totalHits} hits across ${totalPages} page${totalPages === 1 ? '' : 's'}). Pass page: ${totalPages - 1} for the last page, or page: 0 to start over.`
      : `Page ${page} is past the last page Algolia serves for this search (at most 1,000 hits per search), where totalHits and totalPages read 0. Pass page: 0 to start over; if that also returns nothing, the search itself matches nothing.`;
  }
  const base =
    input.query == null
      ? `No items matched these filters: ${filters.join(', ')}. Relax or change them.`
      : filters.length
        ? `Try broader keywords, or relax these filters: ${filters.join(', ')}.`
        : 'Try broader keywords or different terms.';
  return input.storyId == null
    ? base
    : `${base} storyId must be a story or poll root id — take it from hits[].storyId or the hn_get_thread root; a comment id matches nothing.`;
}

/**
 * Project Algolia's `_highlightResult` into a flat snippet object: the title
 * snippet, the body snippet (preferring comment_text over story_text to match
 * the `text` mapping), and the deduplicated union of matched words across all
 * surfaced fields. Returns undefined when nothing matched.
 *
 * `includeBody` is false under the compact projection, which drops the body
 * snippet — the field that duplicates a hit's full comment text.
 */
function extractHighlights(hit: AlgoliaHit, includeBody: boolean) {
  const h = hit._highlightResult;
  if (!h) return;

  const matched = (v: AlgoliaHighlightValue | undefined): v is AlgoliaHighlightValue =>
    v != null && v.matchLevel !== 'none';

  const title = matched(h.title) ? h.title.value : undefined;
  const textHl = matched(h.comment_text)
    ? h.comment_text
    : matched(h.story_text)
      ? h.story_text
      : undefined;
  const text = includeBody && textHl ? stripHtmlPreservingEm(textHl.value) : undefined;

  const fields = [h.title, h.url, h.author, h.comment_text, h.story_text, h.story_title];
  const matchedWords = Array.from(new Set(fields.flatMap((f) => f?.matchedWords ?? [])));

  if (title == null && text == null && matchedWords.length === 0) return;

  return {
    ...(title != null && { title: stripHtmlPreservingEm(title) }),
    ...(text != null && { text }),
    matchedWords,
  };
}

export const searchHn = tool('hn_search_content', {
  description:
    'Search Hacker News stories, comments, polls, and jobs via Algolia — by keyword, by filters alone, or both. Filterable by content type, author, parent story, date range, and minimum points.',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'missing_query_or_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither a query nor any filter was supplied, so there is nothing to search by.',
      recovery:
        'Pass a query, or at least one filter: tags, author, storyId, minPoints, or a dateRange bound. sort, count, page, and view do not count as filters.',
      severity: 'notice',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'dateRange was supplied with neither bound, or with start not before end.',
      recovery:
        'Give dateRange a start, an end, or both with start before end — both bounds are exclusive — or omit dateRange entirely.',
      severity: 'notice',
    },
    {
      reason: 'min_points_unscored_type',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'minPoints was combined with tags "comment" or "job", record types Algolia stores without points.',
      recovery:
        'Drop minPoints to search comments or jobs, or search a scored type (story, poll, ask_hn, show_hn, front_page) to filter by points.',
      severity: 'notice',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Algolia answered with a 4xx status other than 429 — it rejected the request as built.',
      recovery: 'Check the input values against this schema; the same input fails identically.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Algolia answered with HTTP 429.',
      recovery:
        'Wait the interval in retryAfter when the error carries one, otherwise several seconds, then retry and call this tool less often.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Algolia answered with a 5xx status.',
      recovery: 'Retry after a short delay; no input change helps while the upstream is down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_html',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Algolia served an HTML error page with a 200 status, which it does under rate limiting or maintenance.',
      recovery: 'Retry after a brief delay; the upstream is throttling or in maintenance.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_malformed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Algolia answered with a 200 status and a body that is not JSON.',
      recovery: 'Retry after a brief delay; no input change helps while the upstream serves this.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  input: z.object({
    query: z
      .string()
      .trim()
      .min(
        1,
        'blank after trimming whitespace — pass one or more search terms, or omit query for a filter-only search.',
      )
      .optional()
      .describe(
        'Search terms. Supports simple keywords — Algolia handles stemming and relevance. Trimmed before searching; blank or whitespace-only input is rejected. Omit for a filter-only search, which needs at least one of tags, author, storyId, minPoints, or a dateRange bound.',
      ),
    tags: z
      .enum(['story', 'comment', 'poll', 'job', 'ask_hn', 'show_hn', 'front_page'])
      .optional()
      .describe(
        'Filter results by content type: "story", "comment", "poll", or "job", or the story subsets "ask_hn", "show_hn", and "front_page". Omit to search all types.',
      ),
    author: z
      .string()
      .trim()
      .min(1, 'blank after trimming whitespace — omit author to search all authors.')
      .optional()
      .describe(
        `Filter results to a specific author. Useful for finding a user's posts on a topic (hn_get_user only shows recent submissions). Trimmed before filtering; omit the field to search all authors rather than passing a blank string.`,
      ),
    storyId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Restrict results to one discussion: the id of a story or poll root, combined with the other filters. Pair with tags "comment" to search within a thread. Take it from hits[].storyId or the root item of hn_get_thread — a comment id matches nothing.',
      ),
    sort: z
      .enum(['relevance', 'date'])
      .default('relevance')
      .describe('Sort order. "relevance" for best match, "date" for most recent first.'),
    dateRange: z
      .object({
        start: dateBound().describe(
          'Exclusive lower bound — only items created strictly after this instant match. ISO 8601: YYYY, YYYY-MM, YYYY-MM-DD, or YYYY-MM-DDThh:mm[:ss[.sss]] with an optional Z or ±hh:mm offset. Reduced and date-only forms mean UTC midnight at the start of that period; a date-time without an offset is read as UTC.',
        ),
        end: dateBound().describe(
          'Exclusive upper bound — only items created strictly before this instant match. Same formats and UTC reading as start, and must be later than start. A date-only end excludes that whole UTC day: to include it, pass the next day or a full timestamp.',
        ),
      })
      .optional()
      .describe(
        'Filter to a creation-time window with a start, an end, or both. An empty object is rejected — omit dateRange instead.',
      ),
    minPoints: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Minimum score. Applies to stories and polls, including the ask_hn, show_hn, and front_page subsets. Comments and jobs carry no points in the search index, so any minPoints excludes them — combining it with tags "comment" or "job" is rejected.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_COUNT)
      .default(30)
      .describe('Number of results to return.'),
    page: z.number().int().min(0).default(0).describe('Page number for pagination (0-indexed).'),
    view: z
      .enum(['full', 'compact'])
      .default('full')
      .describe(
        'How much of each hit to return. "full" includes every field. "compact" omits the two body-text fields — `text` and `highlights.text` — which together can repeat a long comment twice per hit; everything else (id, title, url, domain, author, points, comment count, timestamp, parent story, title highlight, matchedWords) is unchanged. Use "compact" to scan many results, then pass a hit id to hn_get_thread to read the body you skipped.',
      ),
  }),
  output: z.object({
    hits: z
      .array(
        z
          .object({
            id: z.number().describe('HN item ID — use with hn_get_thread to read the discussion.'),
            title: z
              .string()
              .optional()
              .describe('Item title (present for stories, polls, and jobs).'),
            url: z.string().optional().describe('External link URL.'),
            domain: z
              .string()
              .optional()
              .describe(
                'Bare hostname derived from url (e.g. "github.com", with leading "www." stripped). Absent when url is missing or unparseable.',
              ),
            author: z.string().describe('Author username.'),
            points: z.number().optional().describe('Score/upvotes.'),
            numComments: z.number().optional().describe('Comment count.'),
            createdAt: z.string().describe('Creation time (ISO 8601).'),
            storyTitle: z
              .string()
              .optional()
              .describe('Parent story title (present for comment results).'),
            storyId: z
              .number()
              .optional()
              .describe('Parent story ID for comment hits; equals `id` for story hits.'),
            text: z
              .string()
              .optional()
              .describe(
                'Comment or story body text (HTML stripped). Absent when the hit has no body, and always absent under view "compact" — call hn_get_thread with this id to read it.',
              ),
            highlights: z
              .object({
                title: z
                  .string()
                  .optional()
                  .describe(
                    'Title snippet with matched terms wrapped in `<em>…</em>`. Absent when the title did not match.',
                  ),
                text: z
                  .string()
                  .optional()
                  .describe(
                    'Body snippet (comment_text or story_text) with matched terms wrapped in `<em>…</em>`. Absent when the body did not match, and always absent under view "compact" — matchedWords still lists what matched.',
                  ),
                matchedWords: z
                  .array(z.string())
                  .describe(
                    'Deduplicated union of matched terms across all searchable fields (title, url, author, comment_text, story_text, story_title).',
                  ),
              })
              .optional()
              .describe(
                'Algolia per-field highlight metadata showing which terms matched and where. Absent when no fields produced a match.',
              ),
          })
          .describe('A single Algolia search hit (story, comment, poll, or job).'),
      )
      .describe('Search results ranked by sort order.'),
    query: z
      .string()
      .optional()
      .describe('The query that was searched. Absent for a filter-only search.'),
  }),

  enrichment: {
    totalHits: z.number().describe('Total matching results across all pages.'),
    page: z.number().describe('Current page number (0-indexed).'),
    totalPages: z
      .number()
      .describe(
        'Number of pages Algolia will actually serve for this query. Not derived from totalHits — broad queries report a totalHits far larger than the reachable page range, so paginate against this value.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more pages remain after this one (page + 1 < totalPages). Absent on the last page Algolia serves.',
      ),
    shown: z.number().optional().describe('Number of hits returned.'),
    cap: z.number().optional().describe('The count cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Agent guidance: the next page to request while more pages remain, the last valid page when the requested page is past the end, or the filters to relax when a first page comes back empty. Absent on the last page of a non-empty result.',
      ),
  },

  async handler(input, ctx) {
    const { dateRange } = input;
    if (dateRange) {
      const { start, end } = dateRange;
      if (!start && !end) {
        throw ctx.fail(
          'invalid_date_range',
          'dateRange has neither a start nor an end bound.',
          ctx.recoveryFor('invalid_date_range'),
        );
      }
      if (start && end && dateBoundToEpochMs(start) >= dateBoundToEpochMs(end)) {
        throw ctx.fail(
          'invalid_date_range',
          `dateRange.start (${start}) is not before dateRange.end (${end}); both bounds are exclusive, so the window holds nothing.`,
          ctx.recoveryFor('invalid_date_range'),
        );
      }
    }

    if (input.minPoints != null && (input.tags === 'comment' || input.tags === 'job')) {
      throw ctx.fail(
        'min_points_unscored_type',
        `minPoints cannot match tags "${input.tags}": ${input.tags} records carry no points, so any minPoints excludes every one.`,
        ctx.recoveryFor('min_points_unscored_type'),
      );
    }

    const filters = appliedFilters(input);
    if (input.query == null && filters.length === 0) {
      throw ctx.fail(
        'missing_query_or_filter',
        'No query and no filter were supplied, so there is nothing to search by.',
        ctx.recoveryFor('missing_query_or_filter'),
      );
    }

    const hn = getHnService();
    const result = await hn.search(input, ctx);

    const includeBody = input.view === 'full';

    const hits = result.hits.map((hit) => {
      const rawText = includeBody ? (hit.comment_text ?? hit.story_text) : undefined;
      const url = normalizeUrl(hit.url);
      const domain = extractDomain(url);
      const highlights = extractHighlights(hit, includeBody);
      return {
        id: Number(hit.objectID),
        title: hit.title ?? undefined,
        url,
        domain,
        author: hit.author,
        points: hit.points ?? undefined,
        numComments: hit.num_comments ?? undefined,
        createdAt: hit.created_at,
        storyTitle: hit.story_title ?? undefined,
        storyId: hit.story_id ?? undefined,
        text: rawText ? stripHtml(rawText) || undefined : undefined,
        ...(highlights && { highlights }),
      };
    });

    ctx.log.info('Search completed', {
      query: input.query,
      hits: hits.length,
      totalHits: result.nbHits,
    });

    const { nbHits: totalHits, nbPages: totalPages, page } = result;
    ctx.enrich({ totalHits, page, totalPages });
    if (hits.length === 0) {
      ctx.enrich.notice(emptyPageNotice(input, filters, page, totalHits, totalPages));
    } else if (page + 1 < totalPages) {
      const raiseCount = input.count < MAX_COUNT ? `, or raise count (max ${MAX_COUNT})` : '';
      ctx.enrich.truncated({
        shown: hits.length,
        cap: input.count,
        guidance: `Showing ${hits.length} of ${totalHits} hits (page ${page} of ${totalPages}). Pass page: ${page + 1} for more${raiseCount}.`,
      });
    }

    return {
      hits,
      ...(input.query != null && { query: input.query }),
    };
  },

  format: (result) => {
    if (result.hits.length === 0) {
      return [
        {
          type: 'text' as const,
          text: result.query != null ? `"${result.query}" — no results.` : 'No results.',
        },
      ];
    }

    /** Render highlight metadata as a `> match: ...` footer. Surfaces each highlights field separately so structured consumers and the LLM both see what matched. */
    const renderHighlights = (hl: {
      title?: string | undefined;
      text?: string | undefined;
      matchedWords: string[];
    }) => {
      const parts: string[] = [];
      if (hl.title) parts.push(`title: ${hl.title}`);
      if (hl.text) parts.push(`body: ${hl.text}`);
      if (hl.matchedWords.length) parts.push(`terms: ${hl.matchedWords.join(', ')}`);
      return parts.length ? `\n> match — ${parts.join(' | ')}` : '';
    };

    const lines = result.hits.map((h) => {
      if (h.title) {
        // Story result — Algolia returns storyId === id for stories, so suppress the parent ref unless it actually differs or a parent title is set.
        const parentRef =
          (h.storyId != null && h.storyId !== h.id) || h.storyTitle
            ? ` | story:"${h.storyTitle ?? '?'}"#${h.storyId ?? '?'}`
            : '';
        const meta = [
          `id:${h.id}`,
          h.author,
          h.points != null ? `${h.points} pts` : null,
          h.numComments != null ? `${h.numComments} comments` : null,
          h.createdAt,
        ]
          .filter(Boolean)
          .join(' | ');
        const domain = h.domain ? ` (${h.domain})` : '';
        const url = h.url ? `\n${h.url}` : '';
        const text = h.text ? `\n${h.text}` : '';
        const hlLine = h.highlights ? renderHighlights(h.highlights) : '';
        return `### ${h.title}${domain}\n${meta}${parentRef}${url}${text}${hlLine}`;
      }
      // Comment result — parent context in heading.
      const meta = [
        `id:${h.id}`,
        h.author,
        h.points != null ? `${h.points} pts` : null,
        h.createdAt,
      ]
        .filter(Boolean)
        .join(' | ');
      const text = h.text ? `\n${h.text}` : '';
      const hlLine = h.highlights ? renderHighlights(h.highlights) : '';
      return `### Comment on "${h.storyTitle ?? 'unknown'}" (story id:${h.storyId ?? '?'})\n${meta}${text}${hlLine}`;
    });

    const header =
      result.query != null
        ? `## "${result.query}" — search results`
        : '## Search results (filters only)';
    return [{ type: 'text' as const, text: `${header}\n\n${lines.join('\n\n')}` }];
  },
});
