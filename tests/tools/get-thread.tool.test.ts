/**
 * @fileoverview Tests for the hn_get_thread tool — item lookup and ranked BFS comment traversal.
 * @module mcp-server/tools/definitions/get-thread.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext as createFrameworkMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { HnItem } from '@/services/hn/types.js';

/**
 * Only the accessor and the text helpers are faked. `HnService` stays real,
 * so the partial-failure suite below runs the actual service against a
 * stubbed fetch.
 */
vi.mock('@/services/hn/hn-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/hn/hn-service.js')>()),
  getHnService: vi.fn(),
  stripHtml: vi.fn((html: string) => html),
  normalizeUrl: vi.fn((url?: string) => url || undefined),
}));

import { getThread } from '@/mcp-server/tools/definitions/get-thread.tool.js';
import {
  getHnService,
  HnService,
  type ItemSlot,
  normalizeUrl,
  stripHtml,
} from '@/services/hn/hn-service.js';
import { httpStatus, stubHnApi } from '../helpers/hn-api-stub.js';

function createMockContext() {
  return createFrameworkMockContext({ errors: getThread.errors });
}

/** Wrap returned items as the batch slots `fetchItems` yields. */
function slotsOf(items: HnItem[]): ItemSlot[] {
  return items.map((item) => ({ kind: 'item', id: item.id, item }));
}

function firstText(blocks: ReturnType<NonNullable<typeof getThread.format>>): string {
  const block = blocks[0];
  if (block?.type !== 'text') throw new Error('Expected a text content block');
  return block.text;
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockStory: HnItem = {
  id: 1,
  type: 'story',
  by: 'alice',
  time: 1000,
  title: 'Test Story',
  url: 'https://example.com',
  score: 42,
  descendants: 3,
  kids: [10, 11],
};

const mockComment1: HnItem = {
  id: 10,
  type: 'comment',
  by: 'bob',
  time: 1001,
  text: 'Great post',
  kids: [20],
  parent: 1,
};

const mockComment2: HnItem = {
  id: 11,
  type: 'comment',
  by: 'carol',
  time: 1002,
  text: 'Agree',
  parent: 1,
};

const mockNestedComment: HnItem = {
  id: 20,
  type: 'comment',
  by: 'dave',
  time: 1003,
  text: 'Reply to bob',
  parent: 10,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `fetchItems` answers any call a test did not script with `absent` slots, so a
 * fixture listing more kids than its scripted batches return reads the extra
 * kids as missing items rather than crashing the traversal.
 */
function createMockHnService() {
  return {
    fetchItem: vi.fn(),
    fetchItems: vi.fn(
      async (ids: number[]): Promise<ItemSlot[]> => ids.map((id) => ({ kind: 'absent', id })),
    ),
    fetchFeed: vi.fn(),
    fetchUser: vi.fn(),
    search: vi.fn(),
  };
}

function parse(overrides: Record<string, unknown> = {}) {
  return getThread.input.parse({ itemId: 1, ...overrides });
}

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('hn_get_thread handler', () => {
  let hn: ReturnType<typeof createMockHnService>;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    hn = createMockHnService();
    (getHnService as Mock).mockReturnValue(hn);
    ctx = createMockContext();
  });

  it('throws when item is not found', async () => {
    hn.fetchItem.mockResolvedValue(null);
    await expect(getThread.handler(parse(), ctx)).rejects.toThrow('Item 1 not found');
  });

  it('returns item only with empty comments when depth is 0, with enrichment counts', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);
    const result = await getThread.handler(parse({ depth: 0 }), ctx);

    expect(result.item.id).toBe(1);
    expect(result.comments).toEqual([]);
    expect(hn.fetchItems).not.toHaveBeenCalled();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalLoaded).toBe(0);
    expect(enrichment.totalAvailable).toBe(3);
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns empty comments when story has no kids', async () => {
    const { kids: _, ...storyBase } = mockStory;
    const noKids: HnItem = { ...storyBase, descendants: 0 };
    hn.fetchItem.mockResolvedValue(noKids);
    const result = await getThread.handler(parse({ depth: 3 }), ctx);

    expect(result.comments).toEqual([]);
    expect(getEnrichment(ctx).totalLoaded).toBe(0);
  });

  it('omits the totalAvailable key entirely when the root reports no descendants', async () => {
    /**
     * Comment roots carry no `descendants`. Keying `totalAvailable: undefined`
     * survives the optional enrichment schema and renders as a literal
     * "undefined" in the framework's content[] trailer, so the key must never
     * be written at all. `toBeUndefined()` cannot catch this — it passes
     * whether the key is absent or present-and-undefined.
     */
    const commentRoot: HnItem = {
      id: 10,
      type: 'comment',
      by: 'bob',
      text: 'root comment',
      kids: [20, 21, 22],
    };
    const reply1: HnItem = { id: 20, type: 'comment', by: 'carol', text: 'r1', parent: 10 };
    const reply2: HnItem = { id: 21, type: 'comment', by: 'dave', text: 'r2', parent: 10 };
    hn.fetchItem.mockResolvedValue(commentRoot);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([reply1, reply2]));

    await getThread.handler(parse({ itemId: 10, depth: 1, maxComments: 2 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(Object.hasOwn(enrichment, 'totalAvailable')).toBe(false);
    /** Truncation fields are unaffected — they must still render. */
    expect(enrichment).toMatchObject({ totalLoaded: 2, truncated: true, shown: 2, cap: 2 });
  });

  it('omits the totalAvailable key on the depth-0 path when the root reports no descendants', async () => {
    const commentRoot: HnItem = { id: 10, type: 'comment', by: 'bob', text: 'root', kids: [20] };
    hn.fetchItem.mockResolvedValue(commentRoot);

    await getThread.handler(parse({ itemId: 10, depth: 0 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(Object.hasOwn(enrichment, 'totalAvailable')).toBe(false);
    expect(enrichment.totalLoaded).toBe(0);
  });

  it('keys totalAvailable when the root does report descendants', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([mockComment1, mockComment2]));

    await getThread.handler(parse({ depth: 1 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(Object.hasOwn(enrichment, 'totalAvailable')).toBe(true);
    expect(enrichment.totalAvailable).toBe(3);
  });

  it('resolves direct replies only at depth 1', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([mockComment1, mockComment2]));

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]).toMatchObject({ id: 10, depth: 0, parentId: 1, childCount: 1 });
    expect(result.comments[1]).toMatchObject({ id: 11, depth: 0, parentId: 1, childCount: 0 });
    expect(hn.fetchItems).toHaveBeenCalledTimes(1);
    expect(getEnrichment(ctx).totalLoaded).toBe(2);
  });

  it('resolves 2 levels with correct depth and parentId', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems
      .mockResolvedValueOnce(slotsOf([mockComment1, mockComment2]))
      .mockResolvedValueOnce(slotsOf([mockNestedComment]));

    const result = await getThread.handler(parse({ depth: 2 }), ctx);

    expect(result.comments).toHaveLength(3);

    /** Level 0 comments */
    expect(result.comments[0]).toMatchObject({ id: 10, depth: 0, parentId: 1 });
    expect(result.comments[1]).toMatchObject({ id: 11, depth: 0, parentId: 1 });

    /** Level 1 comment */
    expect(result.comments[2]).toMatchObject({ id: 20, depth: 1, parentId: 10 });

    expect(hn.fetchItems).toHaveBeenCalledTimes(2);
    expect(getEnrichment(ctx).totalLoaded).toBe(3);
  });

  it('limits total comments via maxComments', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([mockComment1, mockComment2]));

    const result = await getThread.handler(parse({ depth: 3, maxComments: 1 }), ctx);

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]!.id).toBe(10);
    expect(getEnrichment(ctx).totalLoaded).toBe(1);
  });

  it('filters out dead and deleted comments', async () => {
    const deadComment: HnItem = { id: 10, type: 'comment', dead: true, parent: 1 };
    const deletedComment: HnItem = { id: 11, type: 'comment', deleted: true, parent: 1 };
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([deadComment, deletedComment]));

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments).toHaveLength(0);
    expect(getEnrichment(ctx).totalLoaded).toBe(0);
  });

  it('emits notice with omitted counts via enrichment', async () => {
    const storyWith4Kids: HnItem = { ...mockStory, kids: [10, 11, 12, 13], descendants: 4 };
    const live: HnItem = { id: 10, type: 'comment', by: 'bob', text: 'real', parent: 1 };
    const dead: HnItem = { id: 11, type: 'comment', dead: true, parent: 1 };
    const deleted1: HnItem = { id: 12, type: 'comment', deleted: true, parent: 1 };
    const deleted2: HnItem = { id: 13, type: 'comment', deleted: true, parent: 1 };
    hn.fetchItem.mockResolvedValue(storyWith4Kids);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([live, dead, deleted1, deleted2]));

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments).toHaveLength(1);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/2 deleted.*1 dead/i);
  });

  it('omits notice when no comments are dropped and all comments loaded', async () => {
    /** Two live kids with no replies of their own: nothing is left for depth or the cap. */
    const { kids: _kids, ...leafComment1 } = mockComment1;
    hn.fetchItem.mockResolvedValue({ ...mockStory, descendants: 2 });
    hn.fetchItems.mockResolvedValueOnce(slotsOf([leafComment1, mockComment2]));

    await getThread.handler(parse({ depth: 1 }), ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('marks isOp:true when comment author equals root author', async () => {
    /** Alice is the OP of mockStory; her reply on her own thread should be tagged. */
    const opReply: HnItem = { id: 10, type: 'comment', by: 'alice', text: 'thanks!', parent: 1 };
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([opReply, mockComment2]));

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments[0]).toMatchObject({ id: 10, by: 'alice', isOp: true });
    expect(result.comments[1]).toMatchObject({ id: 11, by: 'carol' });
    expect(result.comments[1]).not.toHaveProperty('isOp');
  });

  it('omits isOp when comment author is missing', async () => {
    const anonComment: HnItem = { id: 10, type: 'comment', text: '...', parent: 1 };
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([anonComment]));

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments[0]).toMatchObject({ id: 10 });
    expect(result.comments[0]).not.toHaveProperty('isOp');
  });

  it('omits isOp when root author is missing (cannot match anonymous OP)', async () => {
    const { by: _by, ...storyWithoutAuthor } = mockStory;
    const anonStory: HnItem = storyWithoutAuthor;
    const anonComment: HnItem = { id: 10, type: 'comment', text: '...', parent: 1 };
    hn.fetchItem.mockResolvedValue(anonStory);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([anonComment]));

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments[0]).toMatchObject({ id: 10 });
    expect(result.comments[0]).not.toHaveProperty('isOp');
  });

  it('calls stripHtml on item text and comment text', async () => {
    const storyWithText: HnItem = { ...mockStory, text: '<p>Hello</p>', title: '<b>Title</b>' };
    const { kids: _k, ...comment1Base } = mockComment1;
    const commentWithHtml: HnItem = { ...comment1Base, text: '<i>Styled</i>' };
    hn.fetchItem.mockResolvedValue(storyWithText);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([commentWithHtml]));

    await getThread.handler(parse({ depth: 1 }), ctx);

    expect(stripHtml).toHaveBeenCalledWith('<p>Hello</p>');
    expect(stripHtml).toHaveBeenCalledWith('<b>Title</b>');
    expect(stripHtml).toHaveBeenCalledWith('<i>Styled</i>');
  });

  it('calls normalizeUrl on item url', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);

    await getThread.handler(parse({ depth: 0 }), ctx);

    expect(normalizeUrl).toHaveBeenCalledWith('https://example.com');
  });
});

