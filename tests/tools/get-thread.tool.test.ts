/**
 * @fileoverview Tests for the hn_get_thread tool — item lookup and ranked BFS comment traversal.
 * @module mcp-server/tools/definitions/get-thread.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext as createFrameworkMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor, logger } from '@cyanheads/mcp-ts-core/utils';
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
import { encodeThreadCursor } from '@/mcp-server/tools/thread-cursor.js';
import {
  getHnService,
  HnService,
  type ItemSlot,
  normalizeUrl,
  stripHtml,
} from '@/services/hn/hn-service.js';
import { httpStatus, rejectUnmockedFetch, stall, stubHnApi } from '../helpers/hn-api-stub.js';

rejectUnmockedFetch();

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
      parent: 1,
      kids: [20, 21, 22],
    };
    const reply1: HnItem = { id: 20, type: 'comment', by: 'carol', text: 'r1', parent: 10 };
    const reply2: HnItem = { id: 21, type: 'comment', by: 'dave', text: 'r2', parent: 10 };
    hn.fetchItem.mockResolvedValue(commentRoot);
    hn.fetchItems
      .mockResolvedValueOnce(slotsOf([mockStory]))
      .mockResolvedValueOnce(slotsOf([reply1, reply2]));

    await getThread.handler(parse({ itemId: 10, depth: 1, maxComments: 2 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(Object.hasOwn(enrichment, 'totalAvailable')).toBe(false);
    /** Truncation fields are unaffected — they must still render. */
    expect(enrichment).toMatchObject({ totalLoaded: 2, truncated: true, shown: 2, cap: 2 });
  });

  it('omits the totalAvailable key on the depth-0 path when the root reports no descendants', async () => {
    const commentRoot: HnItem = {
      id: 10,
      type: 'comment',
      by: 'bob',
      text: 'root',
      parent: 1,
      kids: [20],
    };
    hn.fetchItem.mockResolvedValue(commentRoot);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([mockStory]));

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

  it('calls stripHtml on item text and comment text, and keeps the title verbatim', async () => {
    /** Titles are plain text in the HN API, so a title that reads as a tag is kept as typed. */
    const storyWithText: HnItem = { ...mockStory, text: '<p>Hello</p>', title: '<b>Title</b>' };
    const { kids: _k, ...comment1Base } = mockComment1;
    const commentWithHtml: HnItem = { ...comment1Base, text: '<i>Styled</i>' };
    hn.fetchItem.mockResolvedValue(storyWithText);
    hn.fetchItems.mockResolvedValueOnce(slotsOf([commentWithHtml]));

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(stripHtml).toHaveBeenCalledWith('<p>Hello</p>');
    expect(stripHtml).toHaveBeenCalledWith('<i>Styled</i>');
    expect(stripHtml).not.toHaveBeenCalledWith('<b>Title</b>');
    expect(result.item.title).toBe('<b>Title</b>');
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
    expect(text).toContain('\n  > Nested reply');
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

  it('defaults depth to 3 and accepts 0 up to the 100 ceiling', () => {
    const defaults = getThread.input.parse({ itemId: 1 });
    expect(defaults.depth).toBe(3);

    const zero = getThread.input.parse({ itemId: 1, depth: 0 });
    expect(zero.depth).toBe(0);

    const ten = getThread.input.parse({ itemId: 1, depth: 10 });
    expect(ten.depth).toBe(10);

    expect(getThread.input.parse({ itemId: 1, depth: 11 }).depth).toBe(11);
    expect(getThread.input.parse({ itemId: 1, depth: 100 }).depth).toBe(100);

    expect(() => getThread.input.parse({ itemId: 1, depth: -1 })).toThrow();
    expect(() => getThread.input.parse({ itemId: 1, depth: 101 })).toThrow();
  });

  it('defaults maxComments to 50 and accepts 1 up to the 1,000 ceiling', () => {
    const defaults = getThread.input.parse({ itemId: 1 });
    expect(defaults.maxComments).toBe(50);

    const one = getThread.input.parse({ itemId: 1, maxComments: 1 });
    expect(one.maxComments).toBe(1);

    const max = getThread.input.parse({ itemId: 1, maxComments: 200 });
    expect(max.maxComments).toBe(200);

    expect(getThread.input.parse({ itemId: 1, maxComments: 201 }).maxComments).toBe(201);
    expect(getThread.input.parse({ itemId: 1, maxComments: 1000 }).maxComments).toBe(1000);

    expect(() => getThread.input.parse({ itemId: 1, maxComments: 0 })).toThrow();
    expect(() => getThread.input.parse({ itemId: 1, maxComments: 1001 })).toThrow();
  });

  it('advertises the ceilings and describes each per-call cap', () => {
    const schema = z.toJSONSchema(getThread.input) as {
      properties: Record<string, { maximum?: number; description?: string }>;
    };
    const { depth, maxComments } = schema.properties;

    expect(depth?.maximum).toBe(100);
    expect(depth?.description).toMatch(/at most 10 per call/);
    expect(depth?.description).toMatch(/served at 10\b/);
    expect(maxComments?.maximum).toBe(1000);
    expect(maxComments?.description).toMatch(/at most 200 per call/);
    expect(maxComments?.description).toMatch(/served at 200\b/);
  });

  it('describes a missing isOp as unknown when the root has no author, as well as when notice says so', () => {
    const output = z.toJSONSchema(getThread.output) as unknown as {
      properties: {
        comments: { items: { properties: Record<string, { description?: string }> } };
      };
    };
    const description = output.properties.comments.items.properties.isOp?.description;

    expect(description).toMatch(/unknown when the thread's root has no author/);
    expect(description).toMatch(/or when notice says replies are not marked/);
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
function serveItems(items: Record<number, unknown>, options?: Parameters<typeof stubHnApi>[1]) {
  return stubHnApi(
    Object.fromEntries(Object.entries(items).map(([id, body]) => [`/item/${id}.json`, body])),
    options,
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

/**
 * The first page of story 49522897 at depth 3 and maxComments 10, as the HN API
 * served it: the ten top-level replies returned, the replies queued under them,
 * and the 289 top-level replies left unread, each list in HN's ranked order. A
 * deleted top-level reply the page skipped is left out; the cursor never carries
 * it.
 */
const SPARSE_THREAD = {
  storyId: 49_522_897,
  returned: [
    49_523_712, 49_523_950, 49_524_580, 49_527_388, 49_525_651, 49_523_835, 49_525_748, 49_533_854,
    49_526_742, 49_524_979,
  ],
  repliesQueued: {
    49523950: [49_657_894],
    49524580: [49_532_514, 49_524_670, 49_644_023],
    49523835: [49_650_652, 49_528_739],
    49524979: [49_525_532],
  } as Record<number, number[]>,
  unread: [
    49_525_241, 49_524_835, 49_525_423, 49_523_166, 49_531_126, 49_523_018, 49_527_452, 49_522_989,
    49_531_439, 49_524_350, 49_547_973, 49_528_935, 49_524_943, 49_523_770, 49_528_132, 49_523_176,
    49_524_167, 49_525_468, 49_532_898, 49_538_639, 49_523_228, 49_530_867, 49_526_894, 49_615_973,
    49_543_040, 49_524_327, 49_553_487, 49_525_549, 49_527_118, 49_522_929, 49_532_154, 49_532_957,
    49_522_912, 49_533_274, 49_530_430, 49_523_740, 49_523_808, 49_522_949, 49_524_920, 49_524_781,
    49_524_502, 49_530_424, 49_523_978, 49_711_313, 49_686_668, 49_525_053, 49_523_123, 49_524_822,
    49_528_044, 49_662_536, 49_650_855, 49_524_287, 49_532_978, 49_529_015, 49_525_141, 49_524_691,
    49_528_405, 49_571_280, 49_656_171, 49_573_833, 49_523_875, 49_664_325, 49_595_476, 49_709_464,
    49_567_458, 49_529_454, 49_626_445, 49_553_119, 49_524_880, 49_523_604, 49_530_909, 49_523_974,
    49_523_408, 49_576_039, 49_559_434, 49_550_471, 49_559_854, 49_643_998, 49_524_080, 49_543_632,
    49_562_891, 49_527_375, 49_526_361, 49_524_060, 49_528_336, 49_525_399, 49_528_943, 49_552_564,
    49_534_270, 49_527_181, 49_539_168, 49_530_256, 49_529_763, 49_528_637, 49_526_938, 49_527_588,
    49_527_115, 49_537_373, 49_530_464, 49_525_348, 49_527_133, 49_578_811, 49_555_479, 49_523_288,
    49_627_985, 49_527_113, 49_527_283, 49_524_406, 49_540_773, 49_552_294, 49_524_520, 49_531_417,
    49_531_109, 49_537_891, 49_649_994, 49_553_901, 49_524_341, 49_534_647, 49_546_958, 49_530_381,
    49_667_711, 49_531_416, 49_525_116, 49_543_579, 49_533_419, 49_550_509, 49_525_600, 49_540_382,
    49_525_331, 49_526_311, 49_562_582, 49_523_956, 49_526_478, 49_524_031, 49_523_289, 49_564_474,
    49_528_399, 49_524_731, 49_526_396, 49_554_223, 49_523_768, 49_523_716, 49_528_234, 49_533_482,
    49_564_322, 49_523_704, 49_541_500, 49_538_758, 49_611_044, 49_542_221, 49_541_874, 49_532_941,
    49_528_837, 49_526_831, 49_525_729, 49_609_343, 49_524_737, 49_525_714, 49_528_413, 49_532_457,
    49_525_367, 49_541_233, 49_530_924, 49_550_510, 49_534_032, 49_528_364, 49_541_107, 49_527_209,
    49_570_095, 49_552_714, 49_533_651, 49_525_463, 49_525_412, 49_530_558, 49_661_611, 49_539_823,
    49_597_839, 49_525_183, 49_525_270, 49_534_359, 49_612_508, 49_524_978, 49_527_374, 49_525_078,
    49_530_894, 49_538_902, 49_523_175, 49_531_002, 49_525_497, 49_544_301, 49_608_356, 49_598_799,
    49_538_090, 49_528_608, 49_525_831, 49_530_057, 49_532_070, 49_530_452, 49_527_344, 49_645_329,
    49_529_054, 49_523_797, 49_601_673, 49_538_459, 49_585_505, 49_525_135, 49_523_896, 49_529_957,
    49_523_985, 49_528_737, 49_535_156, 49_523_510, 49_524_252, 49_534_764, 49_522_903, 49_531_646,
    49_525_750, 49_530_020, 49_546_936, 49_532_259, 49_523_666, 49_526_601, 49_528_002, 49_615_435,
    49_527_716, 49_525_147, 49_523_623, 49_541_388, 49_532_122, 49_524_501, 49_525_267, 49_526_154,
    49_528_822, 49_625_444, 49_526_803, 49_555_567, 49_546_647, 49_549_234, 49_525_418, 49_613_617,
    49_530_873, 49_527_193, 49_525_544, 49_527_646, 49_525_548, 49_523_703, 49_713_455, 49_533_498,
    49_642_977, 49_635_387, 49_598_051, 49_542_805, 49_537_584, 49_530_116, 49_528_686, 49_525_483,
    49_523_558, 49_523_041, 49_526_541, 49_527_999, 49_613_305, 49_547_648, 49_560_443, 49_682_345,
    49_548_741, 49_528_355, 49_536_190, 49_523_584, 49_540_487, 49_524_765, 49_567_708, 49_523_446,
    49_523_806, 49_562_366, 49_524_542, 49_522_930, 49_524_121, 49_547_792, 49_523_194, 49_526_149,
    49_523_422, 49_541_660, 49_527_354, 49_528_956, 49_525_603, 49_529_518, 49_523_675, 49_524_180,
    49_523_830,
  ],
};

/** Serve {@link SPARSE_THREAD} as live items under the real story id. */
function serveSparseThread() {
  const { storyId, returned, repliesQueued, unread } = SPARSE_THREAD;
  const items: Record<number, unknown> = {
    [storyId]: {
      id: storyId,
      type: 'story',
      by: 'op',
      title: 'Story',
      kids: [...returned, ...unread],
    },
  };
  for (const id of [...returned, ...unread]) items[id] = comment(id, storyId, repliesQueued[id]);
  for (const [parent, ids] of Object.entries(repliesQueued)) {
    for (const id of ids) items[id] = comment(id, Number(parent));
  }
  return serveItems(items);
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
      parent: 1,
      kids: [20, 21, 22],
    };
    hn.fetchItem.mockResolvedValue(commentRoot);
    hn.fetchItems
      .mockResolvedValueOnce(slotsOf([mockStory]))
      .mockResolvedValueOnce(slotsOf([comment(20, 10), comment(21, 10)]));

    const sc = okStructured(await call({ itemId: 10, depth: 1, maxComments: 2 }));

    expect(sc).toMatchObject({ totalLoaded: 2, truncated: true, shown: 2, cap: 2 });
    expect(sc).not.toHaveProperty('totalAvailable');
    expect(sc.notice).toBe(
      'Stopped at maxComments 2. Pass nextCursor as cursor, with the same itemId, to continue.',
    );
  });

  it('reports a thread whose kids fit exactly in maxComments as terminal, even without descendants', async () => {
    hn.fetchItem.mockResolvedValue({
      id: 10,
      type: 'comment',
      by: 'bob',
      parent: 1,
      kids: [20, 21],
    });
    hn.fetchItems
      .mockResolvedValueOnce(slotsOf([mockStory]))
      .mockResolvedValueOnce(slotsOf([comment(20, 10), comment(21, 10)]));

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
// maxComments and depth above the per-call cap — served at the cap, not rejected
// ---------------------------------------------------------------------------

describe('hn_get_thread — maxComments and depth above the per-call cap', () => {
  let hn: ReturnType<typeof createMockHnService>;
  /** Every comment and ancestor the calls asked HN for, in request order. */
  let requested: number[];

  const NO_TRUNCATION = ['truncated', 'truncationReason', 'nextCursor', 'shown', 'cap', 'notice'];

  function call(input: Record<string, unknown>): Promise<ToolResult> {
    return runToolContract(getThread, input as never, { context: { errors: getThread.errors } });
  }

  /** Serve story 1 (the shared mock, with `story` over it) and the comments in `byId`. */
  function serve(story: Partial<HnItem>, byId: Record<number, HnItem>) {
    const items: Record<number, HnItem> = { 1: { ...mockStory, ...story }, ...byId };
    hn.fetchItem.mockImplementation(async (id: number) => items[id] ?? null);
    hn.fetchItems.mockImplementation(async (ids: number[]) => {
      requested.push(...ids);
      return slotsOf(ids.map((id) => items[id]!));
    });
  }

  /**
   * `width` top-level comments (ids 1000…), the first `replies` of them with one
   * reply each (ids 2000…), so a page can cut past the first level.
   */
  function serveWide(width: number, replies = 0) {
    const kids = Array.from({ length: width }, (_, i) => 1000 + i);
    const replyIds = kids.slice(0, replies).map((_, i) => 2000 + i);
    const byId: Record<number, HnItem> = {};
    for (const [i, id] of kids.entries()) {
      const reply = replyIds[i];
      byId[id] = comment(id, 1, reply != null ? [reply] : undefined);
      if (reply != null) byId[reply] = comment(reply, id);
    }
    serve({ descendants: width + replies, kids }, byId);
    return { kids, replyIds };
  }

  /** One reply chain `levels` deep: comment 10 replies to story 1, 11 to 10, and so on. */
  function chainOf(levels: number): Record<number, HnItem> {
    return Object.fromEntries(
      Array.from({ length: levels }, (_, i) => 10 + i).map((id, i) => [
        id,
        comment(id, i === 0 ? 1 : id - 1, i + 1 < levels ? [id + 1] : undefined),
      ]),
    );
  }

  function serveChain(levels: number): number[] {
    serve({ descendants: levels, kids: [10] }, chainOf(levels));
    return Array.from({ length: levels }, (_, i) => 10 + i);
  }

  const depths = (sc: Record<string, unknown>) =>
    (sc.comments as Array<{ depth: number }>).map((c) => c.depth);

  const resume = 'Pass nextCursor as cursor, with the same itemId, to continue.';
  const drillIn =
    'Pass the id of a depth-9 comment that shows replies as itemId to read its subtree.';

  beforeEach(() => {
    hn = createMockHnService();
    (getHnService as Mock).mockReturnValue(hn);
    requested = [];
  });

  describe('maxComments', () => {
    it('serves 201 exactly as 200, adding only the over-cap sentence before the cursor', async () => {
      serveWide(300);
      const atCap = await call({ itemId: 1, depth: 1, maxComments: 200 });
      requested = [];
      const overCap = await call({ itemId: 1, depth: 1, maxComments: 201 });
      const { notice: atNotice, ...atRest } = okStructured(atCap);
      const { notice: overNotice, ...overRest } = okStructured(overCap);

      expect(requested).toHaveLength(200);
      expect(atNotice).toBe(`Stopped at maxComments 200 with 200/300 comments loaded. ${resume}`);
      expect(overNotice).toBe(
        `Stopped at maxComments 200 with 200/300 comments loaded. maxComments 201 is above the per-call cap of 200, so this call served maxComments: 200. ${resume}`,
      );
      expect(overRest).toEqual(atRest);
      expect(overRest).toMatchObject({
        totalLoaded: 200,
        shown: 200,
        cap: 200,
        truncated: true,
        truncationReason: 'count',
      });
      expect(typeof overRest.nextCursor).toBe('string');
      expect(allText(overCap)).toContain(overNotice as string);
      expect(allText(overCap)).toBe(
        allText(atCap).replace(atNotice as string, overNotice as string),
      );
    });

    it('serves the 1,000 ceiling as 200 comments, naming the cap and the cursor', async () => {
      const { kids } = serveWide(300);
      const result = await call({ itemId: 1, depth: 1, maxComments: 1000 });
      const sc = okStructured(result);

      expect(commentIds(sc)).toEqual(kids.slice(0, 200));
      expect(sc).toMatchObject({ shown: 200, cap: 200, truncationReason: 'count' });
      expect(sc.notice).toBe(
        `Stopped at maxComments 200 with 200/300 comments loaded. maxComments 1000 is above the per-call cap of 200, so this call served maxComments: 200. ${resume}`,
      );
      expect(allText(result)).toContain(sc.notice as string);
    });

    it('rejects maxComments above the 1,000 ceiling before any upstream call', async () => {
      serveWide(3);
      const result = await call({ itemId: 1, maxComments: 1001 });
      const error = wireError(result);

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.issues).toEqual([
        expect.objectContaining({ code: 'too_big', path: ['maxComments'], maximum: 1000 }),
      ]);
      expect(allText(result)).toContain('maxComments');
      expect(hn.fetchItem).not.toHaveBeenCalled();
      expect(hn.fetchItems).not.toHaveBeenCalled();
    });

    it('pages an over-cap request through the cursor at 200 a page, past the first level, to every comment once', async () => {
      const { kids, replyIds } = serveWide(300, 150);
      const pages: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      do {
        const input = { itemId: 1, depth: 5, maxComments: 1000, ...(cursor && { cursor }) };
        const sc = okStructured(await call(input));
        pages.push(sc);
        cursor = sc.nextCursor as string | undefined;
      } while (cursor && pages.length < 10);

      expect(pages.map((p) => (p.comments as unknown[]).length)).toEqual([200, 200, 50]);
      expect(pages.flatMap(commentIds)).toEqual([...kids, ...replyIds]);
      const overCap =
        'maxComments 1000 is above the per-call cap of 200, so this call served maxComments: 200.';
      expect(pages[0]!.notice).toBe(
        `Stopped at maxComments 200 with 200/450 comments loaded. ${overCap} ${resume}`,
      );
      expect(pages[1]!.notice).toBe(
        `Stopped at maxComments 200 with 400/450 comments loaded. ${overCap} ${resume}`,
      );
      expect(pages[1]).toMatchObject({ shown: 200, cap: 200, truncationReason: 'count' });
      /** The second page straddles the levels: the last 100 top-level comments, then 100 replies. */
      expect(depths(pages[1]!)).toEqual([...Array(100).fill(0), ...Array(100).fill(1)]);
      for (const key of NO_TRUNCATION) expect(pages[2]).not.toHaveProperty(key);
    });

    it('continues an over-cap first page at the maxComments the next call passes', async () => {
      const { kids } = serveWide(300);
      const first = okStructured(await call({ itemId: 1, depth: 1, maxComments: 500 }));
      const next = okStructured(await call({ itemId: 1, depth: 1, cursor: first.nextCursor }));

      expect(commentIds(next)).toEqual(kids.slice(200, 250));
      expect(next).toMatchObject({ shown: 50, cap: 50, truncationReason: 'count' });
      expect(next.notice).toBe(`Stopped at maxComments 50 with 250/300 comments loaded. ${resume}`);
    });

    it('leaves the sentence out when the byte budget, not the cap, stopped the page', async () => {
      const ids = [10, 11, 12, 13, 14];
      const long = (id: number): HnItem => ({ ...comment(id, 1), text: 'x'.repeat(20_000) });
      serve({ descendants: 5, kids: ids }, Object.fromEntries(ids.map((id) => [id, long(id)])));

      const result = await call({ itemId: 1, depth: 1, maxComments: 500 });
      const sc = okStructured(result);

      expect(commentIds(sc)).toEqual([10, 11, 12]);
      expect(sc).toMatchObject({ truncationReason: 'size', shown: 3, cap: 200 });
      expect(sc.notice).toBe(
        `Stopped at the 64,000-byte response budget after 3 comments with 3/5 comments loaded. ${resume}`,
      );
      expect(allText(result)).not.toContain('per-call cap');
    });

    it('leaves the sentence out when the per-call item ceiling, not the cap, stopped the page', async () => {
      const kids = Array.from({ length: 1_005 }, (_, i) => 10_000 + i);
      const deleted = Object.fromEntries(
        kids.map((id) => [id, { id, type: 'comment', deleted: true, parent: 1 } as HnItem]),
      );
      serve({ descendants: 1_005, kids }, deleted);

      const sc = okStructured(await call({ itemId: 1, depth: 1, maxComments: 500 }));

      expect(requested).toHaveLength(1_000);
      expect(sc).toMatchObject({ totalLoaded: 0, truncationReason: 'count', cap: 200 });
      expect(sc.notice).toBe(
        `1000 deleted, 0 dead — omitted from this view. Stopped after examining 1,000 items in one call with 0/1005 comments loaded. ${resume}`,
      );
    });
  });

  describe('depth', () => {
    it('serves 11 exactly as 10 on a deeper chain, adding only the over-cap sentence before the drill-in', async () => {
      const chain = serveChain(12);
      const atCap = await call({ itemId: 1, depth: 10 });
      requested = [];
      const overCap = await call({ itemId: 1, depth: 11 });
      const { notice: atNotice, ...atRest } = okStructured(atCap);
      const { notice: overNotice, ...overRest } = okStructured(overCap);

      /** Ten levels fetched, one batch each; the reply at depth 10 is never requested. */
      expect(requested).toEqual(chain.slice(0, 10));
      expect(commentIds(overRest)).toEqual(chain.slice(0, 10));
      expect(atNotice).toBe(
        `The depth limit (10) left replies unread with 10/12 comments loaded. ${drillIn}`,
      );
      expect(overNotice).toBe(
        `The depth limit (10) left replies unread with 10/12 comments loaded. depth 11 is above the per-call cap of 10, so this call served depth: 10. ${drillIn}`,
      );
      expect(overRest).toEqual(atRest);
      expect(overRest).toMatchObject({ truncated: true, truncationReason: 'depth' });
      expect(overRest).not.toHaveProperty('nextCursor');
      expect(allText(overCap)).toBe(
        allText(atCap).replace(atNotice as string, overNotice as string),
      );
    });

    it('serves the 100 ceiling at 10, and the depth-9 comment it names opens the rest of the chain', async () => {
      const chain = serveChain(25);
      const first = okStructured(await call({ itemId: 1, depth: 100 }));
      const overCap = 'depth 100 is above the per-call cap of 10, so this call served depth: 10.';

      expect(commentIds(first)).toEqual(chain.slice(0, 10));
      expect(first.notice).toBe(
        `The depth limit (10) left replies unread with 10/25 comments loaded. ${overCap} ${drillIn}`,
      );
      const named = (first.comments as Array<{ id: number; depth: number; childCount: number }>)
        .filter((c) => c.depth === 9 && c.childCount > 0)
        .map((c) => c.id);
      expect(named).toEqual([19]);

      const drilled = okStructured(await call({ itemId: 19, depth: 100 }));
      expect(drilled.item).toMatchObject({ id: 19, type: 'comment', storyId: 1 });
      expect(commentIds(drilled)).toEqual(chain.slice(10, 20));
      expect(depths(drilled)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(drilled.notice).toBe(
        `The depth limit (10) left replies unread. ${overCap} ${drillIn}`,
      );
    });

    it('rejects depth above the 100 ceiling before any upstream call', async () => {
      serveChain(3);
      const result = await call({ itemId: 1, depth: 101 });
      const error = wireError(result);

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.issues).toEqual([
        expect.objectContaining({ code: 'too_big', path: ['depth'], maximum: 100 }),
      ]);
      expect(allText(result)).toContain('depth');
      expect(hn.fetchItem).not.toHaveBeenCalled();
      expect(hn.fetchItems).not.toHaveBeenCalled();
    });

    it('reads a chain exactly 10 levels deep in full at an over-cap depth, with no cut and no notice', async () => {
      const chain = serveChain(10);
      const result = await call({ itemId: 1, depth: 100 });
      const sc = okStructured(result);

      expect(commentIds(sc)).toEqual(chain);
      expect((sc.comments as unknown[]).at(-1)).toMatchObject({ id: 19, depth: 9, childCount: 0 });
      for (const key of NO_TRUNCATION) expect(sc).not.toHaveProperty(key);
      expect(allText(result)).not.toContain('per-call cap');
    });

    it('cuts a chain 11 levels deep at the cap, one reply short', async () => {
      const chain = serveChain(11);
      const sc = okStructured(await call({ itemId: 1, depth: 12 }));

      expect(commentIds(sc)).toEqual(chain.slice(0, 10));
      expect(requested).not.toContain(20);
      expect(sc.notice).toBe(
        `The depth limit (10) left replies unread with 10/11 comments loaded. depth 12 is above the per-call cap of 10, so this call served depth: 10. ${drillIn}`,
      );
    });

    it('adds nothing on a tree shallower than the cap, serving it as the cap would', async () => {
      serveWide(3, 2);
      const overCap = await call({ itemId: 1, depth: 50, maxComments: 500 });
      const atCap = await call({ itemId: 1, depth: 10, maxComments: 200 });
      const sc = okStructured(overCap);

      expect(commentIds(sc)).toEqual([1000, 1001, 1002, 2000, 2001]);
      expect(sc).toEqual(okStructured(atCap));
      expect(allText(overCap)).toBe(allText(atCap));
      for (const key of NO_TRUNCATION) expect(sc).not.toHaveProperty(key);
    });

    it('returns an empty terminal page for a story with no comments at both ceilings', async () => {
      serve({ descendants: 0, kids: [] }, {});
      const sc = okStructured(await call({ itemId: 1, depth: 100, maxComments: 1000 }));

      expect(sc.comments).toEqual([]);
      expect(sc).toMatchObject({ totalLoaded: 0, totalAvailable: 0 });
      for (const key of NO_TRUNCATION) expect(sc).not.toHaveProperty(key);
    });

    it('carries the served depth in the cursor and reports the cut where the cursor runs out', async () => {
      /** A 12-level chain under comment 10, beside a leaf, 13 comments in all. */
      serve({ descendants: 13, kids: [10, 100] }, { ...chainOf(12), 100: comment(100, 1) });

      const first = okStructured(await call({ itemId: 1, depth: 50, maxComments: 4 }));
      expect(commentIds(first)).toEqual([10, 100, 11, 12]);
      expect(first.notice).toBe(`Stopped at maxComments 4 with 4/13 comments loaded. ${resume}`);

      const second = okStructured(
        await call({ itemId: 1, depth: 50, maxComments: 4, cursor: first.nextCursor }),
      );
      expect(commentIds(second)).toEqual([13, 14, 15, 16]);
      expect(second.notice).not.toContain('per-call cap');

      /** The same arguments again reach the cut, which names the over-cap value passed. */
      const resent = okStructured(
        await call({ itemId: 1, depth: 50, maxComments: 4, cursor: second.nextCursor }),
      );
      expect(commentIds(resent)).toEqual([17, 18, 19]);
      expect(resent).toMatchObject({ truncated: true, truncationReason: 'depth' });
      expect(resent).not.toHaveProperty('nextCursor');
      expect(resent.notice).toBe(
        `The depth limit (10) left replies unread with 11/13 comments loaded. depth 50 is above the per-call cap of 10, so this call served depth: 10. ${drillIn}`,
      );

      /** Without depth, the cursor's 10 still applies, and no over-cap value was passed. */
      const bare = okStructured(
        await call({ itemId: 1, maxComments: 4, cursor: second.nextCursor }),
      );
      expect(commentIds(bare)).toEqual([17, 18, 19]);
      expect(bare.notice).toBe(
        `The depth limit (10) left replies unread with 11/13 comments loaded. ${drillIn}`,
      );
      /** The chain's replies at depth 10 and 11 are never requested. */
      expect(requested).not.toContain(20);
      expect(requested).not.toContain(21);
    });

    it('ignores an over-cap depth passed with a cursor issued at a smaller depth', async () => {
      serveChain(5);
      const first = okStructured(await call({ itemId: 1, depth: 2, maxComments: 1 }));
      const next = okStructured(
        await call({ itemId: 1, depth: 50, maxComments: 1, cursor: first.nextCursor }),
      );

      expect(commentIds(next)).toEqual([11]);
      expect(next).toMatchObject({ truncationReason: 'depth' });
      expect(next.notice).toBe(
        'The depth limit (2) left replies unread with 2/5 comments loaded. Raise depth (max 10), or pass the id of a depth-1 comment that shows replies as itemId to read its subtree.',
      );
    });

    it('rejects a cursor carrying a depth above the cap as invalid_cursor, since none is issued', async () => {
      serveChain(3);
      const cursor = encodeThreadCursor({
        itemId: 1,
        depth: 11,
        offset: 1,
        depthCut: false,
        frontier: [{ id: 11, level: 1, parentId: 10 }],
      });

      expect(wireError(await call({ itemId: 1, cursor })).data).toMatchObject({
        reason: 'invalid_cursor',
      });
      /** An over-cap depth passed beside it changes nothing: the cursor still fails. */
      expect(wireError(await call({ itemId: 1, depth: 50, cursor })).data).toMatchObject({
        reason: 'invalid_cursor',
      });
      expect(hn.fetchItem).not.toHaveBeenCalled();
    });
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
      39662907: { id: 39662907, type: 'story', by: 'op', title: 'Story' },
    });

    const result = await callStubbed({ itemId: 39667625, depth: 0 });

    expect(okStructured(result).item).toMatchObject({ parent: 39662907, storyId: 39662907 });
    expect(allText(result)).toMatch(
      /id:39667625 \| type:comment \| parent:39662907 \| story:39662907 \| by pg/,
    );
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
      49257377: { id: 49257377, type: 'story', by: 'op', title: 'Story' },
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
      49254880: { id: 49254880, type: 'story', by: 'op', title: 'Story' },
    });

    const result = await callStubbed({ itemId: 49258793, depth: 0 });

    expect(okStructured(result).item).toMatchObject({ dead: true });
    expect(allText(result)).toContain('## [dead] Comment by nipunaeka89');
  });

  it('keeps absent relationship and state fields absent on a sparse story root', async () => {
    serveItems({ 1: { id: 1, type: 'story', by: 'op', title: 'Story' } });

    const item = okStructured(await callStubbed({ itemId: 1, depth: 0 })).item as object;

    for (const key of ['parent', 'storyId', 'poll', 'parts', 'options', 'deleted', 'dead']) {
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
      1: { id: 1, type: 'story', by: 'op', title: 'Story' },
      10: { id: 10, type: 'comment', by: 'bob', text: 'root', parent: 1, kids: [20] },
      20: { id: 20, type: 'comment', by: 'c', text: 'r', parent: 10, kids: [30] },
    });

    const result = await callStubbed({ itemId: 10, depth: 1 });
    const sc = okStructured(result);

    expect(commentIds(sc)).toEqual([20]);
    expect(sc).toMatchObject({ truncated: true, truncationReason: 'depth' });
    expect(sc).not.toHaveProperty('nextCursor');
    expect(sc).not.toHaveProperty('totalAvailable');
    expect(sc.notice).toBe(
      'The depth limit (1) left replies unread. Raise depth (max 10), or pass the id of a depth-0 comment that shows replies as itemId to read its subtree.',
    );
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
    expect(allText(result)).toContain('This cursor continues item 1, not item 2.');
    expect(allText(result)).toMatch(/same itemId/);
  });

  it('resumes a cursor in the JSON format earlier releases issued, at the same comment as a cursor issued now', async () => {
    serveItems(storyTree({ 1: [10, 11, 12], 10: [20] }, {}, { descendants: 4 }));
    const first = okStructured(await callStubbed({ itemId: 1, depth: 2, maxComments: 1 }));
    const jsonCursor = encodeCursor({
      offset: 1,
      limit: 1,
      itemId: 1,
      depth: 2,
      frontier: [
        [0, 1, 11, 12],
        [1, 10, 20],
      ],
    });

    const issued = okStructured(
      await callStubbed({ itemId: 1, depth: 2, maxComments: 2, cursor: first.nextCursor }),
    );
    const legacy = okStructured(
      await callStubbed({ itemId: 1, depth: 2, maxComments: 2, cursor: jsonCursor }),
    );

    expect(commentIds(issued)).toEqual([11, 12]);
    expect(commentIds(legacy)).toEqual([11, 12]);
    expect(legacy.notice).toBe(issued.notice);
    expect(legacy.notice).toMatch(/3\/4 comments loaded/);
  });

  it('reports the depth cut a JSON-format cursor carries once it runs out', async () => {
    serveItems(storyTree({ 1: [10, 11] }, {}, { descendants: 3 }));
    const jsonCursor = encodeCursor({
      offset: 1,
      limit: 1,
      itemId: 1,
      depth: 1,
      frontier: [[0, 1, 11]],
      depthCut: true,
    });

    const sc = okStructured(await callStubbed({ itemId: 1, cursor: jsonCursor }));

    expect(commentIds(sc)).toEqual([11]);
    expect(sc).toMatchObject({ truncated: true, truncationReason: 'depth' });
    expect(sc).not.toHaveProperty('nextCursor');
  });

  it('starts from the top when cursor is an empty string', async () => {
    serveItems(storyTree({ 1: [10, 11] }, {}, { descendants: 2 }));

    const sc = okStructured(await callStubbed({ itemId: 1, depth: 1, cursor: '' }));

    expect(commentIds(sc)).toEqual([10, 11]);
  });

  /** Rewrite an issued cursor's decoded bytes, keeping the result valid base64url. */
  const alter = (cursor: string, edit: (bytes: Buffer) => Buffer) =>
    edit(Buffer.from(cursor, 'base64url')).toString('base64url');

  it.each<[string, (issued: string) => string]>([
    ['not base64url', () => 'garbage!!'],
    ['percent-encoded text', () => '%%%not-a-cursor'],
    ['a generic pagination cursor', () => encodeCursor({ offset: 0, limit: 10 })],
    [
      'a JSON-format frontier level at or past its depth',
      () => encodeCursor({ offset: 0, limit: 10, itemId: 1, depth: 1, frontier: [[1, 1, 10]] }),
    ],
    [
      'a JSON-format cursor without limit',
      () =>
        Buffer.from(
          JSON.stringify({ offset: 0, itemId: 1, depth: 1, frontier: [[0, 1, 10]] }),
        ).toString('base64url'),
    ],
    [
      'an unknown format byte',
      (issued) => alter(issued, (b) => Buffer.concat([Buffer.from([0x02]), b.subarray(1)])),
    ],
    ['a truncated payload', (issued) => alter(issued, (b) => b.subarray(0, -1))],
    ['trailing bytes', (issued) => alter(issued, (b) => Buffer.concat([b, Buffer.from([0])]))],
  ])(
    'rejects %s as invalid_cursor, without echoing it or a decode warning',
    async (_label, make) => {
      serveItems(storyTree({ 1: [10, 11] }, {}, { descendants: 2 }));
      const issued = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 1 }))
        .nextCursor as string;
      const cursor = make(issued);

      const warning = vi.spyOn(logger, 'warning');
      const result = await callStubbed({ itemId: 1, cursor });
      const warnings = warning.mock.calls.map(([message]) => message);
      warning.mockRestore();
      const error = wireError(result);

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data).toMatchObject({
        reason: 'invalid_cursor',
        recovery: {
          hint: 'Pass nextCursor unchanged, with the same itemId it was returned for, or omit cursor to start this item from the top.',
        },
      });
      expect(JSON.stringify(error.data)).not.toContain(cursor);
      expect(allText(result)).not.toContain(cursor);
      expect(allText(result)).toContain('reason invalid_cursor');
      expect(warnings).not.toContain('Failed to decode pagination cursor');
    },
  );

  it('declares invalid_cursor at notice severity, covering both a foreign and an altered cursor', () => {
    const entry = getThread.errors?.find((e) => e.reason === 'invalid_cursor');

    expect(entry).toMatchObject({ code: JsonRpcErrorCode.InvalidParams, severity: 'notice' });
    expect(entry?.when).toMatch(/altered/);
    expect(entry?.when).toMatch(/different itemId/);
  });

  it('packs the cursor to at most 3.5 characters per frontier ID on a real thread’s sparse frontier', async () => {
    const { storyId, returned, repliesQueued, unread } = SPARSE_THREAD;
    serveSparseThread();
    const frontierIds = unread.length + Object.values(repliesQueued).flat().length;

    const sc = okStructured(await callStubbed({ itemId: storyId, depth: 3, maxComments: 10 }));
    const cursor = sc.nextCursor as string;

    expect(commentIds(sc)).toEqual(returned);
    expect(frontierIds).toBe(296);
    expect(cursor.length / frontierIds).toBeLessThanOrEqual(3.5);

    const next = okStructured(
      await callStubbed({ itemId: storyId, depth: 3, maxComments: 200, cursor }),
    );
    expect(commentIds(next)).toEqual(unread.slice(0, 200));
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

// ---------------------------------------------------------------------------
// Replies below dead and deleted comments — omitted themselves, walked through
// ---------------------------------------------------------------------------

describe('hn_get_thread — replies below dead and deleted comments', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (getHnService as Mock).mockReturnValue(new HnService(3));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const dead = (id: number, parent: number, kids?: number[]) => ({
    id,
    type: 'comment',
    dead: true,
    text: '[flagged]',
    parent,
    ...(kids && { kids }),
  });
  const deleted = (id: number, parent: number, kids?: number[]) => ({
    id,
    type: 'comment',
    deleted: true,
    parent,
    ...(kids && { kids }),
  });

  const tree = (sc: Record<string, unknown>) =>
    (sc.comments as Array<{ id: number; depth: number; parentId: number }>).map((c) => [
      c.id,
      c.depth,
      c.parentId,
    ]);

  it('returns a live reply under a dead and under a deleted comment at its true depth, on both surfaces', async () => {
    serveItems(
      storyTree(
        { 1: [10, 11, 12], 10: [20], 11: [21] },
        { 10: dead(10, 1, [20]), 11: deleted(11, 1, [21]) },
        { descendants: 3 },
      ),
    );

    const result = await callStubbed({ itemId: 1, depth: 3 });
    const sc = okStructured(result);

    expect(tree(sc)).toEqual([
      [12, 0, 1],
      [20, 1, 10],
      [21, 1, 11],
    ]);
    expect(sc).toMatchObject({ totalLoaded: 3, totalAvailable: 3 });
    expect(sc.notice).toBe('1 deleted, 1 dead — omitted from this view.');
    const text = allText(result);
    expect(text).toContain('id:20 | depth:1 | parent:10');
    expect(text).toContain('id:21 | depth:1 | parent:11');
    expect(text).not.toContain('id:10 ');
    expect(text).not.toContain('id:11 ');
    expect(text).not.toContain('[flagged]');
  });

  it('walks a dead-under-dead chain to the live replies below it, past the first level', async () => {
    serveItems(
      storyTree(
        { 1: [10, 11], 10: [20], 20: [30, 31], 30: [40] },
        { 10: dead(10, 1, [20]), 20: dead(20, 10, [30, 31]), 31: deleted(31, 20) },
        { descendants: 3 },
      ),
    );

    const sc = okStructured(await callStubbed({ itemId: 1, depth: 10 }));

    expect(tree(sc)).toEqual([
      [11, 0, 1],
      [30, 2, 20],
      [40, 3, 30],
    ]);
    expect(sc.notice).toBe('1 deleted, 2 dead — omitted from this view.');
    expect(sc).not.toHaveProperty('truncated');
  });

  describe('the lever for replies the depth limit cut below an omitted comment', () => {
    /** Pass an id a notice named as itemId, as a caller following the lever would. */
    const drill = async (itemId: number) => okStructured(await callStubbed({ itemId, depth: 10 }));

    /** A live chain at depths 0–8 (comments 10…18) under story 1, with `replies` under 18. */
    const chainTo8 = (replies: number[]): Record<number, number[]> => {
      const kidsOf: Record<number, number[]> = { 1: [10], 18: replies };
      for (let id = 10; id < 18; id++) kidsOf[id] = [id + 1];
      return kidsOf;
    };

    /** `count` dead comments 100… under `parent`, each with one live reply 200…. */
    const deadWithReplies = (count: number, parent: number) => {
      const ids = Array.from({ length: count }, (_, i) => 100 + i);
      return {
        ids,
        kidsOf: Object.fromEntries(ids.map((id) => [id, [id + 100]])),
        overrides: Object.fromEntries(ids.map((id) => [id, dead(id, parent, [id + 100])])),
      };
    };

    const resume = 'Pass nextCursor as cursor, with the same itemId, to continue.';

    it('names a dead and a deleted comment cut at depth 1 as the itemId lever, on both surfaces, and each opens its subtree', async () => {
      serveItems(
        storyTree(
          { 1: [10, 11], 10: [20], 11: [21] },
          { 10: dead(10, 1, [20]), 11: deleted(11, 1, [21]) },
          { descendants: 2 },
        ),
      );

      const result = await callStubbed({ itemId: 1, depth: 1 });
      const sc = okStructured(result);

      expect(sc.comments).toEqual([]);
      expect(sc).toMatchObject({ truncated: true, truncationReason: 'depth' });
      expect(sc).not.toHaveProperty('nextCursor');
      expect(sc.notice).toBe(
        '1 deleted, 1 dead — omitted from this view. The depth limit (1) left replies unread with 0/2 comments loaded. Raise depth (max 10), or pass the id of an omitted comment with replies (ids 10, 11) as itemId to read its subtree.',
      );
      expect(allText(result)).toContain(sc.notice as string);

      const underDead = await drill(10);
      expect(underDead.item).toMatchObject({ id: 10, dead: true });
      expect(tree(underDead)).toEqual([[20, 0, 10]]);
      const underDeleted = await drill(11);
      expect(underDeleted.item).toMatchObject({ id: 11, deleted: true });
      expect(tree(underDeleted)).toEqual([[21, 0, 11]]);
    });

    it('names the omitted comments at depth 9 when no comment returned is that deep, the only way in at the per-call cap', async () => {
      serveItems(
        storyTree(
          { ...chainTo8([19, 30]), 19: [20], 30: [31] },
          { 19: dead(19, 18, [20]), 30: deleted(30, 18, [31]) },
          { descendants: 11 },
        ),
      );
      const lever =
        'Pass the id of an omitted comment with replies (ids 19, 30) as itemId to read its subtree.';

      const result = await callStubbed({ itemId: 1, depth: 10 });
      const sc = okStructured(result);

      expect(commentIds(sc)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect((sc.comments as unknown[]).at(-1)).toMatchObject({ id: 18, depth: 8, childCount: 2 });
      expect(sc).toMatchObject({ truncated: true, truncationReason: 'depth' });
      expect(sc.notice).toBe(
        `1 deleted, 1 dead — omitted from this view. The depth limit (10) left replies unread with 9/11 comments loaded. ${lever}`,
      );
      expect(allText(result)).toContain(sc.notice as string);

      const overCap = okStructured(await callStubbed({ itemId: 1, depth: 50 }));
      expect(overCap.notice).toBe(
        `1 deleted, 1 dead — omitted from this view. The depth limit (10) left replies unread with 9/11 comments loaded. depth 50 is above the per-call cap of 10, so this call served depth: 10. ${lever}`,
      );

      expect(tree(await drill(19))).toEqual([[20, 0, 19]]);
      expect(tree(await drill(30))).toEqual([[31, 0, 30]]);
    });

    it('names an omitted comment beside a returned one when the depth limit cut both, and both open their subtrees', async () => {
      serveItems(
        storyTree(
          { 1: [10, 11, 12], 10: [20], 11: [21] },
          { 11: dead(11, 1, [21]), 12: deleted(12, 1) },
          { descendants: 3 },
        ),
      );

      const result = await callStubbed({ itemId: 1, depth: 1 });
      const sc = okStructured(result);

      expect(tree(sc)).toEqual([[10, 0, 1]]);
      expect(sc.notice).toBe(
        '1 deleted, 1 dead — omitted from this view. The depth limit (1) left replies unread with 1/3 comments loaded. Raise depth (max 10), or pass the id of a depth-0 comment that shows replies, or of omitted comment 11, as itemId to read its subtree.',
      );
      expect(allText(result)).toContain(sc.notice as string);
      expect(tree(await drill(10))).toEqual([[20, 0, 10]]);
      expect(tree(await drill(11))).toEqual([[21, 0, 11]]);
    });

    it('names the first 10 omitted comments and counts the rest while a larger depth reaches them all', async () => {
      const run = deadWithReplies(15, 1);
      serveItems(
        storyTree({ 1: [...run.ids, 115, 116, 117], ...run.kidsOf }, run.overrides, {
          descendants: 18,
        }),
      );
      const named = '(ids 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, and 5 more)';
      const dropped = '0 deleted, 15 dead — omitted from this view.';

      const whole = await callStubbed({ itemId: 1, depth: 1 });
      const sc = okStructured(whole);
      expect(commentIds(sc)).toEqual([115, 116, 117]);
      expect(sc.notice).toBe(
        `${dropped} The depth limit (1) left replies unread with 3/18 comments loaded. Raise depth (max 10), or pass the id of an omitted comment with replies ${named} as itemId to read its subtree.`,
      );
      expect(allText(whole)).toContain(sc.notice as string);

      /** A page the cursor continues names them on the page that meets them. */
      const page = await callStubbed({ itemId: 1, depth: 1, maxComments: 2 });
      const first = okStructured(page);
      expect(commentIds(first)).toEqual([115, 116]);
      expect(first).toMatchObject({ truncationReason: 'count' });
      expect(first.notice).toBe(
        `${dropped} Stopped at maxComments 2 with 2/18 comments loaded. ${resume} 15 omitted comments ${named} have replies below the depth limit, which nextCursor does not reach; pass an id as itemId to read that comment's subtree, or raise depth (max 10) to read them all.`,
      );
      expect(allText(page)).toContain(first.notice as string);

      /** One level deeper reaches every reply, the five the list left unnamed among them. */
      const deeper = okStructured(await callStubbed({ itemId: 1, depth: 2 }));
      expect(commentIds(deeper)).toEqual([115, 116, 117, ...run.ids.map((id) => id + 100)]);
      expect(deeper.notice).toBe(dropped);
      expect(deeper).not.toHaveProperty('truncated');
    });

    it('names every omitted comment at depth 9, past the short list, since no larger depth reaches them', async () => {
      const run = deadWithReplies(15, 18);
      serveItems(
        storyTree({ ...chainTo8([...run.ids, 115, 116]), ...run.kidsOf }, run.overrides, {
          descendants: 26,
        }),
      );
      const named = `(ids ${run.ids.join(', ')})`;
      const dropped = '0 deleted, 15 dead — omitted from this view.';
      const chain = [10, 11, 12, 13, 14, 15, 16, 17, 18];

      const sc = okStructured(await callStubbed({ itemId: 1, depth: 10 }));
      expect(commentIds(sc)).toEqual([...chain, 115, 116]);
      expect(sc.notice).toBe(
        `${dropped} The depth limit (10) left replies unread with 11/26 comments loaded. Pass the id of an omitted comment with replies ${named} as itemId to read its subtree.`,
      );

      /** Met on a page the cursor continues, they are all named there too. */
      const first = okStructured(await callStubbed({ itemId: 1, depth: 10, maxComments: 10 }));
      expect(commentIds(first)).toEqual([...chain, 115]);
      expect(first.notice).toBe(
        `${dropped} Stopped at maxComments 10 with 10/26 comments loaded. ${resume} 15 omitted comments ${named} have replies below the depth limit, which nextCursor does not reach; pass an id as itemId to read that comment's subtree.`,
      );
      const last = okStructured(
        await callStubbed({ itemId: 1, depth: 10, maxComments: 10, cursor: first.nextCursor }),
      );
      expect(commentIds(last)).toEqual([116]);
      expect(last.notice).toBe(
        'The depth limit (10) left replies unread with 11/26 comments loaded. Pass the id of a depth-9 comment with replies on an earlier page (shown there, or named as omitted) as itemId to read its subtree.',
      );

      expect(tree(await drill(114))).toEqual([[214, 0, 114]]);
    });

    it('names an omitted comment on the early page that meets it, and the page the cursor ends on points back to it', async () => {
      serveItems(
        storyTree(
          { 1: [10, 11, 12, 13, 14, 15], 10: [20] },
          { 10: dead(10, 1, [20]) },
          { descendants: 6 },
        ),
      );

      const results: ToolResult[] = [];
      let cursor: string | undefined;
      do {
        const result = await callStubbed({
          itemId: 1,
          depth: 1,
          maxComments: 2,
          ...(cursor && { cursor }),
        });
        results.push(result);
        cursor = okStructured(result).nextCursor as string | undefined;
        expect(results.length).toBeLessThan(10);
      } while (cursor);
      const pages = results.map(okStructured);

      expect(pages.map(commentIds)).toEqual([[11, 12], [13, 14], [15]]);
      expect(pages[0]!.notice).toBe(
        `0 deleted, 1 dead — omitted from this view. Stopped at maxComments 2 with 2/6 comments loaded. ${resume} 1 omitted comment (id 10) has replies below the depth limit, which nextCursor does not reach; pass its id as itemId to read its subtree.`,
      );
      expect(allText(results[0]!)).toContain(pages[0]!.notice as string);
      expect(pages[1]!.notice).toBe(`Stopped at maxComments 2 with 4/6 comments loaded. ${resume}`);
      expect(pages[2]).toMatchObject({ truncated: true, truncationReason: 'depth' });
      expect(pages[2]).not.toHaveProperty('nextCursor');
      expect(pages[2]!.notice).toBe(
        'The depth limit (1) left replies unread with 5/6 comments loaded. Raise depth (max 10), or pass the id of a depth-0 comment with replies on an earlier page (shown there, or named as omitted) as itemId to read its subtree.',
      );
      expect(allText(results[2]!)).toContain(pages[2]!.notice as string);

      expect(tree(await drill(10))).toEqual([[20, 0, 10]]);
    });

    it('keeps the shown-comment lever on the page a carried cut ends on when that page shows one with replies', async () => {
      serveItems(
        storyTree(
          { 1: [10, 11, 12], 10: [20], 12: [22] },
          { 10: dead(10, 1, [20]) },
          { descendants: 4 },
        ),
      );

      const first = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 1 }));
      expect(commentIds(first)).toEqual([11]);
      expect(first.notice).toContain('1 omitted comment (id 10) has replies below the depth limit');

      const last = okStructured(
        await callStubbed({ itemId: 1, depth: 1, maxComments: 1, cursor: first.nextCursor }),
      );
      expect(tree(last)).toEqual([[12, 0, 1]]);
      expect(last.notice).toBe(
        'The depth limit (1) left replies unread with 2/4 comments loaded. Raise depth (max 10), or pass the id of a depth-0 comment that shows replies as itemId to read its subtree.',
      );
    });

    it('leaves the notice as it was when an omitted comment at the last level has no replies', async () => {
      serveItems(
        storyTree(
          { 1: [11, 12, 10, 13], 10: [20] },
          { 11: dead(11, 1), 12: deleted(12, 1) },
          { descendants: 3 },
        ),
      );

      const result = await callStubbed({ itemId: 1, depth: 1 });
      const sc = okStructured(result);
      expect(tree(sc)).toEqual([
        [10, 0, 1],
        [13, 0, 1],
      ]);
      expect(sc.notice).toBe(
        '1 deleted, 1 dead — omitted from this view. The depth limit (1) left replies unread with 2/3 comments loaded. Raise depth (max 10), or pass the id of a depth-0 comment that shows replies as itemId to read its subtree.',
      );
      expect(allText(result)).toContain(sc.notice as string);

      const page = okStructured(await callStubbed({ itemId: 1, depth: 1, maxComments: 1 }));
      expect(commentIds(page)).toEqual([10]);
      expect(page.notice).toBe(
        `1 deleted, 1 dead — omitted from this view. Stopped at maxComments 1 with 1/3 comments loaded. ${resume}`,
      );
    });
  });

  it('keeps a dead or deleted comment without replies a leaf, with nothing below it to report', async () => {
    serveItems(
      storyTree({ 1: [10, 11, 12] }, { 10: dead(10, 1), 11: deleted(11, 1) }, { descendants: 1 }),
    );

    const sc = okStructured(await callStubbed({ itemId: 1, depth: 1 }));

    expect(commentIds(sc)).toEqual([12]);
    expect(sc).not.toHaveProperty('truncated');
    expect(sc.notice).toBe('1 deleted, 1 dead — omitted from this view.');
  });

  it('charges an omitted comment nothing against maxComments, and carries its replies in the cursor', async () => {
    serveItems(
      storyTree({ 1: [10, 11, 12], 10: [20] }, { 10: dead(10, 1, [20]) }, { descendants: 3 }),
    );

    const first = okStructured(await callStubbed({ itemId: 1, depth: 2, maxComments: 2 }));

    expect(tree(first)).toEqual([
      [11, 0, 1],
      [12, 0, 1],
    ]);
    expect(first).toMatchObject({ totalLoaded: 2, truncationReason: 'count', cap: 2 });

    const next = okStructured(
      await callStubbed({ itemId: 1, depth: 2, maxComments: 2, cursor: first.nextCursor }),
    );
    expect(tree(next)).toEqual([[20, 1, 10]]);
    expect(next).not.toHaveProperty('nextCursor');
  });

  it('resumes a page cut between a dead comment and its reply at the reply', async () => {
    const long = (id: number) => ({ ...comment(id, 1), text: 'x'.repeat(40_000) });
    serveItems(
      storyTree(
        { 1: [10, 11, 12], 10: [20] },
        { 10: dead(10, 1, [20]), 11: long(11), 12: long(12) },
        { descendants: 3 },
      ),
    );

    const first = okStructured(await callStubbed({ itemId: 1, depth: 2 }));
    expect(tree(first)).toEqual([[11, 0, 1]]);
    expect(first).toMatchObject({ truncationReason: 'size' });

    const next = okStructured(await callStubbed({ itemId: 1, depth: 2, cursor: first.nextCursor }));
    expect(tree(next)).toEqual([
      [12, 0, 1],
      [20, 1, 10],
    ]);
  });

  it('pages a thread with dead and deleted comments at every level to every live comment, each once', async () => {
    const kidsOf: Record<number, number[]> = {
      1: [10, 11, 12, 13],
      10: [20, 21],
      11: [22],
      13: [23, 24],
      20: [30],
      21: [31, 32],
      23: [33],
      30: [40],
      31: [41],
    };
    const omitted = {
      10: dead(10, 1, kidsOf[10]),
      13: deleted(13, 1, kidsOf[13]),
      21: dead(21, 10, kidsOf[21]),
      23: deleted(23, 13, kidsOf[23]),
      31: dead(31, 21, kidsOf[31]),
      32: deleted(32, 21),
    };
    serveItems(storyTree(kidsOf, omitted, { descendants: 9 }));

    const pages: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    do {
      const page = okStructured(
        await callStubbed({ itemId: 1, depth: 10, maxComments: 2, ...(cursor && { cursor }) }),
      );
      expect((page.comments as unknown[]).length).toBe(page.totalLoaded);
      pages.push(page);
      cursor = page.nextCursor as string | undefined;
      expect(pages.length).toBeLessThan(20);
    } while (cursor);

    expect(pages.flatMap(tree)).toEqual([
      [11, 0, 1],
      [12, 0, 1],
      [20, 1, 10],
      [22, 1, 11],
      [24, 1, 13],
      [30, 2, 20],
      [33, 2, 23],
      [40, 3, 30],
      [41, 3, 31],
    ]);
    expect(pages.reduce((sum, page) => sum + (page.totalLoaded as number), 0)).toBe(9);
    expect(pages.at(-1)).not.toHaveProperty('truncated');
  });

  it('describes totalAvailable as a live-comment count and parentId as possibly naming an omitted comment', () => {
    expect(getThread.enrichment?.totalAvailable.description).toBe(
      "HN's count of live comments in the thread (descendants); dead and deleted comments are not counted. Absent for comment and job roots.",
    );
    expect(getThread.output.shape.comments.element.shape.parentId.description).toMatch(
      /dead or deleted comment/,
    );
  });

  it('describes notice as naming an omitted comment the depth limit cut, and depth as drilling into one', () => {
    expect(getThread.enrichment?.notice.description).toMatch(
      /Dead or deleted comments whose replies the depth limit cut are named by id, to pass as itemId/,
    );
    expect(getThread.input.shape.depth.description).toMatch(
      /a comment from the deepest level returned, or one notice names, as itemId/,
    );
  });
});

