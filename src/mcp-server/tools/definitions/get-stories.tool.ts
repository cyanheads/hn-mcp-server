/**
 * @fileoverview Fetch stories from an HN feed with batch resolution.
 * @module mcp-server/tools/definitions/get-stories.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeInline, quoteBody } from '@/mcp-server/tools/markdown-escape.js';
import { servedAtCap } from '@/mcp-server/tools/served-at-cap.js';
import {
  decodeHtmlEntities,
  extractDomain,
  getHnService,
  normalizeUrl,
  settlePage,
  stripHtml,
} from '@/services/hn/hn-service.js';

/** Most stories one call serves; a larger `count` is served at this cap. */
const COUNT_CAP = 100;

/** Largest `count` accepted; anything above it is rejected. */
const COUNT_CEILING = 1000;

export const getStories = tool('hn_get_stories', {
  description:
    'Fetch stories from an HN feed (top, new, best, ask, show, jobs), with title, URL, score, author, and comment count for each story.',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The HN API answered with a 4xx status other than 429 — it rejected the request as built.',
      recovery: 'Check the input values against this schema; the same input fails identically.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The HN API answered with HTTP 429.',
      recovery:
        'Wait the interval in retryAfter when the error carries one, otherwise several seconds, then retry and call this tool less often.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The HN API answered with a 5xx status.',
      recovery: 'Retry after a short delay; no input change helps while the upstream is down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_html',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The HN API served an HTML error page with a 200 status, which it does under rate limiting or maintenance.',
      recovery: 'Retry after a brief delay; the upstream is throttling or in maintenance.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_malformed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The HN API answered with a 200 status and a body that is not JSON.',
      recovery: 'Retry after a brief delay; no input change helps while the upstream serves this.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  input: z.object({
    feed: z
      .enum(['top', 'new', 'best', 'ask', 'show', 'jobs'])
      .describe(
        'Which HN feed to fetch. "top" includes jobs. "ask" and "show" are Ask HN / Show HN posts.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(COUNT_CEILING)
      .default(30)
      .describe(
        `Number of stories to return, at most ${COUNT_CAP} per call. A larger value is served at ${COUNT_CAP}, and the notice names the offset for the next page. Larger counts take longer.`,
      ),
    offset: z
      .number()
      .int()
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
            descendants: z
              .number()
              .optional()
              .describe(
                "HN's count of live comments in the thread (descendants); dead and deleted comments are not counted. Absent for jobs.",
              ),
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
      .describe(
        'True when more stories remain beyond this page (hasMore). Absent on the last page of the feed.',
      ),
    shown: z.number().optional().describe('Number of stories returned on this page.'),
    cap: z
      .number()
      .optional()
      .describe(
        `The count value served: as passed, or ${COUNT_CAP} when count was above that cap.`,
      ),
    failedIds: z
      .array(z.number())
      .optional()
      .describe(
        'IDs on this page whose fetch failed after retries. They are not deleted or missing and may load on a later call: retry the page with the same offset, or pass an ID to hn_get_thread to fetch that story alone. Absent when every item on the page loaded.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Agent guidance: the offset to pass for the next page while more stories remain, the IDs that failed to load and how to retry them, or why a page came back empty — offset past the end of the feed, an empty feed, or every item on the page deleted or flagged — noting when count was served at its per-call cap. Absent on the last page of a non-empty result with no failed IDs.',
      ),
  },
  enrichmentTrailer: {
    failedIds: { render: (ids) => `**Failed to load:** ${(ids ?? []).join(', ')}` },
  },

  async handler(input, ctx) {
    const hn = getHnService();
    const feedIds = await hn.fetchFeed(input.feed, ctx);
    const count = Math.min(input.count, COUNT_CAP);
    const sliced = feedIds.slice(input.offset, input.offset + count);
    const { items, failedIds } = settlePage(await hn.fetchItems(sliced, ctx));

    const stories = items.map((item) => {
      const url = normalizeUrl(item.url);
      const domain = extractDomain(url);
      return {
        id: item.id,
        type: item.type,
        ...(item.title && { title: decodeHtmlEntities(item.title) }),
        ...(url && { url }),
        ...(domain && { domain }),
        ...(item.score != null && { score: item.score }),
        ...(item.by && { by: item.by }),
        ...(item.time != null && { time: item.time }),
        ...(item.descendants != null && { descendants: item.descendants }),
        ...(item.text && { text: stripHtml(item.text) }),
      };
    });

    ctx.log.info('Fetched stories', {
      feed: input.feed,
      count: stories.length,
      failed: failedIds.length,
    });

    const total = feedIds.length;
    const nextOffset = input.offset + count;
    const hasMore = nextOffset < total;
    ctx.enrich({
      total,
      offset: input.offset,
      hasMore,
      ...(failedIds.length > 0 && { failedIds }),
    });

    const deadPageMessage = `No live stories on this page of the ${input.feed} feed (offset:${input.offset}, total:${total}). Items may have been deleted or flagged.`;
    const failureMessage =
      failedIds.length > 0
        ? `Could not fetch ${failedIds.length} of ${sliced.length} items on this page (id${failedIds.length === 1 ? '' : 's'} ${failedIds.join(', ')}). Retry with offset: ${input.offset}, or pass an id as itemId to hn_get_thread to fetch that story alone.`
        : undefined;

    if (hasMore) {
      const raiseCount = input.count < COUNT_CAP ? `, or raise count (max ${COUNT_CAP})` : '';
      const nextPage = `Pass offset: ${nextOffset} for the next page${raiseCount}.`;
      const pageStatus =
        stories.length === 0 && !failureMessage
          ? deadPageMessage
          : `Showing items ${input.offset + 1}–${nextOffset} of ${total} in the ${input.feed} feed.`;
      const overCap = input.count > COUNT_CAP ? servedAtCap('count', input.count, COUNT_CAP) : '';
      ctx.enrich.truncated({
        shown: stories.length,
        cap: count,
        guidance: [pageStatus, overCap, failureMessage, nextPage].filter(Boolean).join(' '),
      });
    } else if (stories.length === 0) {
      if (total === 0) {
        ctx.enrich.notice(`${input.feed} feed is empty.`);
      } else if (input.offset >= total) {
        ctx.enrich.notice(
          `Offset ${input.offset} is past the end of the ${input.feed} feed (${total} item${total === 1 ? '' : 's'}). Reset offset below ${total}.`,
        );
      } else {
        ctx.enrich.notice(failureMessage ?? deadPageMessage);
      }
    } else if (failureMessage) {
      ctx.enrich.notice(failureMessage);
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
      const text = s.text ? `\n${quoteBody(s.text)}` : '';
      const title = s.title ? escapeInline(s.title) : `[${s.type}]`;
      const domain = s.domain ? ` (${s.domain})` : '';
      return `[${rank}] ${title}${domain}\n${meta}${url}${text}`;
    });

    const header = `## ${result.feed} stories`;
    return [{ type: 'text' as const, text: `${header}\n\n${lines.join('\n\n')}` }];
  },
});
