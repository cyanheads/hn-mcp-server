/**
 * @fileoverview Tests for the hn_get_thread tool — item lookup and ranked BFS comment traversal.
 * @module mcp-server/tools/definitions/get-thread.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { HnItem } from '@/services/hn/types.js';

vi.mock('@/services/hn/hn-service.js', () => ({
  getHnService: vi.fn(),
  stripHtml: vi.fn((html: string) => html),
  normalizeUrl: vi.fn((url?: string) => url || undefined),
}));

import { getThread } from '@/mcp-server/tools/definitions/get-thread.tool.js';
import { getHnService, normalizeUrl, stripHtml } from '@/services/hn/hn-service.js';

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

function createMockHnService() {
  return {
    fetchItem: vi.fn(),
    fetchItems: vi.fn(),
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
    ctx = createMockContext({ errors: getThread.errors });
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

  it('resolves direct replies only at depth 1', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce([mockComment1, mockComment2]);

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
      .mockResolvedValueOnce([mockComment1, mockComment2])
      .mockResolvedValueOnce([mockNestedComment]);

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
    hn.fetchItems.mockResolvedValueOnce([mockComment1, mockComment2]);

    const result = await getThread.handler(parse({ depth: 3, maxComments: 1 }), ctx);

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].id).toBe(10);
    expect(getEnrichment(ctx).totalLoaded).toBe(1);
  });

  it('filters out dead and deleted comments', async () => {
    const deadComment: HnItem = { id: 10, type: 'comment', dead: true, parent: 1 };
    const deletedComment: HnItem = { id: 11, type: 'comment', deleted: true, parent: 1 };
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce([deadComment, deletedComment]);

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
    hn.fetchItems.mockResolvedValueOnce([live, dead, deleted1, deleted2]);

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments).toHaveLength(1);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/2 deleted.*1 dead/i);
  });

  it('omits notice when no comments are dropped and all comments loaded', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);
    // Fetch returns exactly the 2 kids, both live, totalAvailable = descendants = 3
    // but totalLoaded=2 < totalAvailable=3 (one kid not resolved due to depth)
    // Actually mockStory has descendants:3 and kids:[10,11], so 2 loaded < 3 available → notice fires.
    // Use a story where all are loaded: descendants=2, kids=[10,11]
    const fullStory: HnItem = { ...mockStory, descendants: 2 };
    hn.fetchItem.mockResolvedValue(fullStory);
    hn.fetchItems.mockResolvedValueOnce([mockComment1, mockComment2]);

    await getThread.handler(parse({ depth: 1 }), ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('marks isOp:true when comment author equals root author', async () => {
    /** Alice is the OP of mockStory; her reply on her own thread should be tagged. */
    const opReply: HnItem = { id: 10, type: 'comment', by: 'alice', text: 'thanks!', parent: 1 };
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce([opReply, mockComment2]);

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments[0]).toMatchObject({ id: 10, by: 'alice', isOp: true });
    expect(result.comments[1]).toMatchObject({ id: 11, by: 'carol' });
    expect(result.comments[1]).not.toHaveProperty('isOp');
  });

  it('omits isOp when comment author is missing', async () => {
    const anonComment: HnItem = { id: 10, type: 'comment', text: '...', parent: 1 };
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce([anonComment]);

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments[0]).toMatchObject({ id: 10 });
    expect(result.comments[0]).not.toHaveProperty('isOp');
  });

  it('omits isOp when root author is missing (cannot match anonymous OP)', async () => {
    const { by: _by, ...storyWithoutAuthor } = mockStory;
    const anonStory: HnItem = storyWithoutAuthor;
    const anonComment: HnItem = { id: 10, type: 'comment', text: '...', parent: 1 };
    hn.fetchItem.mockResolvedValue(anonStory);
    hn.fetchItems.mockResolvedValueOnce([anonComment]);

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments[0]).toMatchObject({ id: 10 });
    expect(result.comments[0]).not.toHaveProperty('isOp');
  });

  it('calls stripHtml on item text and comment text', async () => {
    const storyWithText: HnItem = { ...mockStory, text: '<p>Hello</p>', title: '<b>Title</b>' };
    const { kids: _k, ...comment1Base } = mockComment1;
    const commentWithHtml: HnItem = { ...comment1Base, text: '<i>Styled</i>' };
    hn.fetchItem.mockResolvedValue(storyWithText);
    hn.fetchItems.mockResolvedValueOnce([commentWithHtml]);

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
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('Test Story');
    expect(blocks[0].text).toContain('42 pts');
    expect(blocks[0].text).toContain('by alice');
    expect(blocks[0].text).toContain('https://example.com');
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
    const text = blocks[0].text;
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
    const text = blocks[0].text;
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
    expect(blocks[0].text).toContain('Comment by bob');
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
    ctx = createMockContext({ errors: getThread.errors });
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
    expect(blocks[0]!.text).toContain('Comment by unknown');
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
    const text = blocks[0]!.text;
    // Capped at 10 means at most 20 spaces of indent (10 * 2 spaces each)
    const commentLine = text.split('\n').find((l) => l.includes('deeply_nested'))!;
    const leadingSpaces = commentLine.match(/^ */)?.[0]?.length ?? 0;
    expect(leadingSpaces).toBeLessThanOrEqual(20);
  });

  it('format() output does not contain raw secrets or env variables', async () => {
    process.env.HN_CONCURRENCY_LIMIT = 'SECRET_SENTINEL_999';
    const storyWithText: HnItem = { ...mockStory, text: 'Normal story text' };
    hn.fetchItem.mockResolvedValue(storyWithText);
    hn.fetchItems.mockResolvedValueOnce([mockComment1]);

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
    hn.fetchItems.mockResolvedValueOnce([mockComment1, mockComment2]);

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
    hn.fetchItems.mockResolvedValueOnce([live, dead, deleted]);

    await getThread.handler(parse({ depth: 1, maxComments: 50 }), ctx);

    const notice = getEnrichment(ctx).notice!;
    // Both parts should appear: dropped counts and loaded/available counts
    expect(notice).toMatch(/deleted/i);
    expect(notice).toMatch(/dead/i);
    expect(notice).toMatch(/loaded/i);
  });
});
