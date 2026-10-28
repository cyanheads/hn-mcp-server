/**
 * @fileoverview Search Hacker News via Algolia with filtering and pagination.
 * @module mcp-server/tools/definitions/search-content.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  escapeHighlight,
  escapeInline,
  escapeQuoted,
  quoteBody,
} from '@/mcp-server/tools/markdown-escape.js';
import {
  byteLength,
  cutPointer,
  cutToBytes,
  fitsBudget,
  largestFittingLimit,
  measureResponse,
  RESPONSE_BUDGET_TEXT,
} from '@/mcp-server/tools/response-budget.js';
import { servedAtCap } from '@/mcp-server/tools/served-at-cap.js';
import {
  dateBoundToEpochMs,
  dateRangeToEpochSeconds,
  decodeHtmlEntities,
  extractDomain,
  getHnService,
  normalizeUrl,
  stripHtml,
  stripHtmlPreservingEm,
} from '@/services/hn/hn-service.js';
import type { AlgoliaHighlightValue, AlgoliaHit } from '@/services/hn/types.js';

/** Most hits one call serves; a larger `count` is served at this cap. */
const COUNT_CAP = 50;

/** Largest `count` accepted; anything above it is rejected. */
const COUNT_CEILING = 1000;

/**
 * The recovery for a first hit no page of 50 begins on: the largest count up to
 * the cap whose pages include one starting at that hit, so a caller can resume
 * from exactly there. When that count is under half the cap, covering a cap's
 * worth of hits from there takes three or more calls where pages of 50 take
 * two, so the page of 50 holding the hit is named as well.
 */
function unalignedHint(firstHit: number): string {
  let size = COUNT_CAP;
  while (firstHit % size !== 0) size--;
  const exact = `Pass count: ${size}, page: ${firstHit / size} to start at the same hit`;
  if (size * 2 >= COUNT_CAP) return `${exact}.`;
  const page = Math.floor(firstHit / COUNT_CAP);
  const start = page * COUNT_CAP;
  return `${exact}, or count: ${COUNT_CAP}, page: ${page} for hits ${start}–${start + COUNT_CAP - 1}, which include hit ${firstHit}.`;
}

/** Algolia serves at most this many hits per search, however many match. */
const HIT_CEILING = 1000;

/** The content types `tags` accepts. */
const SEARCH_TAGS = ['story', 'comment', 'poll', 'job', 'ask_hn', 'show_hn', 'front_page'] as const;

/** The item types a hit's `_tags` can name. `ask_hn`, `show_hn`, and `front_page` are further tags on a story. */
const HIT_TYPES = ['story', 'comment', 'poll', 'pollopt', 'job'] as const;

type HitType = (typeof HIT_TYPES)[number];

/**
 * The first `_tags` entry that names an item type, or undefined when none does.
 * The first match, not the first entry, so a reordered tag list cannot mistype
 * a hit. A poll option's `story_<id>` tag, where present, names the option
 * itself, so no parent is read from it.
 */
function hitType(tags: readonly string[] | undefined): HitType | undefined {
  return tags?.find((tag): tag is HitType => (HIT_TYPES as readonly string[]).includes(tag));
}

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

/** A URL's scheme and `www.`, or a bare leading `www.`. Anchored, so it reads a fixed-length prefix at most. */
const URL_PREFIX = /^(?:https?:\/\/(?:www\.)?|www\.)/i;

/**
 * Drop the scheme and `www.` from a query that is a URL alone. Algolia requires
 * every token, so `https` and `www` would otherwise have to appear in the
 * submitted URL, and the same page submitted under the other scheme or without
 * `www.` would drop out. A query with whitespace is searched as typed, and so
 * is one the prefix would leave empty.
 */
export function stripUrlPrefix(query: string): { query: string; droppedPrefix?: string } {
  if (/\s/.test(query)) return { query };
  const prefix = URL_PREFIX.exec(query)?.[0];
  if (prefix == null || prefix.length === query.length) return { query };
  return { query: query.slice(prefix.length), droppedPrefix: prefix };
}

