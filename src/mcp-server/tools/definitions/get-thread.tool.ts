/**
 * @fileoverview Fetch an HN item and its comment tree via ranked BFS traversal,
 * resumable through a cursor that carries the unvisited frontier.
 * @module mcp-server/tools/definitions/get-thread.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams, JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import {
  getHnService,
  type HnService,
  isRateLimited,
  normalizeUrl,
  stripHtml,
} from '@/services/hn/hn-service.js';
import type { HnItem } from '@/services/hn/types.js';

/** Largest `maxComments` accepts, mirrored in the input schema. */
const MAX_COMMENTS = 200;

/** Largest `depth` accepts, mirrored in the input schema. */
const MAX_DEPTH = 10;

/**
 * Byte budget for the rendered `format()` text. Checked between comments, so a
 * page never ends mid-comment, and the first comment on a page is always kept.
 */
const RESPONSE_BUDGET_BYTES = 64_000;

/** Most comments one batch fetches — bounds the fetches a size cut leaves unused. */
const FETCH_CHUNK = 25;

/**
 * Most frontier items one call examines. Dead, deleted, and missing items cost
 * a fetch without filling the page, so without a ceiling a frontier made of
 * them would run unbounded.
 */
const MAX_ITEMS_EXAMINED = 1_000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OptionSchema = z
  .object({
    id: z.number().describe('Poll option ID.'),
    text: z.string().optional().describe('Option text (HTML stripped). Absent once deleted.'),
    score: z.number().optional().describe('Votes for this option.'),
    deleted: z
      .literal(true)
      .optional()
      .describe('Present and `true` when the option was deleted. Omitted otherwise.'),
    dead: z
      .literal(true)
      .optional()
      .describe(
        'Present and `true` when the option is dead (flagged or killed). Omitted otherwise.',
      ),
  })
  .describe('One poll option.');

const ItemSchema = z
  .object({
    id: z.number().describe('Item ID.'),
    type: z.string().describe('Item type: story | comment | job | poll | pollopt.'),
    by: z.string().optional().describe('Author username.'),
    time: z.number().optional().describe('Unix timestamp.'),
    title: z.string().optional().describe('Story/job/poll title.'),
    url: z.string().optional().describe('External link URL.'),
    text: z.string().optional().describe('Body text (HTML stripped).'),
    score: z.number().optional().describe('Upvote count.'),
    descendants: z.number().optional().describe('Total comment count.'),
    parent: z
      .number()
      .optional()
      .describe(
        'For a comment root, the ID of the story or comment it replies to — pass it as itemId for the context above.',
      ),
    poll: z.number().optional().describe('For a poll-option root, the ID of its poll.'),
    parts: z.array(z.number()).optional().describe('For a poll root, its option IDs in HN order.'),
    deleted: z
      .literal(true)
      .optional()
      .describe(
        'Present and `true` when HN reports the root deleted; its author and text are gone, but its replies are still walked. Omitted otherwise.',
      ),
    dead: z
      .literal(true)
      .optional()
      .describe(
        'Present and `true` when the root is dead (flagged or killed); its replies are still walked. Omitted otherwise.',
      ),
    options: z
      .array(OptionSchema)
      .optional()
      .describe(
        'For a poll root, its options with text and votes in parts order, resolved at every depth including 0. Deleted and dead options are kept and marked; an option whose fetch failed is listed in failedIds instead. Options do not count toward maxComments or totalLoaded.',
      ),
  })
  .describe('The root item: a story, comment, job, poll, or poll option.');

const CommentSchema = z
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
  .describe('A single comment in the thread with its tree position.');

type ThreadItem = z.infer<typeof ItemSchema>;
type ThreadOption = z.infer<typeof OptionSchema>;
type ThreadComment = z.infer<typeof CommentSchema>;

// ---------------------------------------------------------------------------
// Rendering — format() and the size budget share these, so the budget measures
// exactly the text format() produces.
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
  story: 'Story',
  comment: 'Comment',
  job: 'Job',
  poll: 'Poll',
  pollopt: 'Poll option',
};

/** Separator format() places between the root block and the first comment. */
const COMMENTS_DIVIDER = '\n---\n';

const utf8 = new TextEncoder();
const byteLength = (text: string) => utf8.encode(text).byteLength;

