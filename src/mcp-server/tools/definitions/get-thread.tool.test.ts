/**
 * @fileoverview Tests for the get_thread tool — item lookup and ranked BFS comment traversal.
 * @module mcp-server/tools/definitions/get-thread.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

describe('get_thread handler', () => {
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

  it('returns item only with empty comments when depth is 0', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);
    const result = await getThread.handler(parse({ depth: 0 }), ctx);

    expect(result.item.id).toBe(1);
    expect(result.comments).toEqual([]);
    expect(result.totalLoaded).toBe(0);
    expect(result.totalAvailable).toBe(3);
    expect(hn.fetchItems).not.toHaveBeenCalled();
  });

  it('returns empty comments when story has no kids', async () => {
    const noKids = { ...mockStory, kids: [] as number[], descendants: 0 } satisfies HnItem;
    hn.fetchItem.mockResolvedValue(noKids);
    const result = await getThread.handler(parse({ depth: 3 }), ctx);

    expect(result.comments).toEqual([]);
    expect(result.totalLoaded).toBe(0);
  });

  it('resolves direct replies only at depth 1', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce([mockComment1, mockComment2]);

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]).toMatchObject({ id: 10, depth: 0, parentId: 1, childCount: 1 });
    expect(result.comments[1]).toMatchObject({ id: 11, depth: 0, parentId: 1, childCount: 0 });
    expect(hn.fetchItems).toHaveBeenCalledTimes(1);
    expect(result.totalLoaded).toBe(2);
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
    expect(result.totalLoaded).toBe(3);
  });

  it('limits total comments via maxComments', async () => {
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce([mockComment1, mockComment2]);

    const result = await getThread.handler(parse({ depth: 3, maxComments: 1 }), ctx);

    expect(result.comments).toHaveLength(1);
    expect(result.comments.at(0)?.id).toBe(10);
    expect(result.totalLoaded).toBe(1);
  });

  it('filters out dead and deleted comments', async () => {
    const deadComment: HnItem = { id: 10, type: 'comment', dead: true, parent: 1 };
    const deletedComment: HnItem = { id: 11, type: 'comment', deleted: true, parent: 1 };
    hn.fetchItem.mockResolvedValue(mockStory);
    hn.fetchItems.mockResolvedValueOnce([deadComment, deletedComment]);

    const result = await getThread.handler(parse({ depth: 1 }), ctx);

    expect(result.comments).toHaveLength(0);
    expect(result.totalLoaded).toBe(0);
  });

  it('calls stripHtml on item text and comment text', async () => {
    const storyWithText: HnItem = { ...mockStory, text: '<p>Hello</p>', title: '<b>Title</b>' };
    const comment1Base: HnItem = {
      id: 10,
      type: 'comment',
      by: 'bob',
      time: 1001,
      text: '<i>Styled</i>',
      parent: 1,
    };
    hn.fetchItem.mockResolvedValue(storyWithText);
    hn.fetchItems.mockResolvedValueOnce([comment1Base]);

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

describe('get_thread format', () => {
  type FormatInput = Parameters<NonNullable<typeof getThread.format>>[0];

  /** Call format and extract the text from the first block. */
  function formatText(result: FormatInput): string {
    const format = getThread.format;
    expect(format).toBeDefined();
    const blocks = format?.(result) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    const first = blocks.at(0);
    expect(first?.type).toBe('text');
    return first?.type === 'text' ? first.text : '';
  }

  it('formats story with no comments', () => {
    const text = formatText({
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
      totalLoaded: 0,
      totalAvailable: 0,
    } as FormatInput);

    expect(text).toContain('Test Story');
    expect(text).toContain('42 pts');
    expect(text).toContain('by alice');
    expect(text).toContain('https://example.com');
  });

  it('formats story with indented comment tree', () => {
    const text = formatText({
      item: { id: 1, type: 'story', by: 'alice', title: 'Test Story', score: 10, descendants: 2 },
      comments: [
        { id: 10, by: 'bob', time: 1001, text: 'Top-level', depth: 0, parentId: 1, childCount: 1 },
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
      totalLoaded: 2,
      totalAvailable: 2,
    } as FormatInput);

    expect(text).toContain('[bob]');
    expect(text).toContain('Top-level');
    expect(text).toContain('  [carol]');
    expect(text).toContain('  Nested reply');
  });

  it('shows partial load indicator when not all comments loaded', () => {
    const text = formatText({
      item: {
        id: 1,
        type: 'story',
        by: 'alice',
        title: 'Big Thread',
        score: 100,
        descendants: 500,
      },
      comments: [
        {
          id: 10,
          by: 'bob',
          time: 1001,
          text: 'Only comment',
          depth: 0,
          parentId: 1,
          childCount: 0,
        },
      ],
      totalLoaded: 1,
      totalAvailable: 500,
    } as FormatInput);

    expect(text).toContain('(1/500 comments loaded)');
  });

  it('formats comment as root with "Comment by author"', () => {
    const text = formatText({
      item: { id: 10, type: 'comment', by: 'bob', text: 'Some comment' },
      comments: [],
      totalLoaded: 0,
    } as FormatInput);

    expect(text).toContain('Comment by bob');
  });
});

// ---------------------------------------------------------------------------
// Input validation tests
// ---------------------------------------------------------------------------

describe('get_thread input validation', () => {
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