// ---------------------------------------------------------------------------
// Format tests
// ---------------------------------------------------------------------------

describe('hn_get_thread format', () => {
  const format = getThread.format!;

  it('formats story with no comments', () => {
    const result = {
      item: {
        id: 1,
        type: 'story',
        by: 'alice',
        title: 'Test Story',
        url: 'https://example.com',
        score: 42,
        descendants: 0,
      },
      comments: [],
    };

    const blocks = format(result as Parameters<typeof format>[0]);
    expect(blocks).toHaveLength(1);
    const text = firstText(blocks);
    expect(text).toContain('Test Story');
    expect(text).toContain('42 pts');
    expect(text).toContain('by alice');
    expect(text).toContain('https://example.com');
  });

  it('formats story with indented comment tree', () => {
    const result = {
      item: { id: 1, type: 'story', by: 'alice', title: 'Test Story', score: 10, descendants: 2 },
      comments: [
        {
          id: 10,
          by: 'bob',
          time: 1001,
          text: 'Top-level',
          depth: 0,
          parentId: 1,
          childCount: 1,
        },
        {
          id: 20,
          by: 'carol',
          time: 1002,
          text: 'Nested reply',
          depth: 1,
          parentId: 10,
          childCount: 0,
        },
      ],
    };

    const blocks = format(result as Parameters<typeof format>[0]);
    const text = firstText(blocks);
    expect(text).toContain('**bob** (id:10');
    expect(text).toContain('1 replies');
    expect(text).toContain('Top-level');
    expect(text).toContain('**carol** (id:20');
    expect(text).toContain('  Nested reply');
  });

  it('marks OP comments with "(OP)" suffix in author line', () => {
    const result = {
      item: { id: 1, type: 'story', by: 'alice', title: 'Test Story' },
      comments: [
        {
          id: 10,
          by: 'alice',
          time: 1001,
          text: 'Thanks for replies',
          depth: 0,
          parentId: 1,
          childCount: 0,
          isOp: true,
        },
        {
          id: 11,
          by: 'bob',
          time: 1002,
          text: 'Comment',
          depth: 0,
          parentId: 1,
          childCount: 0,
        },
      ],
    };

    const blocks = format(result as Parameters<typeof format>[0]);
    const text = firstText(blocks);
    expect(text).toContain('**alice (OP)**');
    expect(text).toContain('**bob**');
    expect(text).not.toContain('**bob (OP)**');
    expect(text).toContain('| isOp:true');
    expect(text).not.toContain('isOp:false');
  });

  it('formats comment as root with "Comment by author"', () => {
    const result = {
      item: { id: 10, type: 'comment', by: 'bob', text: 'Some comment' },
      comments: [],
    };

    const blocks = format(result as Parameters<typeof format>[0]);
    expect(firstText(blocks)).toContain('Comment by bob');
  });
});

// ---------------------------------------------------------------------------
// Input validation tests
// ---------------------------------------------------------------------------