/** Heading that names the root's type, state, and — for a poll option — its poll. */
function rootHeading(item: ThreadItem): string {
  const state = item.deleted ? '[deleted] ' : item.dead ? '[dead] ' : '';
  if (item.title) return `${state}${item.title}`;
  const label = TYPE_LABELS[item.type] ?? item.type;
  const author = item.deleted ? '' : ` by ${item.by ?? 'unknown'}`;
  const poll = item.poll != null ? ` on poll ${item.poll}` : '';
  return `${state}${label}${author}${poll}`;
}

function renderOption(option: ThreadOption): string {
  const meta = [
    `id:${option.id}`,
    option.deleted ? '[deleted]' : null,
    option.dead ? '[dead]' : null,
    option.score != null ? `${option.score} pts` : null,
  ]
    .filter(Boolean)
    .join(' | ');
  return `- ${meta}${option.text ? `: ${option.text}` : ''}`;
}

function renderRoot(item: ThreadItem): string {
  const date = item.time
    ? `${new Date(item.time * 1000).toISOString().slice(0, 10)} (t:${item.time})`
    : '';
  const meta = [
    `id:${item.id}`,
    `type:${item.type}`,
    item.parent != null ? `parent:${item.parent}` : null,
    item.poll != null ? `poll:${item.poll}` : null,
    item.parts?.length ? `parts:${item.parts.join(',')}` : null,
    item.score != null ? `${item.score} pts` : null,
    item.by ? `by ${item.by}` : null,
    item.descendants != null ? `${item.descendants} comments` : null,
    date,
  ]
    .filter(Boolean)
    .join(' | ');
  const lines = [`## ${rootHeading(item)}\n${meta}`];
  if (item.url) lines.push(item.url);
  if (item.text) lines.push(item.text);
  if (item.options?.length) {
    lines.push(`**Options:**\n${item.options.map(renderOption).join('\n')}`);
  }
  return lines.join('\n');
}

function renderComment(c: ThreadComment): string {
  // Cap visual indent at 10 levels — the depth value itself is rendered explicitly below.
  const indent = '  '.repeat(Math.min(c.depth, 10));
  const author = c.by ? (c.isOp ? `${c.by} (OP)` : c.by) : '[deleted]';
  const date = c.time
    ? `${new Date(c.time * 1000).toISOString().slice(0, 16).replace('T', ' ')} (t:${c.time})`
    : '';
  const replies = c.childCount > 0 ? ` | ${c.childCount} replies` : '';
  const opTag = c.isOp ? ' | isOp:true' : '';
  const header = `${indent}**${author}** (id:${c.id} | depth:${c.depth} | parent:${c.parentId}${opTag}${replies} | ${date})`;
  return c.text ? `${header}\n${indent}${c.text.replace(/\n/g, `\n${indent}`)}` : header;
}

