/**
 * @fileoverview Fetch stories from an HN feed with batch resolution.
 * @module mcp-server/tools/definitions/get-stories.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  extractDomain,
  filterLiveItems,
  getHnService,
  normalizeUrl,
  stripHtml,
} from '@/services/hn/hn-service.js';

export const getStories = tool('hn_get_stories', {
  description:
    'Fetch stories from an HN feed (top, new, best, ask, show, jobs), with title, URL, score, author, and comment count for each story.',
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
      .describe('Number of stories to return. Larger counts take longer.'),
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
        z
          .object({
            id: z.number().describe('Item ID — use with hn_get_thread to read comments.'),
            type: z.string().describe('Item type (story, job).'),
            title: z
              .string()
              .optional()
              .describe('Story title when provided by HN. Omitted when unknown.'),
            url: z
              .string()
              .optional()
              .describe('External link URL. Absent for Ask HN / text posts.'),
            domain: z
              .string()
              .optional()
              .describe(
                'Bare hostname derived from url (e.g. "github.com", with leading "www." stripped). Absent when url is missing or unparseable.',
              ),
            score: z
              .number()
              .optional()
              .describe('Upvote count when provided by HN. Omitted when unknown.'),
            by: z
              .string()
              .optional()
              .describe('Author username when provided by HN. Omitted when unknown.'),
            time: z
              .number()
              .optional()
              .describe('Unix timestamp when provided by HN. Omitted when unknown.'),
            descendants: z.number().optional().describe('Total comment count. Absent for jobs.'),
            text: z
              .string()
              .optional()
              .describe(
                'Body text for Ask HN / text posts. Use hn_get_thread for full discussion.',
              ),
          })
          .describe('A single story or job posting.'),
      )
      .describe('Stories from the feed, ordered by HN ranking.'),
    feed: z.string().describe('Which feed was fetched.'),
  }),

  enrichment: {
    total: z
      .number()
      .describe('Total items in the feed (up to 500 for top/new/best, 200 for ask/show/jobs).'),
    offset: z.number().describe('Offset that was applied to this page.'),
    hasMore: z.boolean().describe('Whether more stories are available beyond this page.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the feed was capped by the count parameter.'),
    shown: z.number().optional().describe('Number of stories returned on this page.'),
    cap: z.number().optional().describe('The count cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when a page is empty — e.g. offset past end of feed or feed has no items. Absent on non-empty result pages.',
      ),
  },

  async handler(input, ctx) {
    const hn = getHnService();
    const feedIds = await hn.fetchFeed(input.feed, ctx);
    const sliced = feedIds.slice(input.offset, input.offset + input.count);
    const rawItems = await hn.fetchItems(sliced, ctx);
    const items = filterLiveItems(rawItems);

    const stories = items.map((item) => {
      const url = normalizeUrl(item.url);
      const domain = extractDomain(url);
      return {
        id: item.id,
        type: item.type,
        ...(item.title && { title: stripHtml(item.title) }),
        ...(url && { url }),
        ...(domain && { domain }),
        ...(item.score != null && { score: item.score }),
        ...(item.by && { by: item.by }),
        ...(item.time != null && { time: item.time }),
        ...(item.descendants != null && { descendants: item.descendants }),
        ...(item.text && { text: stripHtml(item.text) }),
      };
    });

    ctx.log.info('Fetched stories', { feed: input.feed, count: stories.length });

    const total = feedIds.length;
    const hasMore = input.offset + input.count < total;
    ctx.enrich({ total, offset: input.offset, hasMore });
    if (hasMore || stories.length === input.count) {
      ctx.enrich.truncated({ shown: stories.length, cap: input.count });
    }

    if (stories.length === 0) {
      if (total === 0) {
        ctx.enrich.notice(`${input.feed} feed is empty.`);
      } else if (input.offset >= total) {
        ctx.enrich.notice(
          `Offset ${input.offset} is past the end of the ${input.feed} feed (${total} item${total === 1 ? '' : 's'}). Reset offset below ${total}.`,
        );
      } else {
        ctx.enrich.notice(
          `No live stories on this page of the ${input.feed} feed (offset:${input.offset}, total:${total}). Items may have been deleted or flagged.`,
        );
      }
    }

    return {
      stories,
      feed: input.feed,
    };
  },

  format: (result) => {
    if (result.stories.length === 0) {
      return [{ type: 'text' as const, text: `${result.feed} feed — no stories` }];
    }

    const lines = result.stories.map((s, i) => {
      const rank = i + 1;
      const date =
        s.time != null
          ? `${new Date(s.time * 1000).toISOString().slice(0, 10)} (t:${s.time})`
          : null;
      const meta = [
        `id:${s.id}`,
        s.type,
        s.score != null ? `${s.score} pts` : null,
        s.by ? `by ${s.by}` : null,
        s.descendants != null ? `${s.descendants} comments` : null,
        date,
      ]
        .filter(Boolean)
        .join(' | ');
      const url = s.url ? `\n${s.url}` : '';
      const text = s.text ? `\n${s.text}` : '';
      const title = s.title ?? `[${s.type}]`;
      const domain = s.domain ? ` (${s.domain})` : '';
      return `[${rank}] ${title}${domain}\n${meta}${url}${text}`;
    });

    const header = `## ${result.feed} stories`;
    return [{ type: 'text' as const, text: `${header}\n\n${lines.join('\n\n')}` }];
  },
});