describe('hn_get_thread input validation', () => {
  it('requires itemId', () => {
    expect(() => getThread.input.parse({})).toThrow();
  });

  it('defaults depth to 3 and constrains to 0-10', () => {
    const defaults = getThread.input.parse({ itemId: 1 });
    expect(defaults.depth).toBe(3);

    const zero = getThread.input.parse({ itemId: 1, depth: 0 });
    expect(zero.depth).toBe(0);

    const ten = getThread.input.parse({ itemId: 1, depth: 10 });
    expect(ten.depth).toBe(10);

    expect(() => getThread.input.parse({ itemId: 1, depth: -1 })).toThrow();
    expect(() => getThread.input.parse({ itemId: 1, depth: 11 })).toThrow();
  });

  it('defaults maxComments to 50 and constrains to 1-200', () => {
    const defaults = getThread.input.parse({ itemId: 1 });
    expect(defaults.maxComments).toBe(50);

    const one = getThread.input.parse({ itemId: 1, maxComments: 1 });
    expect(one.maxComments).toBe(1);

    const max = getThread.input.parse({ itemId: 1, maxComments: 200 });
    expect(max.maxComments).toBe(200);

    expect(() => getThread.input.parse({ itemId: 1, maxComments: 0 })).toThrow();
    expect(() => getThread.input.parse({ itemId: 1, maxComments: 201 })).toThrow();
  });

  it.each([
    ['itemId', { itemId: 48683098.5 }],
    ['depth', { itemId: 1, depth: 1.5 }],
    ['maxComments', { itemId: 1, maxComments: 2.5 }],
  ])('rejects fractional %s', (_field, input) => {
    expect(() => getThread.input.parse(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Security and edge cases
// ---------------------------------------------------------------------------

describe('hn_get_thread — security and edge cases', () => {
  let hn: ReturnType<typeof createMockHnService>;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    hn = createMockHnService();
    (getHnService as Mock).mockReturnValue(hn);
    ctx = createMockContext();
  });

  it('handles item with no title and no by (fully sparse)', async () => {
    const sparseStory: HnItem = { id: 99, type: 'story' };
    hn.fetchItem.mockResolvedValue(sparseStory);
    const result = await getThread.handler(parse({ itemId: 99, depth: 0 }), ctx);

    expect(result.item.id).toBe(99);
    // The source maps undefined fields into the item object with undefined values
    expect(result.item.title).toBeUndefined();
    expect(result.item.by).toBeUndefined();
    expect(result.comments).toEqual([]);
  });

  it('format() handles missing item author gracefully (no crash)', () => {
    const result = {
      item: { id: 10, type: 'comment' as const },
      comments: [],
    };
    expect(() => getThread.format!(result)).not.toThrow();
    const blocks = getThread.format!(result);
    expect(firstText(blocks)).toContain('Comment by unknown');
  });

  it('format() caps indent depth at 10 regardless of actual depth value', () => {
    const result = {
      item: { id: 1, type: 'story' as const, by: 'alice', title: 'Deep' },
      comments: [
        {
          id: 99,
          by: 'deeply_nested',
          time: 1000,
          text: 'way down here',
          depth: 15,
          parentId: 1,
          childCount: 0,
        },
      ],
    };
    const blocks = getThread.format!(result);
    const text = firstText(blocks);
    // Capped at 10 means at most 20 spaces of indent (10 * 2 spaces each)
    const commentLine = text.split('\n').find((l) => l.includes('deeply_nested'))!;
    const leadingSpaces = commentLine.match(/^ */)?.[0]?.length ?? 0;
    expect(leadingSpaces).toBeLessThanOrEqual(20);
  });

  it('format() output does not contain raw secrets or env variables', async () => {
    process.env.HN_CONCURRENCY_LIMIT = 'SECRET_SENTINEL_999';
    const storyWithText: HnItem = { ...mockStory, text: 'Normal story text' };
    hn.fetchItem.mockResolvedValue(storyWithText);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([mockComment1]));

    const result = await getThread.handler(parse({ depth: 1 }), ctx);
    const blocks = getThread.format!(result);

    for (const block of blocks) {
      if (block.type === 'text') {
        expect(block.text).not.toContain('SECRET_SENTINEL_999');
      }
    }
    delete process.env.HN_CONCURRENCY_LIMIT;
  });

  it('enrichment notice mentions loaded/available counts when truncated', async () => {
    const bigStory: HnItem = {
      ...mockStory,
      kids: [10, 11],
      descendants: 100,
    };
    hn.fetchItem.mockResolvedValue(bigStory);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([mockComment1, mockComment2]));

    await getThread.handler(parse({ depth: 1, maxComments: 50 }), ctx);

    const enrichment = getEnrichment(ctx);
    // totalLoaded(2) < totalAvailable(100) → notice should reference counts
    expect(enrichment.notice).toMatch(/2\/100/);
  });

  it('emits combined notice when both deleted/dead items and truncation occur', async () => {
    const bigStory: HnItem = { ...mockStory, kids: [10, 11, 12], descendants: 100 };
    const live: HnItem = { ...mockComment1 };
    const dead: HnItem = { id: 11, type: 'comment', dead: true, parent: 1 };
    const deleted: HnItem = { id: 12, type: 'comment', deleted: true, parent: 1 };

    hn.fetchItem.mockResolvedValue(bigStory);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([live, dead, deleted]));

    await getThread.handler(parse({ depth: 1, maxComments: 50 }), ctx);

    const notice = getEnrichment(ctx).notice!;
    // Both parts should appear: dropped counts and loaded/available counts
    expect(notice).toMatch(/deleted/i);
    expect(notice).toMatch(/dead/i);
    expect(notice).toMatch(/loaded/i);
  });
});

// ---------------------------------------------------------------------------
// Shared harness — contract-level tool results, and the real HnService against
// a stubbed HN API
// ---------------------------------------------------------------------------

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Run the tool against the real service, letting fake timers drive any retry backoff. */
async function callStubbed(input: Record<string, unknown>): Promise<ToolResult> {
  const pending = runToolContract(getThread, input as never, {
    context: { errors: getThread.errors },
  });
  await vi.advanceTimersByTimeAsync(120_000);
  return pending;
}

function okStructured(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

function allText(result: ToolResult): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function wireError(result: ToolResult): { code: number; data?: Record<string, unknown> } {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: { code: number; data?: Record<string, unknown> } })
    .error;
}

const commentIds = (sc: Record<string, unknown>) =>
  (sc.comments as Array<{ id: number }>).map((c) => c.id);

/** A live comment `c<id>` by `u<id>`. */
const comment = (id: number, parent: number, kids?: number[]): HnItem => ({
  id,
  type: 'comment',
  by: `u${id}`,
  text: `c${id}`,
  parent,
  ...(kids && { kids }),
});

/** Serve every item under `/item/<id>.json`; a value is a body or an `httpStatus` route. */
function serveItems(items: Record<number, unknown>) {
  return stubHnApi(
    Object.fromEntries(Object.entries(items).map(([id, body]) => [`/item/${id}.json`, body])),
  );
}

/**
 * Build a comment tree under story 1 from a parent → kids map. Every id reachable
 * from the story becomes a live {@link comment}; `overrides` replaces an item's
 * body (a deleted item, an `httpStatus` route, a longer text).
 */
function storyTree(
  kidsOf: Record<number, number[]>,
  overrides: Record<number, unknown> = {},
  story: Partial<HnItem> = {},
): Record<number, unknown> {
  const items: Record<number, unknown> = {
    1: { id: 1, type: 'story', by: 'op', title: 'Story', kids: kidsOf[1], ...story },
  };
  const walk = (parent: number) => {
    for (const id of kidsOf[parent] ?? []) {
      items[id] = comment(id, parent, kidsOf[id]);
      walk(id);
    }
  };
  walk(1);
  return { ...items, ...overrides };
}

// ---------------------------------------------------------------------------
// Truncation — terminal threads versus a maxComments cap
// ---------------------------------------------------------------------------

