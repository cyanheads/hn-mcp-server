/**
 * @fileoverview Tests for the hn_get_stories tool.
 * @module mcp-server/tools/definitions/get-stories.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/hn/hn-service.js', () => ({
  getHnService: vi.fn(),
  filterLiveItems: vi.fn((items: unknown[]) =>
    items.filter((i: any) => i != null && !i.deleted && !i.dead),
  ),
  stripHtml: vi.fn((html: string) => html),
  normalizeUrl: vi.fn((url?: string) => url || undefined),
}));

import { getStories } from '@/mcp-server/tools/definitions/get-stories.tool.js';
import { getHnService } from '@/services/hn/hn-service.js';
import type { HnItem } from '@/services/hn/types.js';

function makeItem(overrides: Partial<HnItem> & { id: number }): HnItem {
  return {
    type: 'story',
    by: 'testuser',
    title: `Story ${overrides.id}`,
    url: `https://example.com/${overrides.id}`,
    score: 100,
    time: 1700000000,
    descendants: 42,
    ...overrides,
  };
}

describe('getStories', () => {
  const mockService = {
    fetchFeed: vi.fn<() => Promise<number[]>>(),
    fetchItems: vi.fn<() => Promise<(HnItem | null)[]>>(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHnService).mockReturnValue(mockService as any);
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  describe('input validation', () => {
    it('parses valid input with defaults', () => {
      const parsed = getStories.input.parse({ feed: 'top' });
      expect(parsed).toEqual({ feed: 'top', count: 30, offset: 0 });
    });

    it('rejects count out of range', () => {
      expect(() => getStories.input.parse({ feed: 'top', count: 0 })).toThrow();
      expect(() => getStories.input.parse({ feed: 'top', count: 101 })).toThrow();
    });

    it('rejects invalid feed value', () => {
      expect(() => getStories.input.parse({ feed: 'invalid' })).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Handler
  // ---------------------------------------------------------------------------

  describe('handler', () => {
    it('returns stories with correct shape', async () => {
      const ids = [1, 2, 3];
      const items = ids.map((id) => makeItem({ id }));

      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue(items);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'top', count: 10 });
      const result = await getStories.handler(input, ctx);

      expect(result.feed).toBe('top');
      expect(result.total).toBe(3);
      expect(result.offset).toBe(0);
      expect(result.hasMore).toBe(false);
      expect(result.stories).toHaveLength(3);
      expect(result.stories[0]).toEqual({
        id: 1,
        type: 'story',
        title: 'Story 1',
        url: 'https://example.com/1',
        score: 100,
        by: 'testuser',
        time: 1700000000,
        descendants: 42,
      });
      expect(result.stories[0]).not.toHaveProperty('text');
    });

    it('paginates with offset and sets hasMore correctly', async () => {
      const ids = Array.from({ length: 50 }, (_, i) => i + 1);
      const pageItems = [makeItem({ id: 11 }), makeItem({ id: 12 })];

      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue(pageItems);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'new', count: 2, offset: 10 });
      const result = await getStories.handler(input, ctx);

      expect(mockService.fetchItems).toHaveBeenCalledWith([11, 12], expect.anything());
      expect(result.offset).toBe(10);
      expect(result.hasMore).toBe(true);
      expect(result.stories).toHaveLength(2);
    });

    it('returns hasMore false when at end of feed', async () => {
      const ids = [1, 2, 3];
      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue(ids.map((id) => makeItem({ id })));

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'best', count: 10, offset: 0 });
      const result = await getStories.handler(input, ctx);

      expect(result.hasMore).toBe(false);
    });

    it('returns empty stories for an empty feed', async () => {
      mockService.fetchFeed.mockResolvedValue([]);
      mockService.fetchItems.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'ask' });
      const result = await getStories.handler(input, ctx);

      expect(result.stories).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('filters out dead and deleted items', async () => {
      const ids = [1, 2, 3, 4];
      const items: (HnItem | null)[] = [
        makeItem({ id: 1 }),
        makeItem({ id: 2, dead: true }),
        makeItem({ id: 3, deleted: true }),
        null,
      ];

      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue(items);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'top', count: 10 });
      const result = await getStories.handler(input, ctx);

      expect(result.stories).toHaveLength(1);
      expect(result.stories[0]!.id).toBe(1);
    });

    it('passes text through stripHtml', async () => {
      const items = [makeItem({ id: 1, text: '<p>Hello <b>world</b></p>' })];
      mockService.fetchFeed.mockResolvedValue([1]);
      mockService.fetchItems.mockResolvedValue(items);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'ask' });
      const result = await getStories.handler(input, ctx);

      const { stripHtml } = await import('@/services/hn/hn-service.js');
      expect(stripHtml).toHaveBeenCalledWith('<p>Hello <b>world</b></p>');
      expect(result.stories[0]!.text).toBe('<p>Hello <b>world</b></p>');
    });

    it('omits text when item has no text field', async () => {
      const items = [makeItem({ id: 1, text: undefined })];
      mockService.fetchFeed.mockResolvedValue([1]);
      mockService.fetchItems.mockResolvedValue(items);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'top' });
      const result = await getStories.handler(input, ctx);

      expect(result.stories[0]!).not.toHaveProperty('text');
    });

    it('preserves absence for sparse upstream fields instead of fabricating defaults', async () => {
      // HN Firebase may omit score/by/time/title on degraded/edge items.
      // Per sparse-upstream guidance, the tool must NOT substitute 0/''/epoch —
      // the absence should propagate to the output.
      const sparse: HnItem = { id: 42, type: 'story' };
      mockService.fetchFeed.mockResolvedValue([42]);
      mockService.fetchItems.mockResolvedValue([sparse]);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'top' });
      const result = await getStories.handler(input, ctx);

      const story = result.stories[0]!;
      expect(story.id).toBe(42);
      expect(story.type).toBe('story');
      expect(story).not.toHaveProperty('title');
      expect(story).not.toHaveProperty('url');
      expect(story).not.toHaveProperty('score');
      expect(story).not.toHaveProperty('by');
      expect(story).not.toHaveProperty('time');
      expect(story).not.toHaveProperty('descendants');
      expect(story).not.toHaveProperty('text');

      // Output still validates against the schema.
      expect(() => getStories.output.parse(result)).not.toThrow();
    });

    it('format() renders sparse stories without inventing facts', () => {
      const blocks = getStories.format!({
        stories: [{ id: 42, type: 'story' }],
        feed: 'top',
        total: 1,
        offset: 0,
        hasMore: false,
      });

      const text = blocks[0]!.text;
      // Falls back to type label when title is unknown.
      expect(text).toContain('[1] [story]');
      // Only id is rendered in meta — no fabricated "0 pts" or "by ".
      expect(text).toContain('id:42');
      expect(text).not.toMatch(/\d+ pts/);
      expect(text).not.toMatch(/by\s+\|/);
      expect(text).not.toMatch(/by\s*$/);
    });
  });

  // ---------------------------------------------------------------------------
  // Format
  // ---------------------------------------------------------------------------

  describe('format', () => {
    it('returns feed name message for empty stories', () => {
      const blocks = getStories.format!({
        stories: [],
        feed: 'show',
        total: 0,
        offset: 0,
        hasMore: false,
      });

      expect(blocks).toEqual([{ type: 'text', text: 'show feed — no stories' }]);
    });

    it('renders stories with rank, title, points, comments, and url', () => {
      const blocks = getStories.format!({
        stories: [
          {
            id: 1,
            title: 'Test Story',
            url: 'https://example.com',
            score: 200,
            by: 'author',
            time: 1700000000,
            descendants: 55,
            type: 'story',
          },
        ],
        feed: 'top',
        total: 100,
        offset: 0,
        hasMore: true,
      });

      expect(blocks).toHaveLength(1);
      const text = blocks[0]!.text;
      expect(text).toContain('## top stories (1–1 of 100, offset:0)');
      expect(text).toContain('[1] Test Story');
      expect(text).toContain('200 pts | by author | 55 comments');
      expect(text).toContain('id:1');
      expect(text).toContain('https://example.com');
    });

    it('uses offset for rank numbering', () => {
      const blocks = getStories.format!({
        stories: [
          {
            id: 5,
            title: 'Offset Story',
            url: 'https://example.com/5',
            score: 50,
            by: 'author',
            time: 1700000000,
            descendants: 10,
            type: 'story',
          },
          {
            id: 6,
            title: 'Next Story',
            url: 'https://example.com/6',
            score: 40,
            by: 'author2',
            time: 1700000000,
            descendants: 5,
            type: 'story',
          },
        ],
        feed: 'new',
        total: 200,
        offset: 20,
        hasMore: true,
      });

      const text = blocks[0]!.text;
      expect(text).toContain('new stories (21–22 of 200, offset:20)');
      expect(text).toContain('[21] Offset Story');
      expect(text).toContain('[22] Next Story');
    });

    it('omits comments section for items without descendants', () => {
      const blocks = getStories.format!({
        stories: [
          {
            id: 1,
            title: 'Job Post',
            score: 10,
            by: 'employer',
            time: 1700000000,
            type: 'job',
          },
        ],
        feed: 'jobs',
        total: 50,
        offset: 0,
        hasMore: true,
      });

      const text = blocks[0]!.text;
      expect(text).toContain('[1] Job Post');
      expect(text).toContain('10 pts | by employer');
      expect(text).toContain('id:1');
      expect(text).not.toContain('comments');
    });

    it('omits url line for text-only posts', () => {
      const blocks = getStories.format!({
        stories: [
          {
            id: 1,
            title: 'Ask HN: Something',
            score: 75,
            by: 'curious',
            time: 1700000000,
            descendants: 30,
            type: 'story',
          },
        ],
        feed: 'ask',
        total: 10,
        offset: 0,
        hasMore: false,
      });

      const text = blocks[0]!.text;
      expect(text).toContain('[1] Ask HN: Something');
      expect(text).toContain('75 pts | by curious | 30 comments');
      expect(text).not.toMatch(/\nhttps?:/);
    });
  });
});