/** The search as run: the filters set, then sort, count, and view with their defaults. */
const searchCriteria = z
  .object({
    tags: z.enum(SEARCH_TAGS).optional().describe('Content-type filter.'),
    author: z.string().optional().describe('Author filter — the username matched, trimmed.'),
    storyId: z.number().optional().describe('Discussion filter: a story or poll root id.'),
    minPoints: z.number().optional().describe('Minimum score.'),
    dateRange: z
      .object({
        start: z
          .string()
          .optional()
          .describe(
            'Items match only when created strictly after this instant: the start bound in ISO 8601 UTC, rounded down to the whole second.',
          ),
        end: z
          .string()
          .optional()
          .describe(
            'Items match only when created strictly before this instant: the end bound in ISO 8601 UTC, rounded up to the whole second.',
          ),
      })
      .optional()
      .describe('Creation-time window as applied, with only the bounds that were set.'),
    sort: z.enum(['relevance', 'date']).describe('Sort order used.'),
    count: z
      .number()
      .describe('Hits per page sent: count as passed, or 50 when count was above that cap.'),
    view: z.enum(['full', 'compact']).describe('Projection applied to each hit.'),
  })
  .describe(
    'The criteria this search ran with: each filter that was set, as sent — author trimmed, dateRange bounds as the exclusive UTC instants applied — then sort, count, and view, defaults included. Unset filters are absent. The searched query is in query.',
  );

type SearchCriteria = z.infer<typeof searchCriteria>;

/** A whole Unix second as ISO 8601 UTC, e.g. `2024-05-05T08:00:00Z`. */
const isoSeconds = (seconds: number) =>
  new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

/** One trailer line for the criteria; `author`, the one free-text value, is escaped inside its quotes. */
function renderCriteria(c: SearchCriteria): string {
  const bounds = c.dateRange && [
    c.dateRange.start != null ? `after ${c.dateRange.start}` : null,
    c.dateRange.end != null ? `before ${c.dateRange.end}` : null,
  ];
  const parts = [
    c.tags != null ? `tags: ${c.tags}` : null,
    c.author != null ? `author: "${escapeQuoted(c.author)}"` : null,
    c.storyId != null ? `storyId: ${c.storyId}` : null,
    c.minPoints != null ? `minPoints: ${c.minPoints}` : null,
    bounds ? `dateRange: ${bounds.filter(Boolean).join(', ')}` : null,
    `sort: ${c.sort}`,
    `count: ${c.count}`,
    `view: ${c.view}`,
  ];
  return `**criteria:** ${parts.filter(Boolean).join(' | ')}`;
}

/** The filters a caller set, in the order notices name them. `sort`, `count`, `page`, and `view` are not filters. */
function appliedFilters(
  input: Pick<SearchNoticeFacts, 'tags' | 'author' | 'storyId' | 'minPoints' | 'dateRange'>,
): string[] {
  const filters: string[] = [];
  if (input.tags) filters.push('tags');
  if (input.author) filters.push('author');
  if (input.storyId != null) filters.push('storyId');
  if (input.minPoints != null) filters.push('minPoints');
  if (input.dateRange?.start || input.dateRange?.end) filters.push('dateRange');
  return filters;
}

/** What the search notice is composed from: the inputs as searched, and the page Algolia returned. */
export interface SearchNoticeFacts {
  author?: string | undefined;
  /** How a full page over the response budget was fitted to it; absent for a page that fit. */
  budget?: SearchBudget | undefined;
  count: number;
  dateRange?: { start?: string | undefined; end?: string | undefined } | undefined;
  /** The URL prefix dropped from the caller's query before searching. */
  droppedPrefix?: string | undefined;
  minPoints?: number | undefined;
  /**
   * The caller's count and page when count was above the per-call cap. The
   * search then ran at `count` (the cap) and `page` (the page at the cap where
   * the requested page starts), which the other facts describe.
   */
  overCap?: { count: number; page: number } | undefined;
  page: number;
  /** The query sent to Algolia; absent for a filter-only search. */
  query?: string | undefined;
  /** Hits on this page. */
  shown: number;
  storyId?: number | undefined;
  tags?: string | undefined;
  totalHits: number;
  /** False when totalHits is an estimate; undefined when Algolia does not say. */
  totalHitsExact?: boolean | undefined;
  totalPages: number;
}

/**
 * The page-state sentence. A non-empty page names the next page while more
 * remain, and the last page of a search matching more than Algolia serves names
 * that ceiling. An empty page past the end names the last valid page when
 * Algolia reports one; past the ceiling Algolia answers `nbPages: 0`, so the
 * last page is unknown and the notice resets to page 0. Only a first page with
 * no hits is a zero-match search, which names what to relax. After a count
 * above the cap, a page lever also names the count it counts in.
 */
