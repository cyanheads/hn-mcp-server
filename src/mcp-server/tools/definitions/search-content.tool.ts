/**
 * @fileoverview Search Hacker News via Algolia with filtering and pagination.
 * @module mcp-server/tools/definitions/search-content.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getHnService, normalizeUrl, stripHtml } from '@/services/hn/hn-service.js';

export const searchHn = tool('hn_search_content', {
  description:
    'Search Hacker News stories and comments via Algolia. Supports filtering by content type, author, date range, and minimum points.',
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
          .optional()
          .describe('Start date (ISO 8601). Results created after this date.'),
        end: z
          .string()
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
              .describe('Parent story ID (present for comment results).'),
            text: z.string().optional().describe('Comment or story body text (HTML stripped).'),
          })
          .describe('A single Algolia search hit (story or comment).'),
      )
      .describe('Search results ranked by sort order.'),
    totalHits: z.number().describe('Total matching results across all pages.'),
    page: z.number().describe('Current page number.'),
    totalPages: z.number().describe('Total pages available.'),
    query: z.string().describe('The query that was searched.'),
  }),

  async handler(input, ctx) {
    const hn = getHnService();
    const result = await hn.search(input, ctx);

    const hits = result.hits.map((hit) => {
      const rawText = hit.comment_text ?? hit.story_text;
      return {
        id: Number(hit.objectID),
        title: hit.title ?? undefined,
        url: normalizeUrl(hit.url),
        author: hit.author,
        points: hit.points ?? undefined,
        numComments: hit.num_comments ?? undefined,
        createdAt: hit.created_at,
        storyTitle: hit.story_title ?? undefined,
        storyId: hit.story_id ?? undefined,
        text: rawText ? stripHtml(rawText) || undefined : undefined,
      };
    });

    ctx.log.info('Search completed', {
      query: input.query,
      hits: hits.length,
      totalHits: result.nbHits,
    });

    return {
      hits,
      totalHits: result.nbHits,
      page: result.page,
      totalPages: Math.ceil(result.nbHits / input.count),
      query: input.query,
    };
  },

  format: (result) => {
    if (result.hits.length === 0) {
      return [{ type: 'text' as const, text: `"${result.query}" — no results` }];
    }

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
        const url = h.url ? `\n${h.url}` : '';
        const text = h.text ? `\n${h.text}` : '';
        return `### ${h.title}\n${meta}${parentRef}${url}${text}`;
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
      return `### Comment on "${h.storyTitle ?? 'unknown'}" (story id:${h.storyId ?? '?'})\n${meta}${text}`;
    });

    const header = `## "${result.query}" — ${result.totalHits} results (page ${result.page + 1}/${result.totalPages}, p:${result.page})`;
    return [{ type: 'text' as const, text: `${header}\n\n${lines.join('\n\n')}` }];
  },
});
