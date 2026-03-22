/**
 * @fileoverview Fetch stories from an HN feed with batch resolution.
 * @module mcp-server/tools/definitions/get-stories.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  filterLiveItems,
  getHnService,
  normalizeUrl,
  stripHtml,
} from '@/services/hn/hn-service.js';

export const getStories = tool('get_stories', {
  description:
    'Fetch stories from an HN feed (top, new, best, ask, show, jobs). Returns enriched story objects with title, URL, score, author, and comment count.',
  annotations: { readOnlyHint: true },
  input: z.object({
    feed: z
      .enum(['top', 'new', 'best', 'ask', 'show', 'jobs'])
      .describe(
        'Which HN feed to fetch. "top" includes jobs. "ask" and "show" are Ask HN / Show HN posts.',
      ),
    count: z
      .number()
      .min(1)
      .max(100)
      .default(30)
      .describe(
        'Number of stories to return. Each story is fetched individually — larger counts take longer.',
      ),
    offset: z
      .number()
      .min(0)
      .default(0)
      .describe(
        'Number of stories to skip from the start of the feed. Use with count for pagination.',
      ),
  }),
  output: z.object({
    stories: z
      .array(
        z.object({
          id: z.number().describe('Item ID — use with get_thread to read comments.'),
          title: z.string().describe('Story title.'),
          url: z.string().optional().describe('External link URL. Absent for Ask HN / text posts.'),
          score: z.number().describe('Upvote count.'),
          by: z.string().describe('Author username.'),
          time: z.number().describe('Unix timestamp.'),
          descendants: z.number().optional().describe('Total comment count. Absent for jobs.'),
          text: z
            .string()
            .optional()
            .describe('Body text for Ask HN / text posts. Use get_thread for full discussion.'),
          type: z.string().describe('Item type (story, job).'),
        }),
      )
      .describe('Stories from the feed, ordered by HN ranking.'),
    feed: z.string().describe('Which feed was fetched.'),
    total: z
      .number()
      .describe('Total items in the feed (up to 500 for top/new/best, 200 for ask/show/jobs).'),
    offset: z.number().describe('Offset used.'),
    hasMore: z.boolean().describe('Whether more stories are available beyond this page.'),
  }),

  async handler(input, ctx) {
    const hn = getHnService();
    const feedIds = await hn.fetchFeed(input.feed);
    const sliced = feedIds.slice(input.offset, input.offset + input.count);
    const rawItems = await hn.fetchItems(sliced);
    const items = filterLiveItems(rawItems);

    const stories = items.map((item) => ({
      id: item.id,
      title: item.title ? stripHtml(item.title) : '',
      url: normalizeUrl(item.url),
      score: item.score ?? 0,
      by: item.by ?? '',
      time: item.time ?? 0,
      descendants: item.descendants,
      text: item.text ? stripHtml(item.text) : undefined,
      type: item.type,
    }));

    ctx.log.info('Fetched stories', { feed: input.feed, count: stories.length });

    return {
      stories,
      feed: input.feed,
      total: feedIds.length,
      offset: input.offset,
      hasMore: input.offset + input.count < feedIds.length,
    };
  },

  format: (result) => {
    if (result.stories.length === 0) {
      return [{ type: 'text' as const, text: `${result.feed} feed — no stories` }];
    }

    const lines = result.stories.map((s, i) => {
      const rank = result.offset + i + 1;
      const comments = s.descendants != null ? ` | ${s.descendants} comments` : '';
      const url = s.url ? `\n    ${s.url}` : '';
      return `[${rank}] ${s.title} (${s.score} pts${comments})${url}`;
    });

    const end = result.offset + result.stories.length;
    const header = `${result.feed} stories (${result.offset + 1}–${end} of ${result.total})`;
    return [{ type: 'text' as const, text: `${header}\n\n${lines.join('\n\n')}` }];
  },
});