describe('hn_get_thread truncation', () => {
  let hn: ReturnType<typeof createMockHnService>;

  /** The mocked service answers without backoff, so no fake timers are needed. */
  function call(input: Record<string, unknown>): Promise<ToolResult> {
    return runToolContract(getThread, input as never, { context: { errors: getThread.errors } });
  }

  beforeEach(() => {
    hn = createMockHnService();
    (getHnService as Mock).mockReturnValue(hn);
  });

  it('reports a thread fully loaded at exactly maxComments as terminal', async () => {
    /** descendants 3, three comments across two levels, maxComments 3 — nothing left to fetch. */
    hn.fetchItem.mockResolvedValue({ ...mockStory, descendants: 3, kids: [10, 11] });
    hn.fetchItems
      .mockResolvedValueOnce(slotsOf([comment(10, 1, [20]), comment(11, 1)]))
      .mockResolvedValueOnce(slotsOf([comment(20, 10)]));

    const result = await call({ itemId: 1, depth: 10, maxComments: 3 });
    const sc = okStructured(result);

    expect(sc).toMatchObject({ totalLoaded: 3, totalAvailable: 3 });
    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('shown');
    expect(sc).not.toHaveProperty('cap');
    expect(sc).not.toHaveProperty('notice');
    expect(allText(result)).not.toContain('capped');
  });

  it('keeps truncated with guidance naming the cursor when the cap cut the thread short', async () => {
    hn.fetchItem.mockResolvedValue({ ...mockStory, descendants: 100, kids: [10, 11, 12] });
    hn.fetchItems.mockResolvedValueOnce(slotsOf([comment(10, 1), comment(11, 1), comment(12, 1)]));

    const result = await call({ itemId: 1, depth: 3, maxComments: 2 });
    const sc = okStructured(result);
    const notice = sc.notice as string;

    expect(sc).toMatchObject({
      totalLoaded: 2,
      truncated: true,
      shown: 2,
      cap: 2,
      truncationReason: 'count',
    });
    expect(typeof sc.nextCursor).toBe('string');
    expect(notice).toBe(
      'Stopped at maxComments 2 with 2/100 comments loaded. Pass nextCursor as cursor, with the same itemId, to continue.',
    );
    expect(notice).not.toContain('narrow with filters');
    expect(allText(result)).toContain(notice);
    expect(allText(result)).toContain(sc.nextCursor as string);
  });

  it('drops the raise-maxComments suggestion when maxComments is already at its max', async () => {
    const kids = Array.from({ length: 201 }, (_, i) => 1000 + i);
    hn.fetchItem.mockResolvedValue({ ...mockStory, descendants: 900, kids });
    hn.fetchItems.mockImplementation(async (ids: number[]) =>
      slotsOf(ids.map((id) => comment(id, 1))),
    );

    const notice = okStructured(await call({ itemId: 1, depth: 1, maxComments: 200 }))
      .notice as string;

    expect(notice).toBe(
      'Stopped at maxComments 200 with 200/900 comments loaded. Pass nextCursor as cursor, with the same itemId, to continue.',
    );
  });

  it('keeps truncated when the cap is hit and the root reports no descendants', async () => {
    const commentRoot: HnItem = {
      id: 10,
      type: 'comment',
      by: 'bob',
      text: 'root',
      kids: [20, 21, 22],
    };
    hn.fetchItem.mockResolvedValue(commentRoot);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([comment(20, 10), comment(21, 10)]));

    const sc = okStructured(await call({ itemId: 10, depth: 1, maxComments: 2 }));

    expect(sc).toMatchObject({ totalLoaded: 2, truncated: true, shown: 2, cap: 2 });
    expect(sc).not.toHaveProperty('totalAvailable');
    expect(sc.notice).toBe(
      'Stopped at maxComments 2. Pass nextCursor as cursor, with the same itemId, to continue.',
    );
  });

  it('reports a thread whose kids fit exactly in maxComments as terminal, even without descendants', async () => {
    hn.fetchItem.mockResolvedValue({ id: 10, type: 'comment', by: 'bob', kids: [20, 21] });
    hn.fetchItems.mockResolvedValueOnce(slotsOf([comment(20, 10), comment(21, 10)]));

    const sc = okStructured(await call({ itemId: 10, depth: 1, maxComments: 2 }));

    expect(sc).toMatchObject({ totalLoaded: 2 });
    for (const key of ['truncated', 'truncationReason', 'nextCursor', 'shown', 'cap', 'notice']) {
      expect(sc).not.toHaveProperty(key);
    }
  });

  it('hits the cap past the first level and still reports it as truncated', async () => {
    hn.fetchItem.mockResolvedValue({ ...mockStory, descendants: 10, kids: [10, 11] });
    hn.fetchItems
      .mockResolvedValueOnce(slotsOf([comment(10, 1, [20, 21, 22]), comment(11, 1, [23])]))
      .mockResolvedValueOnce(
        slotsOf([comment(20, 10, [30]), comment(21, 10), comment(22, 10), comment(23, 11)]),
      );

    const result = await call({ itemId: 1, depth: 5, maxComments: 4 });
    const sc = okStructured(result);
    const comments = sc.comments as Array<{ id: number; depth: number; parentId: number }>;

    expect(comments.map((c) => [c.id, c.depth, c.parentId])).toEqual([
      [10, 0, 1],
      [11, 0, 1],
      [20, 1, 10],
      [21, 1, 10],
    ]);
    expect(sc).toMatchObject({ totalLoaded: 4, truncated: true, cap: 4 });
    expect(sc.notice).toContain('4/10 comments loaded');
  });

  it('composes dropped deleted/dead counts with the truncation guidance', async () => {
    const byId: Record<number, HnItem> = {
      10: { id: 10, type: 'comment', deleted: true, parent: 1 },
      11: { id: 11, type: 'comment', dead: true, parent: 1 },
      12: comment(12, 1),
      13: comment(13, 1),
      14: comment(14, 1),
    };
    hn.fetchItem.mockResolvedValue({ ...mockStory, descendants: 50, kids: [10, 11, 12, 13, 14] });
    hn.fetchItems.mockImplementation(async (ids: number[]) => slotsOf(ids.map((id) => byId[id]!)));

    const result = await call({ itemId: 1, depth: 1, maxComments: 2 });
    const notice = okStructured(result).notice as string;

    expect(notice).toBe(
      '1 deleted, 1 dead — omitted from this view. Stopped at maxComments 2 with 2/50 comments loaded. Pass nextCursor as cursor, with the same itemId, to continue.',
    );
    expect(allText(result)).toContain(notice);
  });

  it('reports a depth cut, naming depth, when the cap was not hit but replies remain below it', async () => {
    hn.fetchItem.mockResolvedValue({ ...mockStory, descendants: 5, kids: [10, 11] });
    hn.fetchItems.mockResolvedValueOnce(slotsOf([comment(10, 1, [20]), comment(11, 1)]));

    const sc = okStructured(await call({ itemId: 1, depth: 1, maxComments: 50 }));

    expect(sc).toMatchObject({ truncated: true, truncationReason: 'depth' });
    expect(sc).not.toHaveProperty('nextCursor');
    expect(sc.notice).toBe(
      'The depth limit (1) left replies unread with 2/5 comments loaded. Raise depth (max 10), or pass the id of a depth-0 comment that shows replies as itemId to read its subtree.',
    );
  });

  it('drops the raise-depth suggestion when depth is already at its max', async () => {
    const chain = Array.from({ length: 11 }, (_, i) => 10 + i);
    const byId = Object.fromEntries(
      chain.map((id, i) => [id, comment(id, i === 0 ? 1 : id - 1, [id + 1])]),
    );
    hn.fetchItem.mockResolvedValue({ ...mockStory, descendants: 11, kids: [10] });
    hn.fetchItems.mockImplementation(async (ids: number[]) => slotsOf(ids.map((id) => byId[id]!)));

    const sc = okStructured(await call({ itemId: 1, depth: 10, maxComments: 50 }));

    expect(sc).toMatchObject({ totalLoaded: 10, truncationReason: 'depth' });
    expect(sc.notice).toBe(
      'The depth limit (10) left replies unread with 10/11 comments loaded. Pass the id of a depth-9 comment that shows replies as itemId to read its subtree.',
    );
  });
});

