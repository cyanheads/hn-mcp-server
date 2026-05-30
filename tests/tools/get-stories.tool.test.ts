/**
 * @fileoverview Tests for the hn_get_stories tool.
 * @module mcp-server/tools/definitions/get-stories.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/hn/hn-service.js', () => ({
  getHnService: vi.fn(),
  filterLiveItems: vi.fn((items: unknown[]) =>
    items.filter((i: any) => i != null && !i.deleted && !i.dead),
  ),
  stripHtml: vi.fn((html: string) => html),
  normalizeUrl: vi.fn((url?: string) => url || undefined),
  extractDomain: vi.fn((url?: string) => {
    if (!url) return;
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return;
    }
  }),
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
    it('returns stories with correct shape and enrichment', async () => {
      const ids = [1, 2, 3];
      const items = ids.map((id) => makeItem({ id }));

      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue(items);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'top', count: 10 });
      const result = await getStories.handler(input, ctx);

      expect(result.feed).toBe('top');
      expect(result.stories).toHaveLength(3);
      expect(result.stories[0]).toEqual({
        id: 1,
        type: 'story',
        title: 'Story 1',
        url: 'https://example.com/1',
        domain: 'example.com',
        score: 100,
        by: 'testuser',
        time: 1700000000,
        descendants: 42,
      });
      expect(result.stories[0]).not.toHaveProperty('text');

      const enrichment = getEnrichment(ctx);
      expect(enrichment.total).toBe(3);
      expect(enrichment.offset).toBe(0);
      expect(enrichment.hasMore).toBe(false);
      expect(enrichment.notice).toBeUndefined();
    });

    it('derives domain from url and strips www.', async () => {
      const items = [
        makeItem({ id: 1, url: 'https://www.github.com/repo' }),
        makeItem({ id: 2, url: 'https://news.ycombinator.com/item?id=42' }),
      ];
      mockService.fetchFeed.mockResolvedValue([1, 2]);
      mockService.fetchItems.mockResolvedValue(items);

      const ctx = createMockContext();
      const result = await getStories.handler(getStories.input.parse({ feed: 'top' }), ctx);

      expect(result.stories[0]!.domain).toBe('github.com');
      expect(result.stories[1]!.domain).toBe('news.ycombinator.com');
    });

    it('omits domain when url is absent or unparseable', async () => {
      const items = [makeItem({ id: 1, url: undefined }), makeItem({ id: 2, url: 'not a url' })];
      mockService.fetchFeed.mockResolvedValue([1, 2]);
      mockService.fetchItems.mockResolvedValue(items);

      const ctx = createMockContext();
      const result = await getStories.handler(getStories.input.parse({ feed: 'top' }), ctx);

      expect(result.stories[0]!).not.toHaveProperty('domain');
      expect(result.stories[1]!).not.toHaveProperty('domain');
    });

    it('paginates with offset and sets hasMore in enrichment', async () => {
      const ids = Array.from({ length: 50 }, (_, i) => i + 1);
      const pageItems = [makeItem({ id: 11 }), makeItem({ id: 12 })];

      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue(pageItems);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'new', count: 2, offset: 10 });
      const result = await getStories.handler(input, ctx);

      expect(mockService.fetchItems).toHaveBeenCalledWith([11, 12], expect.anything());
      expect(result.stories).toHaveLength(2);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.offset).toBe(10);
      expect(enrichment.hasMore).toBe(true);
    });

    it('sets hasMore false when at end of feed', async () => {
      const ids = [1, 2, 3];
      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue(ids.map((id) => makeItem({ id })));

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'best', count: 10, offset: 0 });
      await getStories.handler(input, ctx);

      expect(getEnrichment(ctx).hasMore).toBe(false);
    });

    it('emits notice when feed is empty', async () => {
      mockService.fetchFeed.mockResolvedValue([]);
      mockService.fetchItems.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'ask' });
      const result = await getStories.handler(input, ctx);

      expect(result.stories).toEqual([]);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.total).toBe(0);
      expect(enrichment.notice).toMatch(/empty/i);
    });

    it('emits notice when offset is past end of feed', async () => {
      const ids = [1, 2, 3];
      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'top', count: 10, offset: 100 });
      await getStories.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toMatch(/offset/i);
      expect(enrichment.notice).toMatch(/100/);
    });

    it('emits notice when page is empty due to filtered items', async () => {
      const ids = Array.from({ length: 10 }, (_, i) => i + 1);
      // All items are dead/deleted so filterLiveItems returns empty
      const deadItems = ids.map((id) => makeItem({ id, dead: true }));
      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue(deadItems);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'top', count: 5, offset: 0 });
      await getStories.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      // total=10, offset=0, stories=[]: no-live-items notice
      expect(enrichment.notice).toBeDefined();
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
            domain: 'example.com',
            score: 200,
            by: 'author',
            time: 1700000000,
            descendants: 55,
            type: 'story',
          },
        ],
        feed: 'top',
      });

      expect(blocks).toHaveLength(1);
      const text = blocks[0]!.text;
      expect(text).toContain('## top stories');
      expect(text).toContain('[1] Test Story (example.com)');
      expect(text).toContain('200 pts | by author | 55 comments');
      expect(text).toContain('id:1');
      expect(text).toContain('https://example.com');
    });

    it('omits domain parens when domain is absent', () => {
      const blocks = getStories.format!({
        stories: [
          {
            id: 1,
            title: 'Ask HN: Best Editor?',
            score: 50,
            by: 'curious',
            time: 1700000000,
            descendants: 20,
            type: 'story',
          },
        ],
        feed: 'ask',
      });

      const text = blocks[0]!.text;
      expect(text).toContain('[1] Ask HN: Best Editor?\n');
      expect(text).not.toMatch(/\(\)/);
    });

    it('uses sequential rank starting from 1 (rank is relative to page, not absolute)', () => {
      const blocks = getStories.format!({
        stories: [
          {
            id: 5,
            title: 'First on Page',
            url: 'https://example.com/5',
            score: 50,
            by: 'author',
            time: 1700000000,
            descendants: 10,
            type: 'story',
          },
          {
            id: 6,
            title: 'Second on Page',
            url: 'https://example.com/6',
            score: 40,
            by: 'author2',
            time: 1700000000,
            descendants: 5,
            type: 'story',
          },
        ],
        feed: 'new',
      });

      const text = blocks[0]!.text;
      expect(text).toContain('[1] First on Page');
      expect(text).toContain('[2] Second on Page');
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
      });

      const text = blocks[0]!.text;
      expect(text).toContain('[1] Ask HN: Something');
      expect(text).toContain('75 pts | by curious | 30 comments');
      expect(text).not.toMatch(/\nhttps?:/);
    });
  });
});