function pageStateSentence(facts: SearchNoticeFacts): string | undefined {
  const { shown, page, totalHits, totalPages } = facts;
  const pageLever = (n: number) => `${facts.overCap ? `count: ${facts.count}, ` : ''}page: ${n}`;
  if (shown > 0) {
    const total = `${facts.totalHitsExact === false ? 'about ' : ''}${totalHits}`;
    if (page + 1 < totalPages) {
      const raiseCount = facts.count < COUNT_CAP ? `, or raise count (max ${COUNT_CAP})` : '';
      return `Showing ${shown} of ${total} hits (page ${page} of ${totalPages}). Pass ${pageLever(page + 1)} for more${raiseCount}.`;
    }
    return totalHits > HIT_CEILING
      ? `Page ${page} is the last page Algolia serves: a search returns at most 1,000 of its matches, and this one matches ${total}. Split it into narrower dateRange windows to reach the rest.`
      : undefined;
  }
  if (page > 0) {
    if (totalPages === 0) {
      return `Page ${page} is past the last page Algolia serves for this search (at most 1,000 hits per search), where totalHits and totalPages read 0. Pass page: 0 to start over; if that also returns nothing, the search itself matches nothing.`;
    }
    /** With one page, the last page is page 0, so one lever covers both. */
    const lever =
      totalPages === 1
        ? `Pass ${pageLever(0)} for that page.`
        : `Pass ${pageLever(totalPages - 1)} for the last page, or page: 0 to start over.`;
    return `Page ${page} is past the last page of results (${totalHits} hits across ${totalPages} page${totalPages === 1 ? '' : 's'}). ${lever}`;
  }
  const filters = appliedFilters(facts);
  if (facts.query == null) {
    return `No items matched these filters: ${filters.join(', ')}. Relax or change them.`;
  }
  return filters.length
    ? `Try broader keywords, or relax these filters: ${filters.join(', ')}.`
    : 'Try broader keywords or different terms.';
}

/**
 * Sentences an input calls for, in input order: query, tags, author, storyId,
 * then count when it was above the per-call cap — said when hits remain past
 * the served page, or when the served page is numbered differently from the
 * one requested.
 */
function causeSentences(facts: SearchNoticeFacts): string[] {
  const emptyFirstPage = facts.shown === 0 && facts.page === 0;
  const sentences: string[] = [];
  if (facts.droppedPrefix != null) {
    sentences.push(
      `The leading \`${facts.droppedPrefix}\` was dropped from the query, so the URL matches submissions under either scheme, with or without www.`,
    );
    if (emptyFirstPage) {
      sentences.push(
        'Submissions often omit #fragments and tracking parameters such as utm_source; search the URL without them.',
      );
    }
  }
  if (
    facts.tags === 'front_page' &&
    (emptyFirstPage || facts.dateRange?.start || facts.dateRange?.end)
  ) {
    sentences.push(
      'front_page matches only the stories on the HN front page right now (about 30), never past front pages; for an earlier window, search tags "story" with dateRange and minPoints instead.',
    );
  }
  if (emptyFirstPage && facts.author) {
    sentences.push(
      "author must match the username's exact HN casing; hn_get_user answers user_not_found for a mis-cased name.",
    );
  }
  if (emptyFirstPage && facts.storyId != null) {
    sentences.push(
      "storyId must be a story or poll root id — take it from hits[].storyId, a poll hit's own id (poll hits carry no storyId), or hn_get_thread: the root item's id, or its item.storyId when the root is a comment. A comment id matches nothing.",
    );
  }
  const { overCap } = facts;
  const morePages = facts.shown > 0 && facts.page + 1 < facts.totalPages;
  if (overCap && (morePages || overCap.page > 0)) {
    sentences.push(servedAtCap('count', overCap.count, facts.count));
    if (overCap.page > 0) {
      sentences.push(
        `Page ${overCap.page} at count ${overCap.count} starts at the same hit as page ${facts.page} at count ${facts.count}, the page served.`,
      );
    }
  }
  return sentences;
}

/** The two steps that fit a full page over the response budget to it. */
interface SearchBudget {
  /** Ids of the hits step 2 cut the text of, in page order; empty when step 1 sufficed. */
  cutIds: readonly number[];
  /** Step 1 dropped highlights.text from every hit. False when no hit carried one. */
  highlightsTextOmitted: boolean;
}