// ---------------------------------------------------------------------------
// Partial comment failures — the real HnService against a stubbed HN API
// ---------------------------------------------------------------------------

describe('hn_get_thread — partial comment failures', () => {
  /** Serve story 1 and every comment route given; each value is a body or an `httpStatus` route. */
  function thread(story: Partial<HnItem>, items: Record<number, unknown>) {
    return serveItems({
      1: { id: 1, type: 'story', by: 'op', title: 'Story', ...story },
      ...items,
    });
  }

  const call = (input: Record<string, unknown>) => callStubbed({ itemId: 1, ...input });

  beforeEach(() => {
    vi.useFakeTimers();
    (getHnService as Mock).mockReturnValue(new HnService(3));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('names a failed comment instead of blaming maxComments or depth', async () => {
    thread(
      { descendants: 3, kids: [201, 202, 203] },
      { 201: comment(201, 1), 202: httpStatus(500), 203: comment(203, 1) },
    );

    const result = await call({ depth: 1 });
    const sc = okStructured(result);
    const notice = sc.notice as string;

    expect(commentIds(sc)).toEqual([201, 203]);
    expect(sc).toMatchObject({ totalLoaded: 2, totalAvailable: 3, failedIds: [202] });
    expect(notice).toBe(
      'Could not fetch 1 comment (id 202); its replies were not reached either. Call again to retry, or pass an id as itemId to fetch that comment and its replies.',
    );
    expect(notice).not.toMatch(/raise maxComments/);

    const text = allText(result);
    expect(text).toContain('## Story');
    expect(text).toContain('(id:201');
    expect(text).toContain(notice);
    expect(text).toContain('**Failed to load:** 202');
  });

  it('reports a reply that fails two levels down', async () => {
    thread(
      { descendants: 5, kids: [10, 11] },
      {
        10: comment(10, 1, [20, 21]),
        11: comment(11, 1),
        20: comment(20, 10, [30]),
        21: httpStatus(500),
        30: comment(30, 20),
      },
    );

    const sc = okStructured(await call({ depth: 3 }));
    const comments = sc.comments as Array<{ id: number; depth: number; parentId: number }>;

    expect(comments.map((c) => [c.id, c.depth, c.parentId])).toEqual([
      [10, 0, 1],
      [11, 0, 1],
      [20, 1, 10],
      [30, 2, 20],
    ]);
    expect(sc.failedIds).toEqual([21]);
    expect(sc.notice).not.toMatch(/raise maxComments/);
  });

  it('still returns the root with every failed id listed when no comment loads', async () => {
    thread({ descendants: 2, kids: [10, 11] }, { 10: httpStatus(500), 11: httpStatus(500) });

    const result = await call({ depth: 2 });
    const sc = okStructured(result);

    expect(sc.item).toMatchObject({ id: 1, title: 'Story' });
    expect(sc.comments).toEqual([]);
    expect(sc).toMatchObject({ totalLoaded: 0, failedIds: [10, 11] });
    expect(sc.notice).toMatch(/^Could not fetch 2 comments \(ids 10, 11\); their replies/);
    expect(allText(result)).toContain('**Failed to load:** 10, 11');
  });

  it('keeps the depth hint alongside a failure when the depth limit also left replies unread', async () => {
    thread({ descendants: 3, kids: [10, 11] }, { 10: comment(10, 1, [20]), 11: httpStatus(500) });

    const sc = okStructured(await call({ depth: 1 }));

    expect(commentIds(sc)).toEqual([10]);
    expect(sc).toMatchObject({ truncationReason: 'depth' });
    expect(sc.notice).toBe(
      'Could not fetch 1 comment (id 11); its replies were not reached either. Call again to retry, or pass an id as itemId to fetch that comment and its replies. The depth limit (1) left replies unread with 1/3 comments loaded. Raise depth (max 10), or pass the id of a depth-0 comment that shows replies as itemId to read its subtree.',
    );
  });

  it('composes deleted/dead counts, the failure, and the maxComments cut', async () => {
    thread(
      { descendants: 50, kids: [10, 11, 12, 13, 14, 15] },
      {
        10: { id: 10, type: 'comment', deleted: true, parent: 1 },
        11: { id: 11, type: 'comment', dead: true, parent: 1 },
        12: httpStatus(500),
        13: comment(13, 1),
        14: comment(14, 1),
        15: comment(15, 1),
      },
    );

    const sc = okStructured(await call({ depth: 1, maxComments: 2 }));

    expect(commentIds(sc)).toEqual([13, 14]);
    expect(sc).toMatchObject({
      truncated: true,
      truncationReason: 'count',
      shown: 2,
      cap: 2,
      failedIds: [12],
    });
    expect(sc.notice).toBe(
      '1 deleted, 1 dead — omitted from this view. Could not fetch 1 comment (id 12); its replies were not reached either. nextCursor carries it, so continuing retries it; or pass an id as itemId to fetch that comment and its replies. Stopped at maxComments 2 with 2/50 comments loaded. Pass nextCursor as cursor, with the same itemId, to continue.',
    );
  });

  it('reports the comments a rate limit skipped as failed, and resumes them through the cursor', async () => {
    (getHnService as Mock).mockReturnValue(new HnService(1));
    const { requested } = thread(
      { descendants: 3, kids: [10, 11, 12] },
      { 10: comment(10, 1), 11: httpStatus(429, { 'Retry-After': '120' }), 12: comment(12, 1) },
    );

    const sc = okStructured(await call({ depth: 1 }));

    expect(requested()).toEqual(['/item/1.json', '/item/10.json', '/item/11.json']);
    expect(commentIds(sc)).toEqual([10]);
    expect(sc).toMatchObject({
      failedIds: [11, 12],
      truncated: true,
      truncationReason: 'rate_limited',
    });
    expect(sc.notice).toBe(
      'Could not fetch 2 comments (ids 11, 12); their replies were not reached either. nextCursor carries them, so continuing retries them; or pass an id as itemId to fetch that comment and its replies. Stopped early: the HN API is rate-limiting this server with 1/3 comments loaded. Wait 120 seconds, then pass nextCursor as cursor, with the same itemId, to resume; comments that failed to load are retried first.',
    );

    thread(
      { descendants: 3, kids: [10, 11, 12] },
      { 10: comment(10, 1), 11: comment(11, 1), 12: comment(12, 1) },
    );
    const next = okStructured(await call({ depth: 1, cursor: sc.nextCursor }));
    expect(commentIds(next)).toEqual([11, 12]);
    expect(next).not.toHaveProperty('truncated');
  });

  it('carries no failure field or failure notice when every comment loaded', async () => {
    thread({ descendants: 2, kids: [10, 11] }, { 10: comment(10, 1), 11: comment(11, 1) });

    const result = await call({ depth: 1 });
    const sc = okStructured(result);

    expect(sc).not.toHaveProperty('failedIds');
    expect(sc).not.toHaveProperty('notice');
    expect(allText(result)).not.toContain('Failed to load');
  });

  it('fails the call only when the root itself cannot be fetched', async () => {
    stubHnApi({ '/item/1.json': httpStatus(500) });

    const result = await call({ depth: 1 });
    const error = (result.structuredContent as { error: { data: Record<string, unknown> } }).error;

    expect(result.isError).toBe(true);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 500 });
  });
});

