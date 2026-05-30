/**
 * @fileoverview Fetch an HN item and its comment tree via ranked BFS traversal.
 * @module mcp-server/tools/definitions/get-thread.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getHnService, normalizeUrl, stripHtml } from '@/services/hn/hn-service.js';

export const getThread = tool('hn_get_thread', {
  description:
    'Get an item and its comment tree as a threaded discussion, with child comments resolved recursively. Use depth 0 for an item-only lookup.',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'item_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'HN reports no item exists for the given itemId.',
      recovery: 'Verify the itemId via hn_search_content or a feed listing from hn_get_stories.',
    },
  ],
  input: z.object({
    itemId: z.number().describe('ID of the story, comment, or poll to fetch the thread for.'),
    depth: z
      .number()
      .min(0)
      .max(10)
      .default(3)
      .describe(
        `How many levels of replies to resolve. 0 = just the item, no comments. 1 = direct replies only. Popular stories often have more top-level comments than maxComments — to see nesting, raise maxComments together with depth, or call again with a specific comment's itemId to drill into a subtree.`,
      ),
    maxComments: z
      .number()
      .min(1)
      .max(200)
      .default(50)
      .describe(
        `Maximum total comments to include across all depth levels. Highest-ranked top-level comments resolve first; replies fill in only after the level above is exhausted.`,
      ),
  }),
  output: z.object({
    item: z
      .object({
        id: z.number().describe('Item ID.'),
        type: z.string().describe('Item type: story | comment | job | poll | pollopt.'),
        by: z.string().optional().describe('Author username.'),
        time: z.number().optional().describe('Unix timestamp.'),
        title: z.string().optional().describe('Story/job title.'),
        url: z.string().optional().describe('External link URL.'),
        text: z.string().optional().describe('Body text (HTML stripped).'),
        score: z.number().optional().describe('Upvote count.'),
        descendants: z.number().optional().describe('Total comment count.'),
      })
      .describe('The root item (story, comment, or poll).'),
    comments: z
      .array(
        z
          .object({
            id: z.number().describe('Comment ID.'),
            by: z.string().optional().describe('Author username.'),
            time: z.number().optional().describe('Unix timestamp.'),
            text: z.string().optional().describe('Comment text (HTML stripped).'),
            depth: z.number().describe('Nesting level (0 = direct reply to root).'),
            parentId: z.number().describe('Parent item ID.'),
            childCount: z
              .number()
              .describe('Number of direct child comments (may exceed what was resolved).'),
            isOp: z
              .literal(true)
              .optional()
              .describe(
                'Present and `true` when the comment author matches the root item author (OP replying within their own thread). Omitted otherwise — including when either author is missing. Most threads carry no OP replies, so absence is the common case; treat missing as "not OP" rather than unknown.',
              ),
          })
          .describe('A single comment in the thread with its tree position.'),
      )
      .describe(
        'Flat comment list ordered breadth-first by rank: highest-ranked top-level comments first, then their replies. Use depth/parentId to reconstruct nesting.',
      ),
  }),

  enrichment: {
    totalLoaded: z.number().describe('Number of comments actually fetched and included.'),
    totalAvailable: z
      .number()
      .optional()
      .describe(
        'Total comment count from the root item. If totalLoaded < totalAvailable, raise maxComments (and depth, if you want nested replies) and call again.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Truncation context: counts of deleted/dead comments dropped during traversal, or pagination hint when totalLoaded < totalAvailable. Absent when no comments were dropped and all available comments were loaded.',
      ),
  },

  async handler(input, ctx) {
    const hn = getHnService();
    const root = await hn.fetchItem(input.itemId, ctx);
    if (!root) {
      throw ctx.fail('item_not_found', `Item ${input.itemId} not found`, {
        itemId: input.itemId,
        ...ctx.recoveryFor('item_not_found'),
      });
    }

    const item = {
      id: root.id,
      type: root.type,
      by: root.by,
      time: root.time,
      title: root.title ? stripHtml(root.title) : undefined,
      url: normalizeUrl(root.url),
      text: root.text ? stripHtml(root.text) : undefined,
      score: root.score,
      descendants: root.descendants,
    };

    if (input.depth === 0 || !root.kids?.length) {
      ctx.enrich({ totalLoaded: 0, totalAvailable: root.descendants });
      return {
        item,
        comments: [],
      };
    }

    // Ranked BFS: process all comments at depth d before depth d+1.
    // Within each depth, order follows HN's kids ranking.
    const comments: Array<{
      id: number;
      by: string | undefined;
      time: number | undefined;
      text: string | undefined;
      depth: number;
      parentId: number;
      childCount: number;
      isOp?: true;
    }> = [];
    let omittedDeleted = 0;
    let omittedDead = 0;

    let currentLevel: Array<{ id: number; parentId: number }> = root.kids.map((id) => ({
      id,
      parentId: root.id,
    }));

    for (
      let d = 0;
      d < input.depth && currentLevel.length > 0 && comments.length < input.maxComments;
      d++
    ) {
      const remaining = input.maxComments - comments.length;
      // Fetch a batch with buffer for dead/deleted items
      const batch = currentLevel.slice(0, remaining + 20);
      const items = await hn.fetchItems(
        batch.map((b) => b.id),
        ctx,
      );
      const nextLevel: Array<{ id: number; parentId: number }> = [];

      for (let i = 0; i < items.length && comments.length < input.maxComments; i++) {
        const c = items[i];
        const parent = batch[i];
        if (!c || !parent) continue;
        if (c.deleted) {
          omittedDeleted++;
          continue;
        }
        if (c.dead) {
          omittedDead++;
          continue;
        }

        comments.push({
          id: c.id,
          by: c.by,
          time: c.time,
          text: c.text ? stripHtml(c.text) : undefined,
          depth: d,
          parentId: parent.parentId,
          childCount: c.kids?.length ?? 0,
          ...(c.by != null && c.by === root.by && { isOp: true as const }),
        });

        if (c.kids) {
          for (const kid of c.kids) {
            nextLevel.push({ id: kid, parentId: c.id });
          }
        }
      }

      currentLevel = nextLevel;
    }

    ctx.log.info('Resolved thread', { itemId: input.itemId, comments: comments.length });

    const totalLoaded = comments.length;
    const totalAvailable = root.descendants;
    ctx.enrich({ totalLoaded, totalAvailable });

    const noticeParts: string[] = [];
    if (omittedDeleted > 0 || omittedDead > 0) {
      noticeParts.push(`${omittedDeleted} deleted, ${omittedDead} dead — omitted from this view.`);
    }
    if (totalAvailable != null && totalLoaded < totalAvailable) {
      noticeParts.push(
        `${totalLoaded}/${totalAvailable} comments loaded — raise maxComments or depth for more.`,
      );
    }
    if (noticeParts.length > 0) {
      ctx.enrich.notice(noticeParts.join(' '));
    }

    return {
      item,
      comments,
    };
  },

  format: (result) => {
    const { item, comments } = result;
    const lines: string[] = [];

    // Root item
    const title = item.title ?? `Comment by ${item.by ?? 'unknown'}`;
    const date = item.time
      ? `${new Date(item.time * 1000).toISOString().slice(0, 10)} (t:${item.time})`
      : '';
    const meta = [
      `id:${item.id}`,
      `type:${item.type}`,
      item.score != null ? `${item.score} pts` : null,
      item.by ? `by ${item.by}` : null,
      item.descendants != null ? `${item.descendants} comments` : null,
      date,
    ]
      .filter(Boolean)
      .join(' | ');
    lines.push(`## ${title}\n${meta}`);
    if (item.url) lines.push(item.url);
    if (item.text) lines.push(item.text);

    // Comment tree
    if (comments.length > 0) {
      lines.push('\n---\n');
      for (const c of comments) {
        // Cap visual indent at 10 levels — the depth value itself is rendered explicitly below.
        const indent = '  '.repeat(Math.min(c.depth, 10));
        const author = c.by ? (c.isOp ? `${c.by} (OP)` : c.by) : '[deleted]';
        const cDate = c.time
          ? `${new Date(c.time * 1000).toISOString().slice(0, 16).replace('T', ' ')} (t:${c.time})`
          : '';
        const replies = c.childCount > 0 ? ` | ${c.childCount} replies` : '';
        const opTag = c.isOp ? ' | isOp:true' : '';
        lines.push(
          `${indent}**${author}** (id:${c.id} | depth:${c.depth} | parent:${c.parentId}${opTag}${replies} | ${cDate})`,
        );
        if (c.text) lines.push(`${indent}${c.text.replace(/\n/g, `\n${indent}`)}`);
      }
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