/** The sentence disclosing how the page was fitted to the response budget. */
function budgetSentence({ highlightsTextOmitted, cutIds }: SearchBudget): string {
  const budget = `To stay within the ${RESPONSE_BUDGET_TEXT}-byte response budget,`;
  const omitted = 'highlights.text is omitted from every hit';
  if (cutIds.length === 0)
    return `${budget} ${omitted}; matchedWords still lists the matched terms.`;
  const cut = `the text of ${cutIds.length === 1 ? 'hit' : 'hits'} ${cutIds.join(', ')} is cut short`;
  return `${budget} ${highlightsTextOmitted ? `${omitted} and ` : ''}${cut}; hn_get_thread with a cut hit's id returns its full text, and view: "compact" or a smaller count avoids the cut.`;
}

/**
 * Compose the one `notice` string every search writes. `notice` is last-wins,
 * so each source goes through here: the page-state sentence first, then the
 * cause sentences in input order — query, tags, author, storyId, count — then
 * the budget sentence for a page fitted to the response budget. None replaces
 * another. Undefined when nothing applies — the last page of an uncapped,
 * non-empty search that fit.
 */
export function composeSearchNotice(facts: SearchNoticeFacts): string | undefined {
  const sentences = [
    pageStateSentence(facts),
    ...causeSentences(facts),
    facts.budget && budgetSentence(facts.budget),
  ].filter((sentence) => sentence != null);
  return sentences.length > 0 ? sentences.join(' ') : undefined;
}

/**
 * Entity-decode a title highlight between its `<em>` markers. A decoded
 * `&lt;em&gt;` then reads as a marker, which the `highlights.title`
 * description discloses.
 */
function decodeHighlightTitle(title: string): string {
  return title
    .split(/(<\/?em>)/)
    .map((part, i) => (i % 2 === 1 ? part : decodeHtmlEntities(part)))
    .join('');
}

/**
 * Project Algolia's `_highlightResult` into a flat object: the title snippet,
 * the body highlight — the whole matched body with markers, not a snippet
 * (comment_text, else story_text — the order `text` reads them in; a job's
 * job_text is never highlighted) — and the deduplicated
 * union of matched words across all surfaced fields. Returns undefined when
 * nothing matched.
 *
 * Titles are not HTML, though some arrive entity-encoded (`&lt;details&gt;`,
 * `&#34;`), so the title snippet is entity-decoded between its `<em>` markers
 * and never tag-stripped. The body highlight, the whole matched body, is
 * stripped of its HTML with the markers kept.
 *
 * `includeBody` is false under the compact projection, and on a full page over
 * the response budget, both of which drop the body highlight — the field that
 * repeats a hit's full body text.
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
    ...(title != null && { title: decodeHighlightTitle(title) }),
    ...(text != null && { text }),
    matchedWords,
  };
}

const searchHit = z
  .object({
    id: z.number().describe('HN item ID — use with hn_get_thread to read the discussion.'),
    type: z
      .enum(HIT_TYPES)
      .optional()
      .describe(
        'Item type: story (Ask HN, Show HN, and front-page stories included), comment, poll, pollopt (one option of a poll), or job. Absent when the search record names no type.',
      ),
    title: z.string().optional().describe('Item title (present for stories, polls, and jobs).'),
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
    storyTitle: z.string().optional().describe('Parent story title (present for comment results).'),
    storyId: z
      .number()
      .optional()
      .describe(
        "Parent story ID for comment hits; equals `id` for story hits. Absent for polls, poll options, and jobs — a poll's own `id` is its discussion root.",
      ),
    text: z
      .string()
      .optional()
      .describe(
        `Body text, HTML stripped: a comment's text, a text post's body, or a job's description. A job description is returned but not keyword-searched or highlighted. Cut short when the page would otherwise exceed the ${RESPONSE_BUDGET_TEXT}-byte response budget, with textTruncated set. Absent when the hit has no body, and always absent under view "compact" — call hn_get_thread with this id to read it.`,
      ),
    textTruncated: z
      .boolean()
      .optional()
      .describe(
        `True when text is a prefix of the body, cut short to keep the page within the ${RESPONSE_BUDGET_TEXT}-byte response budget — hn_get_thread with this id returns it whole. Absent when text is whole.`,
      ),
    highlights: z
      .object({
        title: z
          .string()
          .optional()
          .describe(
            'Title snippet with matched terms wrapped in `<em>…</em>`. Titles are not HTML, though some arrive entity-encoded; entities are decoded and no tags are stripped, so a literal `<em>` in the title is indistinguishable from a marker. Absent when the title did not match.',
          ),
        text: z
          .string()
          .optional()
          .describe(
            'The matched body in full, not a snippet (comment_text or story_text), HTML stripped, with matched terms wrapped in `<em>…</em>` — the same text as `text` plus its markers. A literal `<em>` typed into the body is indistinguishable from a marker. Absent when the body did not match, when highlightsTextOmitted is true, and always under view "compact" — matchedWords still lists what matched.',
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
  .describe('A single Algolia search hit (story, comment, poll, poll option, or job).');

type SearchHit = z.infer<typeof searchHit>;

/**
 * Project an Algolia hit into a search hit. `text` carries its body; under
 * `bodyHighlight` its highlights carry the body too — the matched body in full,
 * with markers.
 */