// ---------------------------------------------------------------------------
// #19 — root relationships, state, and poll options
// ---------------------------------------------------------------------------

describe('hn_get_thread — root relationships and state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (getHnService as Mock).mockReturnValue(new HnService(3));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const poll = {
    id: 126809,
    type: 'poll',
    by: 'pg',
    title: 'Poll: explicit polls?',
    score: 47,
    descendants: 2,
    kids: [126822, 126823],
    parts: [126810, 126811, 126812],
  };
  const option = (id: number, text: string, score: number) => ({
    id,
    type: 'pollopt',
    by: 'pg',
    poll: 126809,
    text,
    score,
  });
  const pollComment = (id: number) => ({
    id,
    type: 'comment',
    by: `u${id}`,
    text: `c${id}`,
    parent: 126809,
  });

  it('resolves a poll root’s options at depth 0, in parts order, on both surfaces', async () => {
    serveItems({
      126809: poll,
      126810: option(126810, 'Yes', 30),
      126811: option(126811, 'No', 12),
      126812: option(126812, 'Maybe', 5),
    });

    const result = await callStubbed({ itemId: 126809, depth: 0 });
    const sc = okStructured(result);

    expect(sc.item).toMatchObject({
      id: 126809,
      type: 'poll',
      parts: [126810, 126811, 126812],
      options: [
        { id: 126810, text: 'Yes', score: 30 },
        { id: 126811, text: 'No', score: 12 },
        { id: 126812, text: 'Maybe', score: 5 },
      ],
    });
    expect(sc).toMatchObject({ totalLoaded: 0 });
    const text = allText(result);
    expect(text).toContain('## Poll: explicit polls?');
    expect(text).toContain('parts:126810,126811,126812');
    expect(text).toMatch(/id:126810 \| 30 pts: Yes/);
    expect(text.indexOf('id:126810')).toBeLessThan(text.indexOf('id:126812'));
  });

  it('keeps options out of maxComments and totalLoaded at depth > 0', async () => {
    serveItems({
      126809: poll,
      126810: option(126810, 'Yes', 30),
      126811: option(126811, 'No', 12),
      126812: option(126812, 'Maybe', 5),
      126822: pollComment(126822),
      126823: pollComment(126823),
    });

    const sc = okStructured(await callStubbed({ itemId: 126809, depth: 1, maxComments: 2 }));

    expect(commentIds(sc)).toEqual([126822, 126823]);
    expect((sc.item as { options: unknown[] }).options).toHaveLength(3);
    expect(sc).toMatchObject({ totalLoaded: 2 });
    expect(sc).not.toHaveProperty('truncated');
  });

  it('marks deleted and dead options and reports a failed option the #18 way', async () => {
    serveItems({
      126809: { ...poll, kids: undefined, descendants: 0 },
      126810: { id: 126810, type: 'pollopt', deleted: true, poll: 126809 },
      126811: { ...option(126811, '[flagged]', 1), dead: true },
      126812: httpStatus(500),
    });

    const result = await callStubbed({ itemId: 126809, depth: 0 });
    const sc = okStructured(result);

    expect((sc.item as { options: unknown[] }).options).toEqual([
      { id: 126810, deleted: true },
      { id: 126811, text: '[flagged]', score: 1, dead: true },
    ]);
    expect(sc.failedIds).toEqual([126812]);
    expect(sc.notice).toMatch(/Could not fetch 1 poll option \(id 126812\)/);
    const text = allText(result);
    expect(text).toContain('id:126810 | [deleted]');
    expect(text).toContain('id:126811 | [dead] | 1 pts: [flagged]');
    expect(text).toContain('**Failed to load:** 126812');
  });

  it('names the parent poll on a poll-option root', async () => {
    serveItems({ 160705: option(160705, 'Yes, ban them', 335) });

    const result = await callStubbed({ itemId: 160705, depth: 0 });
    const sc = okStructured(result);

    expect(sc.item).toMatchObject({ id: 160705, type: 'pollopt', poll: 126809 });
    expect(sc.item).not.toHaveProperty('parent');
    const text = allText(result);
    expect(text).toContain('## Poll option by pg on poll 126809');
    expect(text).toContain('poll:126809');
    expect(text).not.toContain('Comment by');
  });

  it('carries a comment root’s parent on both surfaces', async () => {
    serveItems({
      39667625: { id: 39667625, type: 'comment', by: 'pg', text: 'drafts', parent: 39662907 },
    });

    const result = await callStubbed({ itemId: 39667625, depth: 0 });

    expect(okStructured(result).item).toMatchObject({ parent: 39662907 });
    expect(allText(result)).toMatch(/id:39667625 \| type:comment \| parent:39662907/);
  });

  it('marks a deleted root instead of rendering it as "by unknown", and still walks its replies', async () => {
    serveItems({
      49258552: {
        id: 49258552,
        type: 'comment',
        deleted: true,
        parent: 49257377,
        time: 1786456918,
        kids: [5],
      },
      5: { id: 5, type: 'comment', by: 'x', text: 'reply', parent: 49258552 },
    });

    const result = await callStubbed({ itemId: 49258552, depth: 1 });
    const sc = okStructured(result);

    expect(sc.item).toMatchObject({ deleted: true, parent: 49257377 });
    expect(sc.item).not.toHaveProperty('dead');
    expect(commentIds(sc)).toEqual([5]);
    const text = allText(result);
    expect(text).toContain('## [deleted] Comment');
    expect(text).not.toContain('by unknown');
  });

  it('marks a dead root', async () => {
    serveItems({
      49258793: {
        id: 49258793,
        type: 'comment',
        by: 'nipunaeka89',
        dead: true,
        text: '[flagged]',
        parent: 49254880,
      },
    });

    const result = await callStubbed({ itemId: 49258793, depth: 0 });

    expect(okStructured(result).item).toMatchObject({ dead: true });
    expect(allText(result)).toContain('## [dead] Comment by nipunaeka89');
  });

  it('keeps absent relationship and state fields absent on a sparse story root', async () => {
    serveItems({ 1: { id: 1, type: 'story', by: 'op', title: 'Story' } });

    const item = okStructured(await callStubbed({ itemId: 1, depth: 0 })).item as object;

    for (const key of ['parent', 'poll', 'parts', 'options', 'deleted', 'dead']) {
      expect(Object.hasOwn(item, key)).toBe(false);
    }
  });

  it('heads an untitled story by type, not as a comment', async () => {
    serveItems({ 99: { id: 99, type: 'story', by: 'op' } });

    expect(allText(await callStubbed({ itemId: 99, depth: 0 }))).toContain('## Story by op');
  });
});

// ---------------------------------------------------------------------------
// #20 — resumable traversal
// ---------------------------------------------------------------------------