function renderThread(item: ThreadItem, comments: readonly ThreadComment[]): string {
  const parts = [renderRoot(item)];
  if (comments.length > 0) parts.push(COMMENTS_DIVIDER, ...comments.map(renderComment));
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Cursor — the unvisited frontier as (id, parentId) pairs, grouped by level
// and parent so a run of siblings shares one header.
// ---------------------------------------------------------------------------

/** One unvisited comment: its ID, the item it replies to, and its depth below the root. */
interface FrontierEntry {
  id: number;
  level: number;
  parentId: number;
}

/** The state a cursor carries between calls. The server keeps none of its own. */
interface ThreadCursor {
  depth: number;
  /** A depth cut on an earlier page, reported once the cursor runs out. */
  depthCut: boolean;
  frontier: FrontierEntry[];
  itemId: number;
  /** Comments returned by earlier pages. */
  offset: number;
}

const CursorStateSchema = z
  .object({
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
    itemId: z.number().int(),
    depth: z.number().int().min(1).max(MAX_DEPTH),
    /** Each group is `[level, parentId, ...ids]`. */
    frontier: z.array(z.array(z.number().int().min(0)).min(3)).min(1),
    depthCut: z.literal(true).optional(),
  })
  .refine((state) => state.frontier.every(([level = state.depth]) => level < state.depth));

function encodeThreadCursor(state: ThreadCursor & { limit: number }): string {
  const groups: number[][] = [];
  let group: number[] | undefined;
  for (const { id, level, parentId } of state.frontier) {
    if (group?.[0] === level && group[1] === parentId) {
      group.push(id);
    } else {
      group = [level, parentId, id];
      groups.push(group);
    }
  }
  return encodeCursor({
    offset: state.offset,
    limit: state.limit,
    itemId: state.itemId,
    depth: state.depth,
    frontier: groups,
    ...(state.depthCut && { depthCut: true }),
  });
}

function malformedCursor(cause: unknown): McpError {
  return invalidParams(
    'cursor is not one hn_get_thread issued, or it was altered.',
    {
      recovery: {
        hint: 'Pass nextCursor exactly as a previous hn_get_thread call returned it, or omit cursor to start the thread from the top.',
      },
    },
    { cause },
  );
}

/** Decode and validate a cursor; anything this tool did not issue is an input error. */
function readCursor(cursor: string, ctx: Context): ThreadCursor {
  let decoded: unknown;
  try {
    decoded = decodeCursor(cursor, ctx);
  } catch (error) {
    throw malformedCursor(error);
  }
  const parsed = CursorStateSchema.safeParse(decoded);
  if (!parsed.success) throw malformedCursor(parsed.error);
  const { offset, itemId, depth, frontier, depthCut } = parsed.data;
  return {
    offset,
    itemId,
    depth,
    depthCut: depthCut === true,
    frontier: frontier.flatMap(([level = 0, parentId = 0, ...ids]) =>
      ids.map((id) => ({ id, level, parentId })),
    ),
  };
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/** Why a walk stopped with comments still to read. `examined` is the per-call item ceiling. */
type WalkStop = 'count' | 'examined' | 'size' | 'rate_limited';

interface WalkResult {
  comments: ThreadComment[];
  /** A comment at the last allowed depth had replies the depth limit left unread. */
  depthCut: boolean;
  /** Entries whose fetch failed this call, in traversal order. */
  failed: FrontierEntry[];
  omittedDead: number;
  omittedDeleted: number;
  rateLimit: McpError | undefined;
  /** Entries not yet visited, in traversal order. */
  rest: FrontierEntry[];
  stop: WalkStop | undefined;
}

/**
 * Ranked BFS over the frontier: every comment at one depth before any at the
 * next, and HN's kids order within each parent. Fetches in chunks no larger
 * than the comments still wanted, so filtered and failed items never push a
 * later sibling out of the page — anything unvisited stays in `rest`.
 *
 * Stops on `maxComments`, the item ceiling, the byte budget, or a rate limit.
 * After a rate limit nothing more is fetched: every level below would pay its
 * own retry ladder against a throttled upstream.
 */
async function walkThread(
  hn: HnService,
  ctx: Context,
  args: {
    depth: number;
    maxComments: number;
    rateLimit: McpError | undefined;
    rootBy: string | undefined;
    seed: readonly FrontierEntry[];
    usedBytes: number;
  },
): Promise<WalkResult> {
  const levels: FrontierEntry[][] = Array.from({ length: args.depth }, () => []);
  for (const entry of args.seed) levels[entry.level]?.push(entry);

  const comments: ThreadComment[] = [];
  const failed: FrontierEntry[] = [];
  let { rateLimit, usedBytes } = args;
  let omittedDeleted = 0;
  let omittedDead = 0;
  let depthCut = false;
  let examined = 0;
  let stop: WalkStop | undefined;

  walk: for (const [level, queue] of levels.entries()) {
    while (queue.length > 0) {
      if (rateLimit) stop = 'rate_limited';
      else if (comments.length >= args.maxComments) stop = 'count';
      else if (examined >= MAX_ITEMS_EXAMINED) stop = 'examined';
      if (stop) break walk;

      const batch = queue.slice(
        0,
        Math.min(args.maxComments - comments.length, FETCH_CHUNK, MAX_ITEMS_EXAMINED - examined),
      );
      examined += batch.length;
      const slots = await hn.fetchItems(
        batch.map((entry) => entry.id),
        ctx,
      );

      let visited = 0;
      for (const [i, entry] of batch.entries()) {
        const slot = slots[i];
        if (!slot) break;
        if (slot.kind === 'item' && !slot.item.deleted && !slot.item.dead) {
          const c = slot.item;
          const comment: ThreadComment = {
            id: c.id,
            by: c.by,
            time: c.time,
            text: c.text ? stripHtml(c.text) : undefined,
            depth: level,
            parentId: entry.parentId,
            childCount: c.kids?.length ?? 0,
            ...(c.by != null && c.by === args.rootBy && { isOp: true as const }),
          };
          const bytes =
            byteLength(renderComment(comment)) +
            1 +
            (comments.length === 0 ? byteLength(COMMENTS_DIVIDER) + 1 : 0);
          if (comments.length > 0 && usedBytes + bytes > RESPONSE_BUDGET_BYTES) {
            stop = 'size';
            break;
          }
          comments.push(comment);
          usedBytes += bytes;
          if (c.kids?.length) {
            const next = levels[level + 1];
            if (next) next.push(...c.kids.map((id) => ({ id, level: level + 1, parentId: c.id })));
            else depthCut = true;
          }
        } else if (slot.kind === 'failed') {
          failed.push(entry);
          if (isRateLimited(slot.error)) rateLimit ??= slot.error;
        } else if (slot.kind === 'item') {
          if (slot.item.deleted) omittedDeleted++;
          else omittedDead++;
        }
        visited++;
      }
      queue.splice(0, visited);
      if (stop) break walk;
    }
  }

  /** A rate limit on the last batch still leaves its failed entries to resume. */
  if (!stop && rateLimit && failed.length > 0) stop = 'rate_limited';

  return {
    comments,
    depthCut,
    failed,
    omittedDead,
    omittedDeleted,
    rateLimit,
    rest: levels.flat(),
    stop,
  };
}

function projectOption(option: HnItem): ThreadOption {
  return {
    id: option.id,
    ...(option.text != null && { text: stripHtml(option.text) }),
    ...(option.score != null && { score: option.score }),
    ...(option.deleted && { deleted: true as const }),
    ...(option.dead && { dead: true as const }),
  };
}

/** A 429's `Retry-After`, worded for a notice. */
function waitFor(rateLimit: McpError | undefined): string {
  const retryAfter = rateLimit?.data?.retryAfter;
  if (typeof retryAfter !== 'string') return 'several seconds';
  return /^\d+$/.test(retryAfter) ? `${retryAfter} seconds` : `until ${retryAfter}`;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const getThread = tool('hn_get_thread', {
  description:
    'Get an item and its comment tree as a threaded discussion, with child comments resolved recursively. Use depth 0 for an item-only lookup. A long thread comes back in pages: pass the returned nextCursor as cursor to continue.',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'item_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'HN reports no item exists for the given itemId.',
      recovery: 'Verify the itemId via hn_search_content or a feed listing from hn_get_stories.',
      severity: 'notice',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The cursor was issued for a different itemId than the one passed with it.',
      recovery:
        'Pass the cursor with the same itemId it was returned for, or omit cursor to start this item from the top.',
      severity: 'notice',
    },
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
    itemId: z
      .number()
      .int()
      .describe('ID of the story, comment, job, poll, or poll option to fetch the thread for.'),
    depth: z
      .number()
      .int()
      .min(0)
      .max(MAX_DEPTH)
      .default(3)
      .describe(
        `How many levels of replies to resolve. 0 = just the item, no comments. 1 = direct replies only. Replies below this depth are never fetched — to read them, raise depth or call again with a specific comment's itemId to drill into its subtree. Ignored when cursor is set: the depth the cursor was issued with applies.`,
      ),
    maxComments: z
      .number()
      .int()
      .min(1)
      .max(MAX_COMMENTS)
      .default(50)
      .describe(
        `Maximum comments in one response, across all depth levels. Highest-ranked top-level comments resolve first; replies fill in only after the level above is exhausted. A response also stops at a fixed 64,000-byte text budget. When either limit stops the traversal, nextCursor continues it.`,
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'nextCursor from a previous call, passed with the same itemId, to continue the traversal at the next unseen comment without repeating or skipping any. Omit to start from the top.',
      ),
  }),
  output: z.object({
    item: ItemSchema,
    comments: z
      .array(CommentSchema)
      .describe(
        'Flat comment list ordered breadth-first by rank: highest-ranked top-level comments first, then their replies. Use depth/parentId to reconstruct nesting. With cursor, the page continues the same order.',
      ),
  }),

  enrichment: {
    totalLoaded: z
      .number()
      .describe('Number of comments in this response (this page, when paging with cursor).'),
    totalAvailable: z
      .number()
      .optional()
      .describe(
        "HN's total comment count for the root (descendants), which also counts dead and deleted comments. Absent for comment and job roots.",
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when comments remain unread: reachable through nextCursor (truncationReason count, size, or rate_limited), or below the depth limit (depth). Absent on a terminal page — including a thread that loads in full at exactly maxComments.',
      ),
    truncationReason: z
      .enum(['count', 'size', 'depth', 'rate_limited'])
      .optional()
      .describe(
        'Why the traversal stopped short: count = maxComments (or the 1,000-item ceiling per call) was reached; size = the 64,000-byte response budget was reached; rate_limited = the HN API throttled the fetches; depth = replies lie below the depth limit, which nextCursor does not reach — raise depth or pass a comment id as itemId. When a cursor reason and a depth cut both apply, the cursor reason is reported.',
      ),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Pass as cursor, with the same itemId, to continue from the next unseen comment. Present when truncationReason is count, size, or rate_limited; absent on the last page.',
      ),
    shown: z.number().optional().describe('Number of comments returned.'),
    cap: z.number().optional().describe('The maxComments cap that was applied.'),
    failedIds: z
      .array(z.number())
      .optional()
      .describe(
        'Comment and poll-option IDs whose fetch failed after retries, so neither they nor their replies are in this response. They are not deleted or missing and may load on a later call. Failed comments ride in nextCursor and are retried when you continue; without one, call again, or pass an ID as itemId to fetch that comment and its replies. Absent when everything the traversal reached loaded.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Traversal context: counts of deleted/dead comments dropped, the IDs that failed to load and how to retry them, then what stopped the traversal and how to continue — nextCursor for a count, size, or rate-limit stop, or a larger depth or a comment id as itemId for a depth cut. Absent when nothing was dropped, failed, or left unread.',
      ),
  },
  enrichmentTrailer: {
    failedIds: { render: (ids) => `**Failed to load:** ${(ids ?? []).join(', ')}` },
  },

  async handler(input, ctx) {
    const resume = input.cursor ? readCursor(input.cursor, ctx) : undefined;
    if (resume && resume.itemId !== input.itemId) {
      throw ctx.fail(
        'invalid_cursor',
        `This cursor continues item ${resume.itemId}, not item ${input.itemId}.`,
        { itemId: input.itemId, ...ctx.recoveryFor('invalid_cursor') },
      );
    }

    const hn = getHnService();
    const root = await hn.fetchItem(input.itemId, ctx);
    if (!root) {
      throw ctx.fail('item_not_found', `Item ${input.itemId} not found`, {
        itemId: input.itemId,
        ...ctx.recoveryFor('item_not_found'),
      });
    }

    const options: ThreadOption[] = [];
    const failedOptionIds: number[] = [];
    let optionRateLimit: McpError | undefined;
    for (const slot of root.parts?.length ? await hn.fetchItems(root.parts, ctx) : []) {
      if (slot.kind === 'item') {
        options.push(projectOption(slot.item));
      } else if (slot.kind === 'failed') {
        failedOptionIds.push(slot.id);
        if (isRateLimited(slot.error)) optionRateLimit ??= slot.error;
      }
    }

    /**
     * Relationship and state keys are written only when HN sets them, and
     * `totalAvailable` below only when HN reports `descendants`: a key carried
     * with an `undefined` value renders as a literal "undefined" in content[].
     */
    const item: ThreadItem = {
      id: root.id,
      type: root.type,
      by: root.by,
      time: root.time,
      title: root.title ? stripHtml(root.title) : undefined,
      url: normalizeUrl(root.url),
      text: root.text ? stripHtml(root.text) : undefined,
      score: root.score,
      descendants: root.descendants,
      ...(root.parent != null && { parent: root.parent }),
      ...(root.poll != null && { poll: root.poll }),
      ...(root.parts && root.parts.length > 0 && { parts: root.parts }),
      ...(root.deleted && { deleted: true as const }),
      ...(root.dead && { dead: true as const }),
      ...(options.length > 0 && { options }),
    };

    const depth = resume?.depth ?? input.depth;
    const seed =
      resume?.frontier ??
      (depth > 0 ? (root.kids ?? []).map((id) => ({ id, level: 0, parentId: root.id })) : []);
    const walk = await walkThread(hn, ctx, {
      depth,
      maxComments: input.maxComments,
      rateLimit: optionRateLimit,
      rootBy: root.by,
      seed,
      usedBytes: byteLength(renderRoot(item)),
    });
    const { comments, stop } = walk;

    ctx.log.info('Resolved thread', {
      itemId: input.itemId,
      comments: comments.length,
      failed: walk.failed.length + failedOptionIds.length,
      stop,
    });

    const totalLoaded = comments.length;
    /** Comments returned across every page so far, this one included. */
    const loadedSoFar = (resume?.offset ?? 0) + totalLoaded;
    const totalAvailable = root.descendants;
    const failedCommentIds = walk.failed.map((entry) => entry.id);
    const failedIds = [...failedCommentIds, ...failedOptionIds];
    ctx.enrich({
      totalLoaded,
      ...(totalAvailable != null && { totalAvailable }),
      ...(failedIds.length > 0 && { failedIds }),
    });

    const depthCut = walk.depthCut || resume?.depthCut === true;
    /** Failed comments lead the cursor, so continuing retries them rather than skipping them. */
    const nextCursor =
      stop &&
      encodeThreadCursor({
        offset: loadedSoFar,
        limit: input.maxComments,
        itemId: input.itemId,
        depth,
        frontier: [...walk.failed, ...walk.rest],
        depthCut,
      });

    const noticeParts: string[] = [];
    if (walk.omittedDeleted > 0 || walk.omittedDead > 0) {
      noticeParts.push(
        `${walk.omittedDeleted} deleted, ${walk.omittedDead} dead — omitted from this view.`,
      );
    }
    if (failedCommentIds.length > 0) {
      const n = failedCommentIds.length;
      const retry = nextCursor
        ? `nextCursor carries ${plural(n, 'it', 'them')}, so continuing retries ${plural(n, 'it', 'them')}; or pass an id as itemId to fetch that comment and its replies.`
        : 'Call again to retry, or pass an id as itemId to fetch that comment and its replies.';
      noticeParts.push(
        `Could not fetch ${n} ${plural(n, 'comment')} (${plural(n, 'id')} ${failedCommentIds.join(', ')}); ${plural(n, 'its', 'their')} replies were not reached either. ${retry}`,
      );
    }
    if (failedOptionIds.length > 0) {
      const n = failedOptionIds.length;
      noticeParts.push(
        `Could not fetch ${n} poll ${plural(n, 'option')} (${plural(n, 'id')} ${failedOptionIds.join(', ')}). Call again to retry.`,
      );
    }

    const loaded =
      totalAvailable != null ? ` with ${loadedSoFar}/${totalAvailable} comments loaded` : '';
    const resumeHint = 'Pass nextCursor as cursor, with the same itemId, to continue.';
    switch (stop) {
      case 'count':
        noticeParts.push(`Stopped at maxComments ${input.maxComments}${loaded}. ${resumeHint}`);
        break;
      case 'examined':
        noticeParts.push(
          `Stopped after examining ${MAX_ITEMS_EXAMINED.toLocaleString('en-US')} items in one call${loaded}. ${resumeHint}`,
        );
        break;
      case 'size':
        noticeParts.push(
          `Stopped at the ${RESPONSE_BUDGET_BYTES.toLocaleString('en-US')}-byte response budget after ${totalLoaded} ${plural(totalLoaded, 'comment')}${loaded}. ${resumeHint}`,
        );
        break;
      case 'rate_limited':
        noticeParts.push(
          `Stopped early: the HN API is rate-limiting this server${loaded}. Wait ${waitFor(walk.rateLimit)}, then pass nextCursor as cursor, with the same itemId, to resume; comments that failed to load are retried first.`,
        );
        break;
      case undefined:
        if (depthCut) {
          const raise = depth < MAX_DEPTH ? `Raise depth (max ${MAX_DEPTH}), or pass` : 'Pass';
          noticeParts.push(
            `The depth limit (${depth}) left replies unread${loaded}. ${raise} the id of a depth-${depth - 1} comment that shows replies as itemId to read its subtree.`,
          );
        } else if (resume && totalLoaded === 0 && noticeParts.length === 0) {
          noticeParts.push(
            'No comments remain past this cursor; the thread has been read to the end.',
          );
        }
        break;
    }

    const notice = noticeParts.join(' ');
    if (stop === 'count' || stop === 'examined' || stop === 'size') {
      ctx.enrich.truncated({ shown: totalLoaded, cap: input.maxComments, guidance: notice });
    } else if (stop === 'rate_limited' || depthCut) {
      ctx.enrich({ truncated: true });
      ctx.enrich.notice(notice);
    } else if (notice) {
      ctx.enrich.notice(notice);
    }
    if (stop || depthCut) {
      ctx.enrich({
        truncationReason: stop === 'examined' ? 'count' : (stop ?? 'depth'),
        ...(nextCursor && { nextCursor }),
      });
    }

    return { item, comments };
  },

  format: (result) => [{ type: 'text', text: renderThread(result.item, result.comments) }],
});
