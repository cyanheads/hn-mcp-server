/**
 * @fileoverview Search Hacker News via Algolia with filtering and pagination.
 * @module mcp-server/tools/definitions/search-content.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  extractDomain,
  getHnService,
  normalizeUrl,
  stripHtml,
  stripHtmlPreservingEm,
} from '@/services/hn/hn-service.js';
import type { AlgoliaHighlightValue, AlgoliaHit } from '@/services/hn/types.js';

/**
 * Project Algolia's `_highlightResult` into a flat snippet object: the title
 * snippet, the body snippet (preferring comment_text over story_text to match
 * the `text` mapping), and the deduplicated union of matched words across all
 * surfaced fields. Returns undefined when nothing matched.
 */
function extractHighlights(hit: AlgoliaHit) {
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

  const fields = [h.title, h.url, h.author, h.comment_text, h.story_text, h.story_title];
  const matchedWords = Array.from(new Set(fields.flatMap((f) => f?.matchedWords ?? [])));

  if (title == null && textHl == null && matchedWords.length === 0) return;

  return {
    ...(title != null && { title: stripHtmlPreservingEm(title) }),
    ...(textHl && { text: stripHtmlPreservingEm(textHl.value) }),
    matchedWords,
  };
}

export const searchHn = tool('hn_search_content', {
  description:
    'Search Hacker News stories and comments via Algolia. Filterable by content type, author, date range, and minimum points.',
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z
      .string()
      .describe('Search terms. Supports simple keywords — Algolia handles stemming and relevance.'),
    tags: z
      .enum(['story', 'comment', 'ask_hn', 'show_hn', 'front_page'])
      .optional()
      .describe(`Filter results by content type. Omit to search all types.`),
    author: z
      .string()
      .optional()
      .describe(
        `Filter results to a specific author. Useful for finding a user's posts on a topic (hn_get_user only shows recent submissions).`,
      ),
    sort: z
      .enum(['relevance', 'date'])
      .default('relevance')
      .describe('Sort order. "relevance" for best match, "date" for most recent first.'),
    dateRange: z
      .object({
        start: z
          .string()
          .refine((s) => !Number.isNaN(Date.parse(s)), 'Must be a parseable ISO 8601 date')
          .optional()
          .describe('Start date (ISO 8601). Results created after this date.'),
        end: z
          .string()
          .refine((s) => !Number.isNaN(Date.parse(s)), 'Must be a parseable ISO 8601 date')
          .optional()
          .describe('End date (ISO 8601). Results created before this date.'),
      })
      .optional()
      .describe('Filter to a date window. Useful for finding discussions about recent events.'),
    minPoints: z
      .number()
      .min(0)
      .optional()
      .describe('Minimum score/points. Filters out low-engagement content.'),
    count: z.number().min(1).max(50).default(30).describe('Number of results to return.'),
    page: z.number().min(0).default(0).describe('Page number for pagination (0-indexed).'),
  }),
  output: z.object({
    hits: z
      .array(
        z
          .object({
            id: z.number().describe('HN item ID — use with hn_get_thread to read the discussion.'),
            title: z.string().optional().describe('Story title (present for stories).'),
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
            text: z.string().optional().describe('Comment or story body text (HTML stripped).'),
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
                    'Body snippet (comment_text or story_text) with matched terms wrapped in `<em>…</em>`. Absent when the body did not match.',
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
          .describe('A single Algolia search hit (story or comment).'),
      )
      .describe('Search results ranked by sort order.'),
    query: z.string().describe('The query that was searched.'),
  }),

  enrichment: {
    totalHits: z.number().describe('Total matching results across all pages.'),
    page: z.number().describe('Current page number (0-indexed).'),
    totalPages: z.number().describe('Total pages available.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — names the filters applied, for relaxing the search. Absent on non-empty result pages.',
      ),
  },

  async handler(input, ctx) {
    const hn = getHnService();
    const result = await hn.search(input, ctx);

    const hits = result.hits.map((hit) => {
      const rawText = hit.comment_text ?? hit.story_text;
      const url = normalizeUrl(hit.url);
      const domain = extractDomain(url);
      const highlights = extractHighlights(hit);
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

    const totalPages = Math.ceil(result.nbHits / input.count);
    ctx.enrich({ totalHits: result.nbHits, page: result.page, totalPages });

    if (hits.length === 0) {
      const filters: string[] = [];
      if (input.tags) filters.push('tags');
      if (input.author) filters.push('author');
      if (input.minPoints != null) filters.push('minPoints');
      if (input.dateRange) filters.push('dateRange');
      const notice = filters.length
        ? `Try broader keywords, or relax these filters: ${filters.join(', ')}.`
        : `Try broader keywords or different terms.`;
      ctx.enrich.notice(notice);
    }

    return {
      hits,
      query: input.query,
    };
  },

  format: (result) => {
    if (result.hits.length === 0) {
      return [{ type: 'text' as const, text: `"${result.query}" — no results.` }];
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

    const header = `## "${result.query}" — search results`;
    return [{ type: 'text' as const, text: `${header}\n\n${lines.join('\n\n')}` }];
  },
});