function projectHit(hit: AlgoliaHit, text: boolean, bodyHighlight: boolean): SearchHit {
  const rawText = text ? (hit.comment_text ?? hit.story_text ?? hit.job_text) : undefined;
  const url = normalizeUrl(hit.url);
  const domain = extractDomain(url);
  const highlights = extractHighlights(hit, bodyHighlight);
  const type = hitType(hit._tags);
  return {
    id: Number(hit.objectID),
    ...(type && { type }),
    title: hit.title != null ? decodeHtmlEntities(hit.title) : undefined,
    url,
    domain,
    author: hit.author,
    points: hit.points ?? undefined,
    numComments: hit.num_comments ?? undefined,
    createdAt: hit.created_at,
    storyTitle: hit.story_title != null ? decodeHtmlEntities(hit.story_title) : undefined,
    storyId: hit.story_id ?? undefined,
    text: rawText ? stripHtml(rawText) || undefined : undefined,
    ...(highlights && { highlights }),
  };
}

const searchOutput = z.object({
  hits: z.array(searchHit).describe('Search results ranked by sort order.'),
  query: z
    .string()
    .optional()
    .describe(
      'The query that was searched — for a URL query, without its leading scheme and www. Absent for a filter-only search.',
    ),
});

type SearchOutput = z.infer<typeof searchOutput>;

const searchTrailer = {
  criteria: { render: renderCriteria },
};

/**
 * Render highlight metadata as a `> match — …` footer, surfacing each highlights
 * field separately so structured consumers and the LLM both see what matched.
 * The footer follows an unquoted blank line, which a quoted body never
 * produces, so a body line reading `match — …` cannot pass for it. The
 * matched body comes last and continues on quoted lines of its own.
 */
function renderHighlights(hl: NonNullable<SearchHit['highlights']>): string {
  const parts: string[] = [];
  if (hl.title) parts.push(`title: ${escapeHighlight(hl.title)}`);
  if (hl.matchedWords.length) parts.push(`terms: ${hl.matchedWords.join(', ')}`);
  if (hl.text) parts.push(`body: ${hl.text}`);
  return parts.length ? `\n\n${quoteBody(`match — ${parts.join(' | ')}`)}` : '';
}

/** A hit's quoted body, and after a cut body the unquoted pointer to the whole text, a blank line apart. */
function renderBody(h: SearchHit): string {
  const text = h.text ? `\n${quoteBody(h.text)}` : '';
  return h.textTruncated ? `${text}\n\n${cutPointer(h.id)}` : text;
}