describe('hn_get_thread — resumable traversal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (getHnService as Mock).mockReturnValue(new HnService(3));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Follow nextCursor from a first call to the last page, collecting every page. */
  async function readAll(input: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const pages: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    do {
      const sc = okStructured(await callStubbed({ ...input, ...(cursor && { cursor }) }));
      pages.push(sc);
      cursor = sc.nextCursor as string | undefined;
      expect(pages.length).toBeLessThan(50);
    } while (cursor);
    return pages;
  }

  /** Three levels, a deleted top-level comment, and a deleted reply. */
  const multiLevel = () =>
    storyTree(
      {
        1: [100, 101, 102, 103, 104],
        100: [110, 111, 112],
        101: [113],
        103: [114, 115],
        110: [120, 121],
        113: [122],
        115: [123, 124, 125],
        121: [130],
      },
      {
        102: { id: 102, type: 'comment', deleted: true, parent: 1 },
        112: { id: 112, type: 'comment', dead: true, parent: 100 },
      },
      { descendants: 21 },
    );

  it('pages a multi-level thread to completion, yielding every live comment exactly once in BFS order', async () => {
    serveItems(multiLevel());

    const [uncut] = await readAll({ itemId: 1, depth: 10, maxComments: 200 });
    const pages = await readAll({ itemId: 1, depth: 10, maxComments: 3 });

    const paged = pages.flatMap(commentIds);
    expect(paged).toEqual(commentIds(uncut!));
    expect(new Set(paged).size).toBe(paged.length);
    expect(paged).toEqual([
      100, 101, 103, 104, 110, 111, 113, 114, 115, 120, 121, 122, 123, 124, 125, 130,
    ]);

    /** Every page but the last is a count cut carrying a cursor; the last carries neither. */
    for (const page of pages.slice(0, -1)) {
      expect(page).toMatchObject({ truncated: true, truncationReason: 'count', cap: 3 });
      expect(typeof page.nextCursor).toBe('string');
      expect(page.notice).toMatch(/nextCursor/);
    }
    const last = pages.at(-1)!;
    for (const key of ['truncated', 'truncationReason', 'nextCursor', 'shown', 'cap']) {
      expect(last).not.toHaveProperty(key);
    }
    /** Depth, parentId, and isOp survive the page boundary. */
    const c130 = pages.flatMap((p) => p.comments as Array<Record<string, unknown>>).at(-1);
    expect(c130).toMatchObject({ id: 130, depth: 3, parentId: 121 });
  });

  it('fills a page past a run of deleted kids and never drops later siblings', async () => {
    const kids = Array.from({ length: 30 }, (_, i) => 1001 + i);
    const deleted = Object.fromEntries(
      kids
        .slice(0, 21)
        .map((id) => [id, { id, type: 'comment', deleted: true, parent: 1 }] as const),
    );
    serveItems(storyTree({ 1: kids }, deleted, { descendants: 30 }));

    const first = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 5 }));

    expect(commentIds(first)).toEqual([1022, 1023, 1024, 1025, 1026]);
    expect(first).toMatchObject({ truncated: true, truncationReason: 'count' });

    const rest = okStructured(
      await callStubbed({ itemId: 1, depth: 1, maxComments: 5, cursor: first.nextCursor }),
    );
    expect(commentIds(rest)).toEqual([1027, 1028, 1029, 1030]);
    expect(rest).not.toHaveProperty('nextCursor');
  });

  it('keeps its place when HN re-ranks the kids between pages', async () => {
    const tree = storyTree({ 1: [10, 11, 12, 13] }, {}, { descendants: 4 });
    serveItems(tree);
    const first = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 2 }));
    expect(commentIds(first)).toEqual([10, 11]);

    serveItems({ ...tree, 1: { ...(tree[1] as object), kids: [13, 12, 11, 10] } });
    const second = okStructured(
      await callStubbed({ itemId: 1, depth: 1, maxComments: 2, cursor: first.nextCursor }),
    );

    expect(commentIds(second)).toEqual([12, 13]);
  });

  it('applies the depth the cursor carries, not the depth passed with it', async () => {
    serveItems(storyTree({ 1: [10, 11], 10: [20], 20: [30] }, {}, { descendants: 4 }));

    const first = okStructured(await callStubbed({ itemId: 1, depth: 3, maxComments: 1 }));
    const pages = [first];
    let cursor = first.nextCursor as string | undefined;
    while (cursor) {
      const page = okStructured(await callStubbed({ itemId: 1, cursor, depth: 1, maxComments: 1 }));
      pages.push(page);
      cursor = page.nextCursor as string | undefined;
    }

    expect(pages.flatMap(commentIds)).toEqual([10, 11, 20, 30]);
  });

  it('cuts at the response budget between comments and resumes after the last one shown', async () => {
    const long = (id: number) => ({
      id,
      type: 'comment',
      by: `u${id}`,
      text: 'x'.repeat(20_000),
      parent: 1,
    });
    serveItems(
      storyTree(
        { 1: [10, 11, 12, 13, 14] },
        { 10: long(10), 11: long(11), 12: long(12), 13: long(13), 14: long(14) },
        { descendants: 5 },
      ),
    );

    const first = await callStubbed({ itemId: 1, depth: 1, maxComments: 50 });
    const sc = okStructured(first);

    expect(commentIds(sc)).toEqual([10, 11, 12]);
    expect(sc).toMatchObject({ truncated: true, truncationReason: 'size', shown: 3 });
    expect(sc.notice).toMatch(/64,000-byte/);
    const rendered = getThread.format!(sc as never)[0] as { text: string };
    expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(64_000);
    expect(allText(first)).toContain(sc.notice as string);

    const next = okStructured(
      await callStubbed({ itemId: 1, depth: 1, maxComments: 50, cursor: sc.nextCursor }),
    );
    expect(commentIds(next)).toEqual([13, 14]);
    expect(next).not.toHaveProperty('truncated');
  });

  it('returns a single comment larger than the budget whole', async () => {
    const huge = 'y'.repeat(100_000);
    serveItems(
      storyTree(
        { 1: [10, 11] },
        { 10: { id: 10, type: 'comment', by: 'big', text: huge, parent: 1 } },
        { descendants: 2 },
      ),
    );

    const sc = okStructured(await callStubbed({ itemId: 1, depth: 1 }));
    const comments = sc.comments as Array<{ id: number; text: string }>;

    expect(comments).toHaveLength(1);
    expect(comments[0]!.text).toBe(huge);
    expect(sc).toMatchObject({ truncated: true, truncationReason: 'size' });

    const next = okStructured(await callStubbed({ itemId: 1, depth: 1, cursor: sc.nextCursor }));
    expect(commentIds(next)).toEqual([11]);
  });

  it('reports a depth cut on a comment root with no totalAvailable, naming depth rather than the cursor', async () => {
    serveItems({
      10: { id: 10, type: 'comment', by: 'bob', text: 'root', kids: [20] },
      20: { id: 20, type: 'comment', by: 'c', text: 'r', parent: 10, kids: [30] },
    });

    const result = await callStubbed({ itemId: 10, depth: 1 });
    const sc = okStructured(result);

    expect(commentIds(sc)).toEqual([20]);
    expect(sc).toMatchObject({ truncated: true, truncationReason: 'depth' });
    expect(sc).not.toHaveProperty('nextCursor');
    expect(sc).not.toHaveProperty('totalAvailable');
    expect(sc.notice).toMatch(/depth/);
    expect(sc.notice).not.toMatch(/cursor/i);
    expect(allText(result)).toContain(sc.notice as string);
  });

  it('lets the cursor reason win when a count cut and a depth cut both apply', async () => {
    serveItems(storyTree({ 1: [10, 11], 10: [20] }, {}, { descendants: 3 }));

    const sc = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 1 }));

    expect(sc).toMatchObject({ truncationReason: 'count' });
    const last = okStructured(
      await callStubbed({ itemId: 1, depth: 1, maxComments: 1, cursor: sc.nextCursor }),
    );
    expect(commentIds(last)).toEqual([11]);
    expect(last).toMatchObject({ truncated: true, truncationReason: 'depth' });
  });

  it('carries no truncation fields on a terminal page', async () => {
    serveItems(storyTree({ 1: [10, 11] }, {}, { descendants: 2 }));

    const result = await callStubbed({ itemId: 1, depth: 3 });
    const sc = okStructured(result);

    for (const key of ['truncated', 'truncationReason', 'nextCursor', 'shown', 'cap', 'notice']) {
      expect(sc).not.toHaveProperty(key);
    }
    expect(allText(result)).not.toMatch(/cursor/i);
  });

  it('returns an empty terminal page for a story with no comments', async () => {
    serveItems({ 1: { id: 1, type: 'story', by: 'op', title: 'Quiet', descendants: 0 } });

    const sc = okStructured(await callStubbed({ itemId: 1, depth: 3 }));

    expect(sc.comments).toEqual([]);
    expect(sc).toMatchObject({ totalLoaded: 0 });
    expect(sc).not.toHaveProperty('truncated');
  });

  it('ends cleanly when a cursor points past the end of what remains', async () => {
    const tree = storyTree({ 1: [10, 11, 12] }, {}, { descendants: 3 });
    serveItems(tree);
    const first = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 1 }));

    serveItems({
      ...tree,
      11: { id: 11, type: 'comment', deleted: true, parent: 1 },
      12: null,
    });
    const next = okStructured(
      await callStubbed({ itemId: 1, depth: 1, maxComments: 1, cursor: first.nextCursor }),
    );

    expect(next.comments).toEqual([]);
    expect(next).not.toHaveProperty('truncated');
    expect(next).not.toHaveProperty('nextCursor');
    expect(next.notice).toMatch(/1 deleted/);
  });

  it('says the thread is read to the end when a cursor page finds nothing left at all', async () => {
    const tree = storyTree({ 1: [10, 11] }, {}, { descendants: 2 });
    serveItems(tree);
    const first = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 1 }));

    serveItems({ ...tree, 11: null });
    const result = await callStubbed({
      itemId: 1,
      depth: 1,
      maxComments: 1,
      cursor: first.nextCursor,
    });
    const next = okStructured(result);

    expect(next.comments).toEqual([]);
    expect(next).not.toHaveProperty('truncated');
    expect(next.notice).toBe(
      'No comments remain past this cursor; the thread has been read to the end.',
    );
    expect(allText(result)).toContain(next.notice as string);
  });

  it('rejects a cursor passed with a different itemId as invalid_cursor', async () => {
    serveItems(storyTree({ 1: [10, 11] }, {}, { descendants: 2 }));
    const first = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 1 }));

    const result = await callStubbed({ itemId: 2, cursor: first.nextCursor });
    const error = wireError(result);

    expect(error.data).toMatchObject({ reason: 'invalid_cursor' });
    expect(allText(result)).toMatch(/same itemId/);
  });

  it.each([
    ['not base64 JSON', '%%%not-a-cursor'],
    ['a generic pagination cursor', encodeCursor({ offset: 0, limit: 10 })],
    [
      'a frontier level at or past its depth',
      encodeCursor({ offset: 0, limit: 10, itemId: 1, depth: 1, frontier: [[1, 1, 10]] }),
    ],
  ])('rejects a malformed cursor (%s) as an input error', async (_label, cursor) => {
    serveItems(storyTree({ 1: [10] }, {}, { descendants: 1 }));

    const error = wireError(await callStubbed({ itemId: 1, cursor }));

    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).not.toBe('invalid_cursor');
  });

  it('carries a failed comment in the cursor so the next page retries it', async () => {
    const tree = storyTree({ 1: [10, 11, 12, 13] }, { 11: httpStatus(500) }, { descendants: 4 });
    serveItems(tree);

    const first = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 2 }));
    expect(commentIds(first)).toEqual([10, 12]);
    expect(first).toMatchObject({ failedIds: [11], truncationReason: 'count' });
    expect(first.notice).toMatch(/Could not fetch 1 comment \(id 11\).*nextCursor/);

    serveItems(storyTree({ 1: [10, 11, 12, 13] }, {}, { descendants: 4 }));
    const next = okStructured(
      await callStubbed({ itemId: 1, depth: 1, maxComments: 2, cursor: first.nextCursor }),
    );
    expect(commentIds(next)).toEqual([11, 13]);
    expect(next).not.toHaveProperty('failedIds');
  });

  it('stops descending after a rate limit and resumes from the cursor', async () => {
    (getHnService as Mock).mockReturnValue(new HnService(1));
    const tree = storyTree({ 1: [10, 11, 12], 10: [20] }, {}, { descendants: 4 });
    const { requested } = serveItems({ ...tree, 11: httpStatus(429, { 'Retry-After': '120' }) });

    const first = okStructured(await callStubbed({ itemId: 1, depth: 3 }));

    expect(requested()).toEqual(['/item/1.json', '/item/10.json', '/item/11.json']);
    expect(commentIds(first)).toEqual([10]);
    expect(first).toMatchObject({
      failedIds: [11, 12],
      truncated: true,
      truncationReason: 'rate_limited',
    });
    expect(first.notice).toMatch(/120 seconds/);

    serveItems(tree);
    const next = okStructured(await callStubbed({ itemId: 1, depth: 3, cursor: first.nextCursor }));
    expect(commentIds(next)).toEqual([11, 12, 20]);
    expect(next).not.toHaveProperty('nextCursor');
  });

  it('names the cursor instead of maxComments when the cap is already at its max', async () => {
    const kids = Array.from({ length: 201 }, (_, i) => 1000 + i);
    serveItems(storyTree({ 1: kids }, {}, { descendants: 201 }));

    const sc = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 200 }));

    expect(sc).toMatchObject({ totalLoaded: 200, truncationReason: 'count' });
    expect(sc.notice).not.toMatch(/Raise maxComments/);
    expect(sc.notice).toMatch(/nextCursor/);
  });

  it('bounds the items one call examines, then resumes past a long run of deleted comments', async () => {
    const kids = Array.from({ length: 1_005 }, (_, i) => 10_000 + i);
    const deleted = Object.fromEntries(
      kids
        .slice(0, 1_002)
        .map((id) => [id, { id, type: 'comment', deleted: true, parent: 1 }] as const),
    );
    const { requested } = serveItems(storyTree({ 1: kids }, deleted, { descendants: 1_005 }));

    const first = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 5 }));

    expect(requested()).toHaveLength(1 + 1_000);
    expect(first.comments).toEqual([]);
    expect(first).toMatchObject({ truncated: true, truncationReason: 'count' });
    expect(first.notice).toMatch(/Stopped after examining 1,000 items in one call/);

    const next = okStructured(
      await callStubbed({ itemId: 1, depth: 1, maxComments: 5, cursor: first.nextCursor }),
    );
    expect(commentIds(next)).toEqual([11_002, 11_003, 11_004]);
    expect(next).not.toHaveProperty('nextCursor');
  });

  it('skips the traversal when the poll-option fetch is rate-limited, leaving it to the cursor', async () => {
    (getHnService as Mock).mockReturnValue(new HnService(1));
    const poll = {
      id: 1,
      type: 'poll',
      by: 'op',
      title: 'Poll',
      descendants: 1,
      kids: [10],
      parts: [2],
    };
    const { requested } = serveItems({ 1: poll, 2: httpStatus(429), 10: null });

    const first = okStructured(await callStubbed({ itemId: 1, depth: 1 }));

    expect(requested().filter((path) => path === '/item/10.json')).toEqual([]);
    expect(first).toMatchObject({ failedIds: [2], truncationReason: 'rate_limited' });

    serveItems({
      1: poll,
      2: { id: 2, type: 'pollopt', poll: 1, text: 'Yes', score: 1 },
      10: { id: 10, type: 'comment', by: 'u', text: 't', parent: 1 },
    });
    const next = okStructured(await callStubbed({ itemId: 1, depth: 1, cursor: first.nextCursor }));
    expect(commentIds(next)).toEqual([10]);
    expect(next).not.toHaveProperty('failedIds');
  });
});
