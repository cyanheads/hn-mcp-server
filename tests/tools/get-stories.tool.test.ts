/**
 * @fileoverview Tests for the hn_get_stories tool.
 * @module mcp-server/tools/definitions/get-stories.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext as createFrameworkMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Only the accessor and the text helpers are faked. `settlePage` and
 * `HnService` stay real, so the partial-failure suites below run the actual
 * service against a stubbed fetch.
 */
vi.mock('@/services/hn/hn-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/hn/hn-service.js')>()),
  getHnService: vi.fn(),
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
import { getHnService, HnService, type ItemSlot } from '@/services/hn/hn-service.js';
import type { HnItem } from '@/services/hn/types.js';
import { httpStatus, rejectUnmockedFetch, stubHnApi } from '../helpers/hn-api-stub.js';

rejectUnmockedFetch();

function createMockContext() {
  return createFrameworkMockContext({ errors: getStories.errors });
}

/** Wrap returned items as the batch slots `fetchItems` yields. */
function slotsOf(items: HnItem[]): ItemSlot[] {
  return items.map((item) => ({ kind: 'item', id: item.id, item }));
}

function firstText(blocks: ReturnType<NonNullable<typeof getStories.format>>): string {
  const block = blocks[0];
  if (block?.type !== 'text') throw new Error('Expected a text content block');
  return block.text;
}

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
    fetchItems: vi.fn<() => Promise<ItemSlot[]>>(),
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
      mockService.fetchItems.mockResolvedValue(slotsOf(items));

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
      mockService.fetchItems.mockResolvedValue(slotsOf(items));

      const ctx = createMockContext();
      const result = await getStories.handler(getStories.input.parse({ feed: 'top' }), ctx);

      expect(result.stories[0]!.domain).toBe('github.com');
      expect(result.stories[1]!.domain).toBe('news.ycombinator.com');
    });

    it('omits domain when url is absent or unparseable', async () => {
      const { url: _url, ...withoutUrl } = makeItem({ id: 1 });
      const items = [withoutUrl, makeItem({ id: 2, url: 'not a url' })];
      mockService.fetchFeed.mockResolvedValue([1, 2]);
      mockService.fetchItems.mockResolvedValue(slotsOf(items));

      const ctx = createMockContext();
      const result = await getStories.handler(getStories.input.parse({ feed: 'top' }), ctx);

      expect(result.stories[0]!).not.toHaveProperty('domain');
      expect(result.stories[1]!).not.toHaveProperty('domain');
    });

    it('paginates with offset and sets hasMore in enrichment', async () => {
      const ids = Array.from({ length: 50 }, (_, i) => i + 1);
      const pageItems = [makeItem({ id: 11 }), makeItem({ id: 12 })];

      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue(slotsOf(pageItems));

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
      mockService.fetchItems.mockResolvedValue(slotsOf(ids.map((id) => makeItem({ id }))));

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
      // All items are dead/deleted so settlePage returns no live items
      const deadItems = ids.map((id) => makeItem({ id, dead: true }));
      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue(slotsOf(deadItems));

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'top', count: 5, offset: 0 });
      await getStories.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      // total=10, offset=0, stories=[]: no-live-items notice
      expect(enrichment.notice).toBeDefined();
    });

    it('filters out dead, deleted, and absent items', async () => {
      const ids = [1, 2, 3, 4];
      const items = [
        makeItem({ id: 1 }),
        makeItem({ id: 2, dead: true }),
        makeItem({ id: 3, deleted: true }),
      ];

      mockService.fetchFeed.mockResolvedValue(ids);
      mockService.fetchItems.mockResolvedValue([...slotsOf(items), { kind: 'absent', id: 4 }]);

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'top', count: 10 });
      const result = await getStories.handler(input, ctx);

      expect(result.stories).toHaveLength(1);
      expect(result.stories[0]!.id).toBe(1);
    });

    it('passes text through stripHtml', async () => {
      const items = [makeItem({ id: 1, text: '<p>Hello <b>world</b></p>' })];
      mockService.fetchFeed.mockResolvedValue([1]);
      mockService.fetchItems.mockResolvedValue(slotsOf(items));

      const ctx = createMockContext();
      const input = getStories.input.parse({ feed: 'ask' });
      const result = await getStories.handler(input, ctx);

      const { stripHtml } = await import('@/services/hn/hn-service.js');
      expect(stripHtml).toHaveBeenCalledWith('<p>Hello <b>world</b></p>');
      expect(result.stories[0]!.text).toBe('<p>Hello <b>world</b></p>');
    });

    it('omits text when item has no text field', async () => {
      const items = [makeItem({ id: 1 })];
      mockService.fetchFeed.mockResolvedValue([1]);
      mockService.fetchItems.mockResolvedValue(slotsOf(items));

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
      mockService.fetchItems.mockResolvedValue(slotsOf([sparse]));

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

      const text = firstText(blocks);
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
      const text = firstText(blocks);
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

      const text = firstText(blocks);
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

      const text = firstText(blocks);
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

      const text = firstText(blocks);
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

      const text = firstText(blocks);
      expect(text).toContain('[1] Ask HN: Something');
      expect(text).toContain('75 pts | by curious | 30 comments');
      expect(text).not.toMatch(/\nhttps?:/);
    });
  });
});