function formatSearch(result: SearchOutput) {
  if (result.hits.length === 0) {
    return [
      {
        type: 'text' as const,
        text:
          result.query != null ? `"${escapeQuoted(result.query)}" — no results.` : 'No results.',
      },
    ];
  }

  const lines = result.hits.map((h) => {
    const typeToken = h.type ? `type:${h.type}` : null;
    const hlLine = h.highlights ? renderHighlights(h.highlights) : '';
    if (h.type === 'pollopt') {
      // A poll option's search record carries no text and no poll; hn_get_thread has both.
      const meta = [
        `id:${h.id}`,
        typeToken,
        h.author,
        h.points != null ? `${h.points} pts` : null,
        h.createdAt,
      ]
        .filter(Boolean)
        .join(' | ');
      return `### Poll option by ${h.author}\n${meta}\nOption text and its poll: hn_get_thread with itemId ${h.id}${hlLine}`;
    }
    if (h.title) {
      // Story result — Algolia returns storyId === id for stories, so suppress the parent ref unless it actually differs or a parent title is set.
      const parentRef =
        (h.storyId != null && h.storyId !== h.id) || h.storyTitle
          ? ` | story:"${escapeQuoted(h.storyTitle ?? '?')}"#${h.storyId ?? '?'}`
          : '';
      const meta = [
        `id:${h.id}`,
        typeToken,
        h.author,
        h.points != null ? `${h.points} pts` : null,
        h.numComments != null ? `${h.numComments} comments` : null,
        h.createdAt,
      ]
        .filter(Boolean)
        .join(' | ');
      const domain = h.domain ? ` (${h.domain})` : '';
      const url = h.url ? `\n${h.url}` : '';
      return `### ${escapeInline(h.title)}${domain}\n${meta}${parentRef}${url}${renderBody(h)}${hlLine}`;
    }
    // Comment result — parent context in heading.
    const meta = [
      `id:${h.id}`,
      typeToken,
      h.author,
      h.points != null ? `${h.points} pts` : null,
      h.createdAt,
    ]
      .filter(Boolean)
      .join(' | ');
    return `### Comment on "${escapeQuoted(h.storyTitle ?? 'unknown')}" (story id:${h.storyId ?? '?'})\n${meta}${renderBody(h)}${hlLine}`;
  });

  const header =
    result.query != null
      ? `## "${escapeQuoted(result.query)}" — search results`
      : '## Search results (filters only)';
  return [{ type: 'text' as const, text: `${header}\n\n${lines.join('\n\n')}` }];
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
      reason: 'count_page_unaligned',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'count was above the per-call cap of 50 with a page whose first hit (page × count) begins no page of 50 hits, so the requested page cannot be served from its start at the cap.',
      recovery:
        'Pass a count of 50 or less with page counted in that count; the error names a count and page that start at the same hit and, when that count is under 25, the page of 50 that holds the hit.',
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
        'Search terms. Supports simple keywords — Algolia handles stemming and relevance, and a hit must contain every term. Matching is typo-tolerant and the last term also matches as a prefix (zig matches Zigbee); wrap a term in double quotes to match it exactly ("zig"), or put - before one to exclude it ("zig" -devlog). Trimmed before searching; blank or whitespace-only input is rejected. To find discussions of a page, pass its URL alone: a query with no spaces that starts with http://, https://, or www. is searched without that prefix, so submissions under either scheme, with or without www., all match. Omit for a filter-only search, which needs at least one of tags, author, storyId, minPoints, or a dateRange bound.',
      ),
    tags: z
      .enum(SEARCH_TAGS)
      .optional()
      .describe(
        'Filter results by content type: "story", "comment", "poll", or "job", or the story subsets "ask_hn", "show_hn", and "front_page". "front_page" is the HN front page right now (about 30 stories); no filter selects stories from past front pages. The nearest proxy is "story" with dateRange and minPoints — without a query, the default relevance sort ranks by points. Omit to search all types, which also returns poll options (type "pollopt"): records with only an id, author, vote count, and date — hn_get_thread reads an option\'s text and poll.',
      ),
    author: z
      .string()
      .trim()
      .min(1, 'blank after trimming whitespace — omit author to search all authors.')
      .optional()
      .describe(
        `Filter results to a specific author — useful for finding a user's posts on a topic. Matches the HN username exactly and is case-sensitive, so a re-cased name finds nothing. Trimmed before filtering; omit the field to search all authors rather than passing a blank string.`,
      ),
    storyId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Restrict results to one discussion: the id of a story or poll root, combined with the other filters. Pair with tags "comment" to search within a thread. Take it from hits[].storyId, from a poll hit\'s own id (poll hits carry no storyId), or from hn_get_thread — the root item\'s id, or its item.storyId when the root is a comment. A comment id matches nothing.',
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
      .max(COUNT_CEILING)
      .default(30)
      .describe(
        `Number of results to return, at most ${COUNT_CAP} per call. A larger value is served at ${COUNT_CAP}: the search runs at count ${COUNT_CAP} from the hit where the requested page starts, and the notice names the count and page to pass next. With page above 0, that hit (page × count) must begin a page of ${COUNT_CAP} hits.`,
      ),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number for pagination (0-indexed), counted in pages of count results.'),
    view: z
      .enum(['full', 'compact'])
      .default('full')
      .describe(
        `How much of each hit to return. "full" includes every field, within a ${RESPONSE_BUDGET_TEXT}-byte budget on each response surface: a page over it drops highlights.text from every hit (highlightsTextOmitted), and if still over, cuts the longest text bodies to one shared length (textTruncated) — every hit stays on the page. "compact" omits the two body-text fields — \`text\` and \`highlights.text\` — which together can repeat a long comment twice per hit; everything else (id, title, url, domain, author, points, comment count, timestamp, parent story, title highlight, matchedWords) is unchanged. Use "compact" to scan many results, then pass a hit id to hn_get_thread to read the body you skipped.`,
      ),
  }),
  output: searchOutput,

  enrichment: {
    criteria: searchCriteria,
    totalHits: z
      .number()
      .describe(
        'Matching results across all pages, as Algolia counts them. An estimate when totalHitsExact is false — broad searches can be off by orders of magnitude — and paging reaches only the first 1,000 (see reachableHits).',
      ),
    totalHitsExact: z
      .boolean()
      .optional()
      .describe(
        'True when totalHits is an exact count, false when it is an estimate, as it is for keyword searches and broad filter-only searches. Absent when Algolia does not say, and on a page past the 1,000-hit ceiling, where totalHits reads 0.',
      ),
    page: z
      .number()
      .describe(
        'Current page number (0-indexed), in pages of criteria.count hits. When count was above the per-call cap, the page of 50 where the requested page starts.',
      ),
    totalPages: z
      .number()
      .describe(
        'Number of pages of criteria.count hits Algolia will actually serve for this query, covering at most the first 1,000 hits. Not derived from totalHits — broad queries report a totalHits far larger than the reachable page range, so paginate against this value.',
      ),
    reachableHits: z
      .number()
      .optional()
      .describe(
        'How many of totalHits paging can reach: Algolia serves at most 1,000 hits per search. Present only when totalHits exceeds that; split the search into narrower dateRange windows to reach the rest.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more pages remain after this one (page + 1 < totalPages). Absent on the last page Algolia serves.',
      ),
    shown: z.number().optional().describe('Number of hits returned.'),
    cap: z
      .number()
      .optional()
      .describe(
        `The count value served: as passed, or ${COUNT_CAP} when count was above that cap.`,
      ),
    highlightsTextOmitted: z
      .boolean()
      .optional()
      .describe(
        `True when highlights.text was dropped from every hit to keep this view "full" page within the ${RESPONSE_BUDGET_TEXT}-byte response budget; highlights.title and matchedWords remain. Absent otherwise.`,
      ),
    notice: z
      .string()
      .optional()
      .describe(
        `Agent guidance, one string. It opens with the page state: the next page to request while more pages remain, the 1,000-hit ceiling on the last page of a search that matches more, the last valid page when the requested page is past the end, or the filters to relax when a first page comes back empty. Notes on the inputs follow it, then, on a view "full" page fitted to the ${RESPONSE_BUDGET_TEXT}-byte response budget, a sentence naming what was omitted and the ids of hits whose text was cut. Absent when none applies.`,
      ),
  },
  enrichmentTrailer: searchTrailer,

  async handler(input, ctx) {
    const { dateRange } = input;
    if (dateRange) {
      const { start, end } = dateRange;
      if (!start && !end) {
        throw ctx.fail('invalid_date_range', 'dateRange has neither a start nor an end bound.');
      }
      if (start && end && dateBoundToEpochMs(start) >= dateBoundToEpochMs(end)) {
        throw ctx.fail(
          'invalid_date_range',
          `dateRange.start (${start}) is not before dateRange.end (${end}); both bounds are exclusive, so the window holds nothing.`,
        );
      }
    }

    if (input.minPoints != null && (input.tags === 'comment' || input.tags === 'job')) {
      throw ctx.fail(
        'min_points_unscored_type',
        `minPoints cannot match tags "${input.tags}": ${input.tags} records carry no points, so any minPoints excludes every one.`,
      );
    }

    const filters = appliedFilters(input);
    if (input.query == null && filters.length === 0) {
      throw ctx.fail(
        'missing_query_or_filter',
        'No query and no filter were supplied, so there is nothing to search by.',
      );
    }

    /** Above the cap, the search runs at the cap from the hit where the requested page starts. */
    const overCap = input.count > COUNT_CAP ? { count: input.count, page: input.page } : undefined;
    const firstHit = input.page * input.count;
    if (overCap && firstHit % COUNT_CAP !== 0) {
      throw ctx.fail(
        'count_page_unaligned',
        `count ${input.count} is above the per-call cap of ${COUNT_CAP}, and page ${input.page} at count ${input.count} starts after ${firstHit} hits, where no page of ${COUNT_CAP} hits begins.`,
        { count: input.count, page: input.page, recovery: { hint: unalignedHint(firstHit) } },
      );
    }

    const searched = input.query == null ? undefined : stripUrlPrefix(input.query);
    const params = {
      ...input,
      ...(searched && { query: searched.query }),
      ...(overCap && { count: COUNT_CAP, page: firstHit / COUNT_CAP }),
    };
    const hn = getHnService();
    const result = await hn.search(params, ctx);

    const includeBody = input.view === 'full';
    const hits = result.hits.map((hit) => projectHit(hit, includeBody, includeBody));

    ctx.log.info('Search completed', {
      query: params.query,
      hits: hits.length,
      totalHits: result.nbHits,
    });

    const { nbHits: totalHits, nbPages: totalPages, page } = result;
    const shown = hits.length;
    /** Past the ceiling Algolia flags its 0 as exact, though it says nothing about the search. */
    const pastCeiling = shown === 0 && page > 0 && totalPages === 0;
    const totalHitsExact = pastCeiling
      ? undefined
      : (result.exhaustive?.nbHits ?? result.exhaustiveNbHits);
    const bounds = params.dateRange ? dateRangeToEpochSeconds(params.dateRange) : {};
    const pageFields = {
      criteria: {
        ...(params.tags != null && { tags: params.tags }),
        ...(params.author != null && { author: params.author }),
        ...(params.storyId != null && { storyId: params.storyId }),
        ...(params.minPoints != null && { minPoints: params.minPoints }),
        ...((bounds.start != null || bounds.end != null) && {
          dateRange: {
            ...(bounds.start != null && { start: isoSeconds(bounds.start) }),
            ...(bounds.end != null && { end: isoSeconds(bounds.end) }),
          },
        }),
        sort: params.sort,
        count: params.count,
        view: params.view,
      },
      totalHits,
      ...(totalHitsExact != null && { totalHitsExact }),
      page,
      totalPages,
      ...(totalHits > HIT_CEILING && { reachableHits: HIT_CEILING }),
    };
    const morePages = shown > 0 && page + 1 < totalPages;
    const noticeFacts: SearchNoticeFacts = {
      ...params,
      droppedPrefix: searched?.droppedPrefix,
      shown,
      page,
      totalHits,
      totalHitsExact,
      totalPages,
      overCap,
    };

    /** The response serving `served`, with the notice and flag for how `budget` fitted it. */
    const respond = (served: SearchHit[], budget?: SearchBudget) => ({
      output: { hits: served, ...(params.query != null && { query: params.query }) },
      notice: composeSearchNotice({ ...noticeFacts, budget }),
      highlightsTextOmitted: budget?.highlightsTextOmitted === true,
    });

    /** Both surfaces of a response as the caller receives it, enrichment and trailer included. */
    const measure = (response: ReturnType<typeof respond>) =>
      measureResponse({
        content: formatSearch(response.output),
        result: response.output,
        enrichment: {
          ...pageFields,
          ...(response.highlightsTextOmitted && { highlightsTextOmitted: true }),
          ...(morePages && { truncated: true, shown, cap: params.count }),
          ...(response.notice != null && { notice: response.notice }),
        },
        trailer: searchTrailer,
      });

    let response = respond(hits);
    if (includeBody && !fitsBudget(measure(response))) {
      /** Step 1: drop the body highlight, which repeats the matched body in full, from every hit. */
      const highlightsTextOmitted = hits.some((hit) => hit.highlights?.text != null);
      const lean = highlightsTextOmitted
        ? result.hits.map((hit) => projectHit(hit, true, false))
        : hits;
      if (highlightsTextOmitted) response = respond(lean, { highlightsTextOmitted, cutIds: [] });
      if (!highlightsTextOmitted || !fitsBudget(measure(response))) {
        /** Step 2: cut every body longer than the largest limit they can share. */
        const bodies = lean.map((hit) => ({ hit, bytes: hit.text ? byteLength(hit.text) : 0 }));
        const cutAt = (limit: number) => {
          const served = bodies.map(({ hit, bytes }) =>
            hit.text && bytes > limit
              ? { ...hit, text: cutToBytes(hit.text, limit), textTruncated: true }
              : hit,
          );
          const cutIds = served.filter((hit) => hit.textTruncated).map((hit) => hit.id);
          return respond(served, { highlightsTextOmitted, cutIds });
        };
        const limit = largestFittingLimit(
          bodies.map((body) => body.bytes),
          (limitBytes) => measure(cutAt(limitBytes)),
        );
        response = cutAt(limit);
        ctx.log.info('Fitted search page to the response budget', {
          limitBytes: limit,
          cutIds: response.output.hits.filter((hit) => hit.textTruncated).map((hit) => hit.id),
        });
      }
    }

    ctx.enrich({
      ...pageFields,
      ...(response.highlightsTextOmitted && { highlightsTextOmitted: true }),
    });
    if (morePages) ctx.enrich.truncated({ shown, cap: params.count });
    if (response.notice) ctx.enrich.notice(response.notice);

    return response.output;
  },

  format: formatSearch,
});