// ---------------------------------------------------------------------------
// #42 — OP marks on a comment root follow the story it belongs to
// ---------------------------------------------------------------------------

describe('hn_get_thread — the story a comment root belongs to', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (getHnService as Mock).mockReturnValue(new HnService(3));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const story = (id: number, by?: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'story',
    title: `Story ${id}`,
    ...(by && { by }),
    ...extra,
  });
  const reply = (id: number, by: string, parent: number, kids?: number[]) => ({
    id,
    type: 'comment',
    by,
    text: `c${id}`,
    parent,
    ...(kids && { kids }),
  });

  const opIds = (sc: Record<string, unknown>) =>
    (sc.comments as Array<{ id: number; isOp?: true }>).filter((c) => c.isOp).map((c) => c.id);

  /** Run a call and note when it settled on the (fake) clock, relative to its start. */
  async function timedCall(input: Record<string, unknown>) {
    const startedAt = Date.now();
    let settledAfter = Number.NaN;
    const pending = runToolContract(getThread, input as never, {
      context: { errors: getThread.errors },
    }).then((result) => {
      settledAfter = Date.now() - startedAt;
      return result;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    return { result: await pending, settledAfter };
  }

  /** verelo's comment, one level below alkyon's story, with verelo replying further down. */
  const vereloThread = {
    50126253: story(50126253, 'alkyon', { kids: [50135036] }),
    50135036: reply(50135036, 'u50135036', 50126253, [50135223]),
    50135223: reply(50135223, 'verelo', 50135036, [50135841, 50137058]),
    50135841: reply(50135841, 'u50135841', 50135223, [50135868]),
    50135868: reply(50135868, 'verelo', 50135841),
    50137058: reply(50137058, 'u50137058', 50135223, [50137295]),
    50137295: reply(50137295, 'verelo', 50137058),
  };

  /** bozdemir's comment, two levels below albinstman's story, with albinstman replying to it. */
  const albinstmanThread = {
    50127979: story(50127979, 'albinstman', { kids: [50128529] }),
    50128529: reply(50128529, 'u50128529', 50127979, [50128660]),
    50128660: reply(50128660, 'albinstman', 50128529, [50128907]),
    50128907: reply(50128907, 'bozdemir', 50128660, [50128990, 50132337]),
    50128990: reply(50128990, 'albinstman', 50128907),
    50132337: reply(50132337, 'albinstman', 50128907),
  };

  it('marks no reply by the comment root’s own author as OP when someone else submitted the story', async () => {
    const { requested } = serveItems(vereloThread);

    const result = await callStubbed({ itemId: 50135223, depth: 3 });
    const sc = okStructured(result);

    expect(commentIds(sc)).toEqual([50135841, 50137058, 50135868, 50137295]);
    expect(opIds(sc)).toEqual([]);
    expect(sc.item).toMatchObject({ id: 50135223, parent: 50135036, storyId: 50126253 });
    expect(sc).not.toHaveProperty('notice');
    expect(requested().slice(0, 3)).toEqual([
      '/item/50135223.json',
      '/item/50135036.json',
      '/item/50126253.json',
    ]);
    const text = allText(result);
    expect(text).toMatch(
      /id:50135223 \| type:comment \| parent:50135036 \| story:50126253 \| by verelo/,
    );
    expect(text).toContain('**verelo** (id:50135868');
    expect(text).not.toContain('(OP)');
    expect(text).not.toContain('isOp:true');
  });

  it('marks replies by the story’s submitter as OP on a comment root, on both surfaces', async () => {
    serveItems(albinstmanThread);

    const result = await callStubbed({ itemId: 50128907, depth: 3 });
    const sc = okStructured(result);

    expect(commentIds(sc)).toEqual([50128990, 50132337]);
    expect(opIds(sc)).toEqual([50128990, 50132337]);
    expect(sc.item).toMatchObject({ id: 50128907, storyId: 50127979 });
    expect(sc).not.toHaveProperty('notice');
    const text = allText(result);
    expect(text).toMatch(/\| parent:50128660 \| story:50127979 \|/);
    expect(
      text.match(/\*\*albinstman \(OP\)\*\* \(id:\d+ \| depth:0 \| parent:50128907 \| isOp:true/g),
    ).toHaveLength(2);
  });

  it.each<[string, number, Record<number, unknown>, number, number[]]>([
    ['a top-level comment', 10, { 1: story(1, 'op'), 10: reply(10, 'r', 1) }, 1, [10, 1]],
    [
      'a deleted comment',
      20,
      {
        1: story(1, 'op'),
        10: reply(10, 'u10', 1),
        20: { id: 20, type: 'comment', deleted: true, parent: 10, kids: [30] },
      },
      1,
      [20, 10, 1],
    ],
    [
      'a dead comment',
      20,
      {
        1: story(1, 'op'),
        10: reply(10, 'u10', 1),
        20: { id: 20, type: 'comment', by: 'r', dead: true, text: '[flagged]', parent: 10 },
      },
      1,
      [20, 10, 1],
    ],
    [
      'a comment below a deleted and a dead ancestor',
      30,
      {
        1: story(1, 'op'),
        10: { id: 10, type: 'comment', deleted: true, parent: 1 },
        20: { id: 20, type: 'comment', by: 'u20', dead: true, text: '[flagged]', parent: 10 },
        30: reply(30, 'r', 20),
      },
      1,
      [30, 20, 10, 1],
    ],
    [
      'a comment on a poll, without fetching the poll’s options',
      10,
      {
        5: { id: 5, type: 'poll', by: 'op', title: 'Poll', parts: [6, 7] },
        10: reply(10, 'r', 5),
      },
      5,
      [10, 5],
    ],
  ])('resolves the story of %s at depth 0', async (_label, itemId, items, storyId, path) => {
    const { requested } = serveItems(items);

    const result = await callStubbed({ itemId, depth: 0 });
    const sc = okStructured(result);

    expect(sc.item).toMatchObject({ id: itemId, storyId });
    expect(sc).not.toHaveProperty('notice');
    expect(requested()).toEqual(path.map((id) => `/item/${id}.json`));
    expect(allText(result)).toMatch(new RegExp(`\\| story:${storyId}\\b`));
  });

  it.each<[string, number, Record<number, unknown>, string[]]>([
    ['story', 1, { 1: story(1, 'op', { kids: [10] }) }, ['/item/1.json']],
    ['job', 2, { 2: { id: 2, type: 'job', by: 'co', title: 'Hiring' } }, ['/item/2.json']],
    [
      'poll',
      5,
      {
        5: { id: 5, type: 'poll', by: 'op', title: 'Poll', parts: [6] },
        6: { id: 6, type: 'pollopt', by: 'op', poll: 5, text: 'Yes', score: 1 },
      },
      ['/item/5.json', '/item/6.json'],
    ],
    [
      'poll option',
      6,
      { 6: { id: 6, type: 'pollopt', by: 'op', poll: 5, text: 'Yes', score: 1 } },
      ['/item/6.json'],
    ],
  ])(
    'makes no extra request for a %s root, and gives it no storyId',
    async (_label, itemId, items, paths) => {
      const { requested } = serveItems(items);

      const result = await callStubbed({ itemId, depth: 0 });
      const sc = okStructured(result);

      expect(requested()).toEqual(paths);
      expect(sc.item).not.toHaveProperty('storyId');
      expect(sc).not.toHaveProperty('notice');
      expect(allText(result)).not.toMatch(/story:\d/);
    },
  );

  /** Root 20 by `r`, with replies by `r` and by `op`; each case breaks the way up to story 1. */
  const rootUnder = (parent: number | undefined) => ({
    id: 20,
    type: 'comment',
    by: 'r',
    text: 'root',
    ...(parent != null && { parent }),
    kids: [30, 31],
  });
  const replies = { 30: reply(30, 'r', 20), 31: reply(31, 'op', 20) };

  it.each<[string, Record<number, unknown>, number | undefined, RegExp]>([
    [
      'an ancestor that fails to load',
      { 1: story(1, 'op'), 10: httpStatus(500), 20: rootUnder(10) },
      undefined,
      /^Could not find the story this comment belongs to: ancestor 10 failed to load\. storyId is absent and replies by the story's author are not marked isOp\. Call again to retry\.$/,
    ],
    [
      'an ancestor HN has no record of',
      { 10: null, 20: rootUnder(10) },
      undefined,
      /^Could not find the story this comment belongs to: ancestor 10 does not exist\. storyId is absent and replies by the story's author are not marked isOp\.$/,
    ],
    [
      'a root with no parent',
      { 20: rootUnder(undefined) },
      undefined,
      /^Could not find the story this comment belongs to: HN lists no parent for it\. storyId is absent and replies by the story's author are not marked isOp\.$/,
    ],
    [
      'an ancestor with no parent',
      { 10: { id: 10, type: 'comment', by: 'u10', text: 'c10' }, 20: rootUnder(10) },
      undefined,
      /^Could not find the story this comment belongs to: HN lists no parent for ancestor 10\. storyId is absent and replies by the story's author are not marked isOp\.$/,
    ],
    [
      'a story with no author',
      {
        1: { id: 1, type: 'story', deleted: true },
        10: reply(10, 'u10', 1),
        20: rootUnder(10),
      },
      1,
      /^The story this comment belongs to \(id 1\) has no author on record, so no reply is marked isOp\.$/,
    ],
  ])(
    'still loads the replies past %s, marking none as OP and saying why',
    async (_label, items, storyId, notice) => {
      serveItems({ ...items, ...replies });

      const result = await callStubbed({ itemId: 20, depth: 1 });
      const sc = okStructured(result);

      expect(commentIds(sc)).toEqual([30, 31]);
      expect(opIds(sc)).toEqual([]);
      expect(sc).not.toHaveProperty('failedIds');
      expect(sc).not.toHaveProperty('truncated');
      if (storyId === undefined) expect(sc.item).not.toHaveProperty('storyId');
      else expect(sc.item).toMatchObject({ storyId });
      expect(sc.notice).toMatch(notice);
      const text = allText(result);
      expect(text).toContain(sc.notice as string);
      expect(text).not.toContain('(OP)');
      expect(text).not.toContain('Failed to load');
    },
  );

  /** Root 9_000 nested `depth` comments below story 1: comments 101…(100 + depth), each under the last. */
  function nestedChain(depth: number): Record<number, unknown> {
    const items: Record<number, unknown> = { 1: story(1, 'op') };
    for (let i = 1; i <= depth; i++)
      items[100 + i] = reply(100 + i, `u${100 + i}`, i === 1 ? 1 : 99 + i);
    items[9_000] = { ...reply(9_000, 'r', depth === 0 ? 1 : 100 + depth), kids: [9_001] };
    items[9_001] = reply(9_001, 'op', 9_000);
    return items;
  }

  it('resolves a story 64 requests up, the most one call spends finding it', async () => {
    const { requested } = serveItems(nestedChain(63));

    const sc = okStructured(await callStubbed({ itemId: 9_000, depth: 1 }));

    expect(sc.item).toMatchObject({ storyId: 1 });
    expect(opIds(sc)).toEqual([9_001]);
    expect(requested()).toHaveLength(1 + 64 + 1);
  });

  it('stops looking after 64 requests on a deeper comment, still loading its replies', async () => {
    const { requested } = serveItems(nestedChain(64));

    const sc = okStructured(await callStubbed({ itemId: 9_000, depth: 1 }));

    expect(requested()).toHaveLength(1 + 64 + 1);
    expect(requested()).not.toContain('/item/1.json');
    expect(commentIds(sc)).toEqual([9_001]);
    expect(opIds(sc)).toEqual([]);
    expect(sc.item).not.toHaveProperty('storyId');
    expect(sc.notice).toBe(
      "Could not find the story this comment belongs to: it sits more than 64 levels below its story. storyId is absent and replies by the story's author are not marked isOp.",
    );
  });

  const thread = {
    1: story(1, 'op'),
    10: reply(10, 'u10', 1),
    20: reply(20, 'r', 10, [30, 31]),
    30: reply(30, 'op', 20),
    31: reply(31, 'r', 20),
  };

  it('fetches nothing more after a 429 while finding the story, and finds it when the cursor continues', async () => {
    (getHnService as Mock).mockReturnValue(new HnService(1));
    const { requested } = serveItems({ ...thread, 1: httpStatus(429, { 'Retry-After': '120' }) });

    const first = okStructured(await callStubbed({ itemId: 20, depth: 1 }));

    expect(requested()).toEqual(['/item/20.json', '/item/10.json', '/item/1.json']);
    expect(first.comments).toEqual([]);
    expect(first).toMatchObject({ truncated: true, truncationReason: 'rate_limited' });
    expect(first).not.toHaveProperty('failedIds');
    expect(first.item).not.toHaveProperty('storyId');
    expect(first.notice).toBe(
      "Could not find the story this comment belongs to: the HN API is rate-limiting this server. storyId is absent and replies by the story's author are not marked isOp. Continuing with nextCursor retries the lookup. Stopped early: the HN API is rate-limiting this server. Wait 120 seconds, then pass nextCursor as cursor, with the same itemId, to resume; comments that failed to load are retried first.",
    );

    serveItems(thread);
    const next = okStructured(
      await callStubbed({ itemId: 20, depth: 1, cursor: first.nextCursor }),
    );

    expect(commentIds(next)).toEqual([30, 31]);
    expect(opIds(next)).toEqual([30]);
    expect(next.item).toMatchObject({ storyId: 1 });
    expect(next).not.toHaveProperty('notice');
  });

  it('names the wait after a 429 while finding the story when no cursor is left to continue', async () => {
    serveItems({ 10: httpStatus(429, { 'Retry-After': '120' }), 20: reply(20, 'r', 10) });

    const sc = okStructured(await callStubbed({ itemId: 20, depth: 3 }));

    expect(sc).not.toHaveProperty('nextCursor');
    expect(sc).not.toHaveProperty('truncated');
    expect(sc.notice).toBe(
      "Could not find the story this comment belongs to: the HN API is rate-limiting this server. storyId is absent and replies by the story's author are not marked isOp. Wait 120 seconds, then call again.",
    );
  });

  it('ends the lookup at the 20-second deadline when an ancestor hangs, then loads the replies', async () => {
    const { requested } = serveItems({ ...thread, 10: stall(Number.POSITIVE_INFINITY) });

    const { result, settledAfter } = await timedCall({ itemId: 20, depth: 1 });
    const sc = okStructured(result);

    expect(settledAfter).toBe(20_000);
    /** Ancestor 10 is retried until the deadline; the story above it is never asked for. */
    expect(requested()).toEqual([
      '/item/20.json',
      '/item/10.json',
      '/item/10.json',
      '/item/30.json',
      '/item/31.json',
    ]);
    expect(commentIds(sc)).toEqual([30, 31]);
    expect(opIds(sc)).toEqual([]);
    expect(sc.item).not.toHaveProperty('storyId');
    expect(sc).not.toHaveProperty('failedIds');
    expect(sc.notice).toBe(
      "Could not find the story this comment belongs to: the lookup ran out of time. storyId is absent and replies by the story's author are not marked isOp. Call again to retry.",
    );
  });

  it('counts the 20 seconds from the start of the call, so a slow root leaves the lookup less', async () => {
    serveItems({
      ...thread,
      20: stall(9_500, thread[20]),
      10: stall(9_500, thread[10]),
      1: stall(9_500, thread[1]),
    });

    const { result, settledAfter } = await timedCall({ itemId: 20, depth: 1 });
    const sc = okStructured(result);

    /** Root at 9.5 s, ancestor 10 at 19 s; the story would answer at 28.5 s, past the deadline. */
    expect(settledAfter).toBe(20_000);
    expect(sc.item).not.toHaveProperty('storyId');
    expect(commentIds(sc)).toEqual([30, 31]);
    expect(sc.notice).toBe(
      "Could not find the story this comment belongs to: the lookup ran out of time. storyId is absent and replies by the story's author are not marked isOp. Call again to retry.",
    );
  });

  it('propagates a cancellation that lands while finding the story', async () => {
    const controller = new AbortController();
    /** The abort lands while ancestor 10's request is in flight. */
    const { requested } = serveItems(
      { 1: story(1, 'op'), 10: stall(Number.POSITIVE_INFINITY), 20: reply(20, 'r', 10) },
      {
        onRequest: (route) => {
          if (route === '/item/10.json') controller.abort();
        },
      },
    );
    const ctx = createFrameworkMockContext({ errors: getThread.errors, signal: controller.signal });
    const startedAt = Date.now();
    let settledAfter = Number.NaN;

    const pending = Promise.resolve(
      getThread.handler(getThread.input.parse({ itemId: 20, depth: 0 }), ctx),
    ).finally(() => {
      settledAfter = Date.now() - startedAt;
    });
    const settled = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;

    /** Settled at the abort, with no retry of ancestor 10 and no request for the story. */
    expect(settledAfter).toBe(0);
    expect(requested()).toEqual(['/item/20.json', '/item/10.json']);
  });

  it('propagates a cancellation that lands while a lookup retry is backing off, at depth 0', async () => {
    const controller = new AbortController();
    /** Ancestor 10 answers 500; the abort lands 100 ms later, inside the backoff before its retry. */
    const { requested } = serveItems(
      { 1: story(1, 'op'), 10: httpStatus(500), 20: reply(20, 'r', 10) },
      {
        onRequest: (route) => {
          if (route === '/item/10.json') setTimeout(() => controller.abort(), 100);
        },
      },
    );
    const startedAt = Date.now();
    let settledAfter = Number.NaN;

    const pending = runToolContract(getThread, { itemId: 20, depth: 0 } as never, {
      context: { errors: getThread.errors, signal: controller.signal },
    }).finally(() => {
      settledAfter = Date.now() - startedAt;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(controller.signal.aborted).toBe(true);
    expect(wireError(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    /** Settled at the abort, with the retry never sent and no request for the story. */
    expect(settledAfter).toBe(100);
    expect(requested()).toEqual(['/item/20.json', '/item/10.json']);
  });

  it('fetches nothing more after a 429 the lookup deadline cut short of its retries', async () => {
    /** Two slow ancestors leave 600 ms when story 1 answers 429 with no Retry-After; no backoff fits. */
    const { requested } = serveItems({
      1: httpStatus(429),
      11: stall(9_700, reply(11, 'u11', 1)),
      10: stall(9_700, reply(10, 'u10', 11)),
      20: reply(20, 'r', 10, [30, 31]),
      30: reply(30, 'op', 20),
      31: reply(31, 'r', 20),
    });

    const sc = okStructured(await callStubbed({ itemId: 20, depth: 1 }));

    expect(requested()).toEqual([
      '/item/20.json',
      '/item/10.json',
      '/item/11.json',
      '/item/1.json',
    ]);
    expect(sc.comments).toEqual([]);
    expect(sc).toMatchObject({ truncated: true, truncationReason: 'rate_limited' });
    expect(typeof sc.nextCursor).toBe('string');
    expect(sc.notice).toBe(
      "Could not find the story this comment belongs to: the HN API is rate-limiting this server. storyId is absent and replies by the story's author are not marked isOp. Continuing with nextCursor retries the lookup. Stopped early: the HN API is rate-limiting this server. Wait several seconds, then pass nextCursor as cursor, with the same itemId, to resume; comments that failed to load are retried first.",
    );
  });

  it.each<[string, Record<number, unknown>, string | undefined]>([
    ['an author', thread, undefined],
    [
      'no author',
      { ...thread, 1: { id: 1, type: 'story', deleted: true } },
      'The story this comment belongs to (id 1) has no author on record, so no reply is marked isOp.',
    ],
  ])(
    'continues against the story the first page found, with %s, without walking up again',
    async (_label, items, storyNotice) => {
      const firstServed = serveItems(items);
      const first = okStructured(await callStubbed({ itemId: 20, depth: 1, maxComments: 1 }));

      expect(firstServed.requested()).toEqual([
        '/item/20.json',
        '/item/10.json',
        '/item/1.json',
        '/item/30.json',
      ]);
      expect(first.item).toMatchObject({ storyId: 1 });

      const nextServed = serveItems(items);
      const result = await callStubbed({
        itemId: 20,
        depth: 1,
        maxComments: 1,
        cursor: first.nextCursor,
      });
      const next = okStructured(result);

      expect(nextServed.requested()).toEqual(['/item/20.json', '/item/31.json']);
      expect(commentIds(next)).toEqual([31]);
      expect(next.item).toMatchObject({ storyId: 1 });
      expect(allText(result)).toMatch(/\| story:1\b/);
      expect(commentIds(first)).toEqual([30]);
      const countCut =
        'Stopped at maxComments 1. Pass nextCursor as cursor, with the same itemId, to continue.';
      expect(first.notice).toBe(storyNotice ? `${storyNotice} ${countCut}` : countCut);
      if (storyNotice) {
        expect(opIds(first)).toEqual([]);
        expect(next.notice).toBe(storyNotice);
      } else {
        expect(opIds(first)).toEqual([30]);
        expect(next).not.toHaveProperty('notice');
      }
    },
  );

  it('retries the lookup when the cursor was issued before the story was found', async () => {
    serveItems({ ...thread, 10: httpStatus(500) });
    const first = okStructured(await callStubbed({ itemId: 20, depth: 1, maxComments: 1 }));

    expect(first.item).not.toHaveProperty('storyId');
    expect(commentIds(first)).toEqual([30]);
    expect(opIds(first)).toEqual([]);
    expect(first.notice).toBe(
      "Could not find the story this comment belongs to: ancestor 10 failed to load. storyId is absent and replies by the story's author are not marked isOp. Continuing with nextCursor retries the lookup. Stopped at maxComments 1. Pass nextCursor as cursor, with the same itemId, to continue.",
    );

    const { requested } = serveItems({ ...thread, 31: reply(31, 'op', 20) });
    const next = okStructured(
      await callStubbed({ itemId: 20, depth: 1, maxComments: 1, cursor: first.nextCursor }),
    );

    expect(requested()).toEqual([
      '/item/20.json',
      '/item/10.json',
      '/item/1.json',
      '/item/31.json',
    ]);
    expect(next.item).toMatchObject({ storyId: 1 });
    expect(opIds(next)).toEqual([31]);
  });

  it('finds the story when continuing a JSON-format cursor an earlier release issued', async () => {
    const { requested } = serveItems({ ...thread, 31: reply(31, 'op', 20) });
    const jsonCursor = encodeCursor({
      offset: 1,
      limit: 1,
      itemId: 20,
      depth: 1,
      frontier: [[0, 20, 31]],
    });

    const sc = okStructured(await callStubbed({ itemId: 20, depth: 1, cursor: jsonCursor }));

    expect(requested()).toEqual([
      '/item/20.json',
      '/item/10.json',
      '/item/1.json',
      '/item/31.json',
    ]);
    expect(sc.item).toMatchObject({ storyId: 1 });
    expect(opIds(sc)).toEqual([31]);
  });

  it('marks OP against a story root’s own author whatever story a cursor names', async () => {
    serveItems({
      1: story(1, 'op', { kids: [10, 11] }),
      10: reply(10, 'op', 1),
      11: reply(11, 'mallory', 1),
    });
    const cursor = encodeThreadCursor({
      itemId: 1,
      depth: 1,
      offset: 0,
      depthCut: false,
      frontier: [
        { id: 10, level: 0, parentId: 1 },
        { id: 11, level: 0, parentId: 1 },
      ],
      story: { id: 99, by: 'mallory' },
    });

    const sc = okStructured(await callStubbed({ itemId: 1, depth: 1, cursor }));

    expect(opIds(sc)).toEqual([10]);
    expect(sc.item).not.toHaveProperty('storyId');
  });

  it('keeps isOp a literal true and adds storyId as an optional number', () => {
    const isOp = getThread.output.shape.comments.element.shape.isOp;
    const storyId = getThread.output.shape.item.shape.storyId;

    expect(isOp.safeParse(true).success).toBe(true);
    expect(isOp.safeParse(undefined).success).toBe(true);
    expect(isOp.safeParse(false).success).toBe(false);
    expect(storyId.safeParse(undefined).success).toBe(true);
    expect(storyId.safeParse(50126253).success).toBe(true);
    expect(storyId.safeParse('50126253').success).toBe(false);
    expect(isOp.description).toMatch(/story/);
    expect(isOp.description).not.toMatch(/root item author/);
  });
});