// ---------------------------------------------------------------------------
// Security and edge cases
// ---------------------------------------------------------------------------

describe('getStories — security and edge cases', () => {
  const mockService = {
    fetchFeed: vi.fn<() => Promise<number[]>>(),
    fetchItems: vi.fn<() => Promise<ItemSlot[]>>(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHnService).mockReturnValue(mockService as any);
  });

  it('rejects offset below 0', () => {
    expect(() => getStories.input.parse({ feed: 'top', offset: -1 })).toThrow();
  });

  it('rejects non-integer count passed as string (type coercion not applied)', () => {
    // The schema uses z.number(), so a string should fail
    expect(() => getStories.input.parse({ feed: 'top', count: 'ten' as any })).toThrow();
  });

  it.each([
    ['count', { count: 1.5 }],
    ['offset', { offset: 1.5 }],
  ])('rejects fractional %s', (_field, overrides) => {
    expect(() => getStories.input.parse({ feed: 'top', ...overrides })).toThrow();
  });

  it('output schema validates correctly on non-empty result', () => {
    const result = {
      stories: [{ id: 1, type: 'story', title: 'Test', score: 10, by: 'alice', time: 1 }],
      feed: 'top',
    };
    expect(() => getStories.output.parse(result)).not.toThrow();
  });

  it('format() does not emit internal env var values in any story field', async () => {
    process.env.HN_CONCURRENCY_LIMIT = 'SECRET_SENTINEL';
    const items = [makeItem({ id: 1 })];
    mockService.fetchFeed.mockResolvedValue([1]);
    mockService.fetchItems.mockResolvedValue(slotsOf(items));

    const ctx = createMockContext();
    const result = await getStories.handler(getStories.input.parse({ feed: 'top' }), ctx);
    const blocks = getStories.format!(result);

    for (const block of blocks) {
      if (block.type === 'text') {
        expect(block.text).not.toContain('SECRET_SENTINEL');
      }
    }
    delete process.env.HN_CONCURRENCY_LIMIT;
  });

  it('handles unicode story title and url without mangling', async () => {
    const items = [makeItem({ id: 1, title: 'Русский заголовок', url: 'https://примеры.рф/путь' })];
    mockService.fetchFeed.mockResolvedValue([1]);
    mockService.fetchItems.mockResolvedValue(slotsOf(items));

    const ctx = createMockContext();
    const result = await getStories.handler(getStories.input.parse({ feed: 'top' }), ctx);

    expect(result.stories[0]!.title).toBe('Русский заголовок');
    expect(result.stories[0]!.url).toBe('https://примеры.рф/путь');
  });

  it('handles a single-item feed with count=1 and offset=0 correctly', async () => {
    mockService.fetchFeed.mockResolvedValue([999]);
    mockService.fetchItems.mockResolvedValue(slotsOf([makeItem({ id: 999 })]));

    const ctx = createMockContext();
    const input = getStories.input.parse({ feed: 'jobs', count: 1, offset: 0 });
    const result = await getStories.handler(input, ctx);

    expect(result.stories).toHaveLength(1);
    expect(result.stories[0]!.id).toBe(999);
  });

  it('handles max count=100 without throwing', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    mockService.fetchFeed.mockResolvedValue(ids);
    mockService.fetchItems.mockResolvedValue(slotsOf(ids.map((id) => makeItem({ id }))));

    const ctx = createMockContext();
    const input = getStories.input.parse({ feed: 'top', count: 100 });
    const result = await getStories.handler(input, ctx);

    expect(result.stories).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// Contract-level result helpers
// ---------------------------------------------------------------------------

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

function structured(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

function contentText(result: ToolResult): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Pagination notices — terminal pages versus truncation
// ---------------------------------------------------------------------------

describe('getStories — pagination notices', () => {
  const mockService = {
    fetchFeed: vi.fn<() => Promise<number[]>>(),
    fetchItems: vi.fn<(ids: number[]) => Promise<ItemSlot[]>>(),
  };

  const feed500 = Array.from({ length: 500 }, (_, i) => i + 1);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHnService).mockReturnValue(mockService as any);
    mockService.fetchFeed.mockResolvedValue(feed500);
    mockService.fetchItems.mockImplementation(async (ids) =>
      slotsOf(ids.map((id) => makeItem({ id }))),
    );
  });

  function call(input: Record<string, unknown>): Promise<ToolResult> {
    return runToolContract(getStories, input as never, {
      context: { errors: getStories.errors },
    });
  }

  it('keeps truncated/shown/cap while more stories remain', async () => {
    const sc = structured(await call({ feed: 'top', count: 30, offset: 0 }));
    expect(sc).toMatchObject({ hasMore: true, truncated: true, shown: 30, cap: 30 });
  });

  it('names the next offset and the count ceiling instead of the framework default', async () => {
    const result = await call({ feed: 'top', count: 30, offset: 30 });
    const notice = structured(result).notice as string;

    expect(notice).toBe(
      'Showing items 31–60 of 500 in the top feed. Pass offset: 60 for the next page, or raise count (max 100).',
    );
    expect(notice).not.toContain('narrow with filters');
    expect(contentText(result)).toContain(notice);
  });

  it('drops the raise-count suggestion when count is already at its max', async () => {
    const notice = structured(await call({ feed: 'top', count: 100, offset: 0 })).notice;
    expect(notice).toBe(
      'Showing items 1–100 of 500 in the top feed. Pass offset: 100 for the next page.',
    );
  });

  it('reports the last page as terminal — no truncated, shown, cap, or notice', async () => {
    const result = await call({ feed: 'top', count: 3, offset: 497 });
    const sc = structured(result);

    expect(sc.hasMore).toBe(false);
    expect(sc.stories).toHaveLength(3);
    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('shown');
    expect(sc).not.toHaveProperty('cap');
    expect(sc).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('capped');
  });

  it('reports a page that exactly consumes a short feed as terminal', async () => {
    mockService.fetchFeed.mockResolvedValue([1, 2, 3]);
    const sc = structured(await call({ feed: 'jobs', count: 3, offset: 0 }));

    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('notice');
  });

  it('names the next offset on an all-dead page that still has stories behind it', async () => {
    mockService.fetchItems.mockImplementation(async (ids) =>
      slotsOf(ids.map((id) => makeItem({ id, dead: true }))),
    );

    const result = await call({ feed: 'new', count: 5, offset: 10 });
    const sc = structured(result);
    const notice = sc.notice as string;

    expect(sc).toMatchObject({ truncated: true, shown: 0, cap: 5 });
    expect(notice).toContain('No live stories on this page');
    expect(notice).toContain('Pass offset: 15 for the next page');
    expect(contentText(result)).toContain(notice);
  });

  it('keeps the offset-past-end notice without truncation', async () => {
    const sc = structured(await call({ feed: 'top', count: 10, offset: 600 }));

    expect(sc).not.toHaveProperty('truncated');
    expect(sc.notice).toMatch(/past the end/);
  });

  it('describes truncated as more stories remaining, and notice as covering pagination', () => {
    const enrichment = getStories.enrichment as Record<string, { description?: string }>;
    expect(enrichment.truncated!.description).toMatch(/more stories remain/i);
    expect(enrichment.notice!.description).not.toMatch(/Absent on non-empty result pages/);
  });
});

// ---------------------------------------------------------------------------
// Partial item failures — the real HnService against a stubbed HN API
// ---------------------------------------------------------------------------

describe('getStories — partial item failures', () => {
  const story = (id: number, extra: Partial<HnItem> = {}): HnItem => ({
    id,
    type: 'story',
    title: `Story ${id}`,
    by: 'author',
    score: 10,
    ...extra,
  });

  /** A feed of `ids` whose items all load, with `overrides` replacing individual item routes. */
  function feed(ids: number[], overrides: Record<number, unknown> = {}) {
    return stubHnApi({
      '/topstories.json': ids,
      ...Object.fromEntries(ids.map((id) => [`/item/${id}.json`, overrides[id] ?? story(id)])),
    });
  }

  /** Run the tool, letting fake timers drive any retry backoff to completion. */
  async function call(input: Record<string, unknown>): Promise<ToolResult> {
    const pending = runToolContract(getStories, input as never, {
      context: { errors: getStories.errors },
    });
    await vi.advanceTimersByTimeAsync(120_000);
    return pending;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(getHnService).mockReturnValue(new HnService(3));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('names a failed item on both surfaces instead of returning a silently shorter page', async () => {
    feed([101, 102, 103], { 102: httpStatus(500) });

    const result = await call({ feed: 'top', count: 3 });
    const sc = structured(result);
    const notice = sc.notice as string;

    expect((sc.stories as Array<{ id: number }>).map((s) => s.id)).toEqual([101, 103]);
    expect(sc.failedIds).toEqual([102]);
    expect(notice).toBe(
      'Could not fetch 1 of 3 items on this page (id 102). Retry with offset: 0, or pass an id as itemId to hn_get_thread to fetch that story alone.',
    );
    expect(notice).not.toMatch(/deleted or flagged/);

    const text = contentText(result);
    expect(text).toContain('id:101');
    expect(text).toContain('id:103');
    expect(text).toContain(notice);
    expect(text).toContain('**Failed to load:** 102');
  });

  it('lists every failed id and keeps the next-page guidance while more stories remain', async () => {
    feed([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { 4: httpStatus(503), 6: httpStatus(503) });

    const sc = structured(await call({ feed: 'top', count: 3, offset: 3 }));

    expect(sc).toMatchObject({
      truncated: true,
      shown: 1,
      cap: 3,
      hasMore: true,
      failedIds: [4, 6],
    });
    expect(sc.notice).toBe(
      'Showing items 4–6 of 10 in the top feed. Could not fetch 2 of 3 items on this page (ids 4, 6). Retry with offset: 3, or pass an id as itemId to hn_get_thread to fetch that story alone. Pass offset: 6 for the next page, or raise count (max 100).',
    );
  });

  it('does not blame deletion when failures and dead items leave nothing live', async () => {
    feed([101, 102], { 101: httpStatus(500), 102: story(102, { dead: true }) });

    const result = await call({ feed: 'top', count: 2 });
    const sc = structured(result);

    expect(sc.stories).toEqual([]);
    expect(sc.failedIds).toEqual([101]);
    expect(sc.notice).toMatch(/^Could not fetch 1 of 2 items on this page \(id 101\)/);
    expect(sc.notice).not.toMatch(/deleted or flagged/);
    expect(contentText(result)).toContain('**Failed to load:** 101');
  });

  it('throws the classified upstream error when every requested item failed', async () => {
    feed([101, 102, 103], {
      101: httpStatus(500),
      102: httpStatus(500),
      103: httpStatus(500),
    });

    const result = await call({ feed: 'top', count: 3 });
    const error = (
      result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
    ).error;

    expect(result.isError).toBe(true);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 500 });
    expect(contentText(result)).not.toMatch(/deleted or flagged/);
  });

  it('stops at a rate-limited item and surfaces its Retry-After when the whole page fails', async () => {
    const { requested } = feed([101, 102, 103, 104, 105, 106, 107], {
      ...Object.fromEntries(
        [101, 102, 103, 104, 105, 106, 107].map((id) => [
          id,
          httpStatus(429, { 'Retry-After': '120' }),
        ]),
      ),
    });

    const result = await call({ feed: 'top', count: 7 });
    const error = (
      result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
    ).error;

    /** Three workers start three fetches; the rest are reported failed, never requested. */
    expect(requested().filter((p) => p.startsWith('/item/'))).toHaveLength(3);
    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'upstream_rate_limited', retryAfter: '120' });
    expect(contentText(result)).toContain('retry after 120 seconds');
  });

  it('reports the slots a rate limit skipped as failed alongside the stories that loaded', async () => {
    vi.mocked(getHnService).mockReturnValue(new HnService(1));
    const { requested } = feed([1, 2, 3, 4], { 2: httpStatus(429, { 'Retry-After': '120' }) });

    const sc = structured(await call({ feed: 'top', count: 4 }));

    expect(requested()).toEqual(['/topstories.json', '/item/1.json', '/item/2.json']);
    expect((sc.stories as Array<{ id: number }>).map((s) => s.id)).toEqual([1]);
    expect(sc.failedIds).toEqual([2, 3, 4]);
  });

  it('carries no failure field or failure notice when every item loaded', async () => {
    feed([101, 102]);

    const result = await call({ feed: 'top', count: 2 });
    const sc = structured(result);

    expect(sc).not.toHaveProperty('failedIds');
    expect(sc).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('Failed to load');
  });

  it('fetches nothing and reports no failure for an offset past the end', async () => {
    const { requested } = feed([101, 102]);

    const sc = structured(await call({ feed: 'top', count: 5, offset: 9 }));

    expect(requested()).toEqual(['/topstories.json']);
    expect(sc).not.toHaveProperty('failedIds');
    expect(sc.notice).toMatch(/past the end/);
  });
});
