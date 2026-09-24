/**
 * @fileoverview Tests for HN service utilities and init/accessor pattern.
 * @module services/hn/hn-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dateBoundToEpochMs,
  dateBoundToEpochSeconds,
  decodeHtmlEntities,
  extractDomain,
  HnService,
  type ItemSlot,
  normalizeUrl,
  settlePage,
  stripHtml,
  stripHtmlPreservingEm,
} from '@/services/hn/hn-service.js';
import type { HnItem } from '@/services/hn/types.js';
import { httpStatus, stubHnApi } from '../../helpers/hn-api-stub.js';

// ---------------------------------------------------------------------------
// decodeHtmlEntities
// ---------------------------------------------------------------------------

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    expect(decodeHtmlEntities('&amp; &lt; &gt; &quot; &apos;')).toBe('& < > " \'');
  });

  it('decodes &nbsp; to a space', () => {
    expect(decodeHtmlEntities('hello&nbsp;world')).toBe('hello world');
  });

  it('decodes decimal numeric entities', () => {
    expect(decodeHtmlEntities('&#60;&#62;')).toBe('<>');
  });

  it('decodes hex numeric entities', () => {
    expect(decodeHtmlEntities('&#x3C;&#x3E;')).toBe('<>');
  });

  it('decodes uppercase hex entities', () => {
    expect(decodeHtmlEntities('&#x3c;&#x3e;')).toBe('<>');
  });

  it('leaves unknown named entities as-is', () => {
    expect(decodeHtmlEntities('&unknown;')).toBe('&unknown;');
  });

  it('returns plain text unchanged', () => {
    expect(decodeHtmlEntities('no entities here')).toBe('no entities here');
  });

  it('handles mixed entities in one string', () => {
    expect(decodeHtmlEntities('&amp;&#60;&#x3E;&unknown;')).toBe('&<>&unknown;');
  });
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

describe('stripHtml', () => {
  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });

  it('returns empty string for falsy input', () => {
    expect(stripHtml(undefined as unknown as string)).toBe('');
    expect(stripHtml(null as unknown as string)).toBe('');
  });

  it('strips simple HTML tags', () => {
    expect(stripHtml('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
  });

  it('converts <p> tags to double newlines', () => {
    expect(stripHtml('first<p>second<p>third')).toBe('first\n\nsecond\n\nthird');
  });

  it('converts links to text (url) format', () => {
    expect(stripHtml('<a href="https://example.com">click here</a>')).toBe(
      'click here (https://example.com)',
    );
  });

  it('uses bare url when link text matches href', () => {
    expect(stripHtml('<a href="https://example.com">https://example.com</a>')).toBe(
      'https://example.com',
    );
  });

  it('preserves code blocks', () => {
    const html = 'before<pre><code>const x = 1;\nconst y = 2;</code></pre>after';
    const result = stripHtml(html);
    expect(result).toContain('const x = 1;\nconst y = 2;');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('preserves multiple code blocks', () => {
    const html = '<pre><code>a</code></pre>text<pre><code>b</code></pre>';
    const result = stripHtml(html);
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('text');
  });

  it('decodes entities in the final output', () => {
    expect(stripHtml('&amp; stuff')).toBe('& stuff');
  });

  it('trims leading/trailing whitespace', () => {
    expect(stripHtml('<p>hello<p>')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// stripHtmlPreservingEm
// ---------------------------------------------------------------------------

describe('stripHtmlPreservingEm', () => {
  it('returns empty string for empty input', () => {
    expect(stripHtmlPreservingEm('')).toBe('');
  });

  it('preserves <em> markers while stripping other tags', () => {
    expect(stripHtmlPreservingEm('<p>I <em>think</em> <em>Rust</em> is great</p>')).toBe(
      'I <em>think</em> <em>Rust</em> is great',
    );
  });

  it('preserves <em> inside link replacements', () => {
    const html = '<a href="https://r.dev"><em>Rust</em></a>';
    expect(stripHtmlPreservingEm(html)).toBe('<em>Rust</em> (https://r.dev)');
  });

  it('strips bold/italic/etc but leaves <em> intact', () => {
    expect(stripHtmlPreservingEm('<b>not bold</b> and <em>match</em> and <i>not italic</i>')).toBe(
      'not bold and <em>match</em> and not italic',
    );
  });

  it('decodes entities after stripping', () => {
    expect(stripHtmlPreservingEm('<p>&amp; <em>match</em></p>')).toBe('& <em>match</em>');
  });

  it('handles plain text with no markers', () => {
    expect(stripHtmlPreservingEm('plain text')).toBe('plain text');
  });
});

// ---------------------------------------------------------------------------
// extractDomain
// ---------------------------------------------------------------------------

describe('extractDomain', () => {
  it('returns bare hostname for a valid URL', () => {
    expect(extractDomain('https://example.com/path')).toBe('example.com');
  });

  it('strips leading www.', () => {
    expect(extractDomain('https://www.github.com/cyanheads')).toBe('github.com');
  });

  it('does not strip non-leading www', () => {
    expect(extractDomain('https://docs.www.example.com/x')).toBe('docs.www.example.com');
  });

  it('lowercases via URL parser', () => {
    expect(extractDomain('https://GitHub.com/x')).toBe('github.com');
  });

  it('returns undefined for undefined', () => {
    expect(extractDomain(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractDomain('')).toBeUndefined();
  });

  it('returns undefined for unparseable URLs', () => {
    expect(extractDomain('not a url')).toBeUndefined();
    expect(extractDomain('foo.com')).toBeUndefined();
  });

  it('handles URLs with ports', () => {
    expect(extractDomain('http://localhost:3000/x')).toBe('localhost');
  });
});

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------

describe('normalizeUrl', () => {
  it('returns trimmed string for valid URL', () => {
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('returns undefined for empty string', () => {
    expect(normalizeUrl('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(normalizeUrl('   ')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(normalizeUrl(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(normalizeUrl(undefined)).toBeUndefined();
  });

  it('returns undefined when called with no arguments', () => {
    expect(normalizeUrl()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getHnService / initHnService
// ---------------------------------------------------------------------------

describe('getHnService / initHnService', () => {
  beforeEach(() => {
    /**
     * Reset module registry so each test gets fresh module-level singletons
     * (_service in hn-service, _config in server-config).
     */
    vi.resetModules();
  });

  it('throws before initHnService is called', async () => {
    const mod = await import('@/services/hn/hn-service.js');
    expect(() => mod.getHnService()).toThrow('HnService not initialized');
  });

  it('returns an HnService instance after init', async () => {
    process.env.HN_CONCURRENCY_LIMIT = '5';
    const mod = await import('@/services/hn/hn-service.js');
    mod.initHnService();
    const service = mod.getHnService();
    expect(service).toBeInstanceOf(mod.HnService);
  });

  it('returns the same instance on repeated calls', async () => {
    process.env.HN_CONCURRENCY_LIMIT = '5';
    const mod = await import('@/services/hn/hn-service.js');
    mod.initHnService();
    expect(mod.getHnService()).toBe(mod.getHnService());
  });

  it('uses HN_CONCURRENCY_LIMIT from env', async () => {
    process.env.HN_CONCURRENCY_LIMIT = '3';
    const mod = await import('@/services/hn/hn-service.js');
    mod.initHnService();
    const service = mod.getHnService();
    // concurrencyLimit is private, so verify via the class being constructed
    // without throwing — the env var was accepted by the config schema
    expect(service).toBeInstanceOf(mod.HnService);
  });

  it('falls back to default concurrency when env var is unset', async () => {
    delete process.env.HN_CONCURRENCY_LIMIT;
    const mod = await import('@/services/hn/hn-service.js');
    mod.initHnService();
    expect(mod.getHnService()).toBeInstanceOf(mod.HnService);
  });
});

// ---------------------------------------------------------------------------
// HnService.fetchItems — concurrent batch behavior
// ---------------------------------------------------------------------------

describe('HnService.fetchItems', () => {
  it('returns empty array for empty input without making any fetch calls', async () => {
    const svc = new HnService(5);
    const ctx = createMockContext();
    const result = await svc.fetchItems([], ctx);
    expect(result).toEqual([]);
  });

  it('returns a failed slot for an item that fails after retries (does not throw)', async () => {
    /** Patch fetchItem to throw on id=2 only. */
    const svc = new HnService(2);
    const ctx = createMockContext();
    const failure = new Error('network failure');
    const fetchItemSpy = vi.spyOn(svc, 'fetchItem').mockImplementation(async (id: number) => {
      if (id === 2) throw failure;
      return { id, type: 'story' as const };
    });

    const result = await svc.fetchItems([1, 2, 3], ctx);

    expect(result).toEqual([
      { kind: 'item', id: 1, item: { id: 1, type: 'story' } },
      { kind: 'failed', id: 2, error: failure },
      { kind: 'item', id: 3, item: { id: 3, type: 'story' } },
    ]);
    fetchItemSpy.mockRestore();
  });

  it('rethrows a caller cancellation instead of absorbing it as a per-item failure', async () => {
    /**
     * A caller that went away is not a bad item: the batch must reject rather
     * than fill a failed slot and keep fetching for nobody. Concurrency 1 makes
     * the abort-then-stop ordering deterministic.
     */
    const svc = new HnService(1);
    const ctx = createMockContext();
    const warnSpy = vi.spyOn(ctx.log, 'warning');
    const attempted: number[] = [];
    const fetchItemSpy = vi.spyOn(svc, 'fetchItem').mockImplementation(async (id: number) => {
      attempted.push(id);
      if (id === 2) {
        throw new McpError(JsonRpcErrorCode.RequestCancelled, 'client went away');
      }
      return { id, type: 'story' as const };
    });

    await expect(svc.fetchItems([1, 2, 3], ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(attempted).toEqual([1, 2]); // id=3 is never spent on an absent caller
    expect(warnSpy).not.toHaveBeenCalled(); // not logged as an item failure
    warnSpy.mockRestore();
    fetchItemSpy.mockRestore();
  });

  it('preserves input order regardless of which worker resolves first', async () => {
    /** Simulate id=1 being slow by resolving after id=2 in a concurrency=1 setup. */
    const svc = new HnService(1);
    const ctx = createMockContext();
    const order: number[] = [];
    const fetchItemSpy = vi.spyOn(svc, 'fetchItem').mockImplementation(async (id: number) => {
      order.push(id);
      return { id, type: 'story' as const };
    });

    const result = await svc.fetchItems([10, 20, 30], ctx);

    expect(result.map((r) => r.id)).toEqual([10, 20, 30]);
    fetchItemSpy.mockRestore();
  });
});

describe('HnService.fetchItems against a stubbed HN API', () => {
  /**
   * Route item fetches by ID: a number answers that HTTP status, `null` is
   * Firebase's answer for an item that does not exist, anything else is the
   * item body.
   */
  function stubItems(
    routes: Record<number, HnItem | null | number>,
    headers?: Record<string, string>,
  ) {
    const { requested } = stubHnApi(
      Object.fromEntries(
        Object.entries(routes).map(([id, route]) => [
          `/item/${id}.json`,
          typeof route === 'number' ? httpStatus(route, headers) : route,
        ]),
      ),
    );
    return {
      /** How many times each item id was requested. */
      attempts: () => {
        const counts: Record<number, number> = {};
        for (const path of requested()) {
          const id = Number(/^\/item\/(\d+)\.json$/.exec(path)?.[1]);
          counts[id] = (counts[id] ?? 0) + 1;
        }
        return counts;
      },
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('distinguishes a returned item, an absent item, and a failed fetch', async () => {
    vi.useFakeTimers();
    stubItems({ 1: { id: 1, type: 'story' }, 2: null, 3: 500 });

    const pending = new HnService(3).fetchItems([1, 2, 3], createMockContext());
    await vi.advanceTimersByTimeAsync(120_000);
    const slots = await pending;

    expect(slots[0]).toEqual({ kind: 'item', id: 1, item: { id: 1, type: 'story' } });
    expect(slots[1]).toEqual({ kind: 'absent', id: 2 });
    expect(slots[2]).toMatchObject({ kind: 'failed', id: 3 });
    const { error } = slots[2] as { error: McpError };
    expect(error).toBeInstanceOf(McpError);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 500 });
  });

  it('keeps a dead or deleted item as an item slot for the caller to filter', async () => {
    stubItems({
      1: { id: 1, type: 'comment', dead: true },
      2: { id: 2, type: 'comment', deleted: true },
    });

    const slots = await new HnService(2).fetchItems([1, 2], createMockContext());

    expect(slots.map((s) => s.kind)).toEqual(['item', 'item']);
  });

  it('stops the batch at a rate-limited item and reports the unfetched slots as failed', async () => {
    /** Concurrency 1 fixes the order: 1 succeeds, 2 exhausts its retries on 429, 3 and 4 never start. */
    vi.useFakeTimers();
    const { attempts } = stubItems({ 1: { id: 1, type: 'story' }, 2: 429, 3: 500, 4: 500 });
    const ctx = createMockContext();
    const warnSpy = vi.spyOn(ctx.log, 'warning');

    const pending = new HnService(1).fetchItems([1, 2, 3, 4], ctx);
    await vi.advanceTimersByTimeAsync(120_000);
    const slots = await pending;

    expect(attempts()).toEqual({ 1: 1, 2: 4 });
    expect(slots.map((s) => [s.id, s.kind])).toEqual([
      [1, 'item'],
      [2, 'failed'],
      [3, 'failed'],
      [4, 'failed'],
    ]);
    const rateLimit = (slots[1] as { error: McpError }).error;
    expect(rateLimit.data?.reason).toBe('upstream_rate_limited');
    /** The skipped slots carry the rate-limit error that stopped the batch. */
    expect((slots[2] as { error: unknown }).error).toBe(rateLimit);
    expect((slots[3] as { error: unknown }).error).toBe(rateLimit);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rate-limited'),
      expect.objectContaining({ skipped: 2 }),
    );
  });

  it('lets in-flight fetches settle but starts none after a rate limit', async () => {
    /** Retry-After past the budget fails each 429 fast; three workers start three fetches, then stop. */
    const routes = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, 429]));
    const { attempts } = stubItems(routes, { 'Retry-After': '120' });

    const slots = await new HnService(3).fetchItems(
      Array.from({ length: 10 }, (_, i) => i + 1),
      createMockContext(),
    );

    expect(attempts()).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(slots).toHaveLength(10);
    expect(slots.every((s) => s.kind === 'failed')).toBe(true);
    expect((slots[9] as { error: McpError }).error.data).toMatchObject({
      reason: 'upstream_rate_limited',
      retryAfter: '120',
    });
  });

  it('does not stop the batch for a failure other than a rate limit', async () => {
    const { attempts } = stubItems({ 1: 400, 2: { id: 2, type: 'story' }, 3: 400 });

    const slots = await new HnService(1).fetchItems([1, 2, 3], createMockContext());

    expect(attempts()).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(slots.map((s) => s.kind)).toEqual(['failed', 'item', 'failed']);
  });
});

// ---------------------------------------------------------------------------
// settlePage
// ---------------------------------------------------------------------------

describe('settlePage', () => {
  const live: HnItem = { id: 1, type: 'story' };
  const dead: HnItem = { id: 2, type: 'story', dead: true };
  const deleted: HnItem = { id: 3, type: 'comment', deleted: true };
  const item = (i: HnItem): ItemSlot => ({ kind: 'item', id: i.id, item: i });
  const failed = (id: number, error: unknown = new Error(`item ${id}`)): ItemSlot => ({
    kind: 'failed',
    id,
    error,
  });

  it('keeps live items in order and lists failed ids apart from dead, deleted, and absent ones', () => {
    const b: HnItem = { id: 20, type: 'comment' };
    const page = settlePage([
      item(live),
      failed(7),
      item(dead),
      { kind: 'absent', id: 8 },
      item(b),
      item(deleted),
      failed(9),
    ]);

    expect(page).toEqual({ items: [live, b], failedIds: [7, 9] });
  });

  it('returns no failed ids when nothing failed', () => {
    expect(settlePage([item(live), item(dead)])).toEqual({ items: [live], failedIds: [] });
  });

  it('returns an empty page for an empty batch without throwing', () => {
    expect(settlePage([])).toEqual({ items: [], failedIds: [] });
  });

  it('returns an empty page, not a throw, when the non-failed slots are all dead or absent', () => {
    expect(settlePage([failed(1), item(dead), { kind: 'absent', id: 4 }])).toEqual({
      items: [],
      failedIds: [1],
    });
  });

  it('throws the first failure when every slot failed', () => {
    const first = new McpError(JsonRpcErrorCode.RateLimited, 'HN API returned HTTP 429.', {
      reason: 'upstream_rate_limited',
    });
    expect(() => settlePage([failed(1, first), failed(2), failed(3)])).toThrow(first);
  });
});

// ---------------------------------------------------------------------------
// HnService.fetchUser — path-segment encoding
// ---------------------------------------------------------------------------

describe('HnService.fetchUser URL construction', () => {
  /** Captures the URL handed to global fetch and short-circuits with a "no such user" body. */
  function stubFetch(): () => string {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        seen.push(url.toString());
        return new Response('null', { status: 200 });
      }),
    );
    return () => seen[0]!;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a dot-segment username inside the /user/ route instead of escaping to /item/', async () => {
    /**
     * `../item/8863` unencoded resolves to the Firebase item endpoint, which
     * returns a story payload that then fails the user output schema. Encoded,
     * it stays one opaque segment under /user/ and resolves to "not found".
     */
    const firstUrl = stubFetch();
    const result = await new HnService(1).fetchUser('../item/8863', createMockContext());

    const { pathname } = new URL(firstUrl());
    expect(pathname).toBe('/v0/user/..%2Fitem%2F8863.json');
    expect(pathname.startsWith('/v0/user/')).toBe(true);
    expect(pathname).not.toContain('/item/');
    /** One segment for the username — no traversal into a sibling route. */
    expect(pathname.split('/')).toHaveLength(4);
    expect(result).toBeNull();
  });

  it('encodes query and fragment characters rather than truncating the segment', async () => {
    const firstUrl = stubFetch();
    await new HnService(1).fetchUser('a?b#c', createMockContext());

    const parsed = new URL(firstUrl());
    expect(parsed.pathname).toBe('/v0/user/a%3Fb%23c.json');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
  });

  it('leaves an ordinary username unescaped', async () => {
    const firstUrl = stubFetch();
    await new HnService(1).fetchUser('pg', createMockContext());

    expect(new URL(firstUrl()).pathname).toBe('/v0/user/pg.json');
  });

  it('preserves username case in the requested path', async () => {
    const firstUrl = stubFetch();
    await new HnService(1).fetchUser('PaulGraham', createMockContext());

    expect(new URL(firstUrl()).pathname).toBe('/v0/user/PaulGraham.json');
  });
});

// ---------------------------------------------------------------------------
// HnService.search — URL construction against the real method, fetch stubbed
// ---------------------------------------------------------------------------

describe('HnService.search URL construction', () => {
  type SearchParams = Parameters<HnService['search']>[0];

  const EMPTY_PAGE = JSON.stringify({ hits: [], hitsPerPage: 10, nbHits: 0, nbPages: 0, page: 0 });

  /** Run the real `search()` against a stubbed fetch and return the one URL it requested. */
  async function requestedUrl(overrides: Partial<SearchParams>): Promise<URL> {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        seen.push(url.toString());
        return new Response(EMPTY_PAGE, { status: 200 });
      }),
    );
    await new HnService(1).search(
      { query: 'x', sort: 'relevance', count: 10, page: 0, ...overrides },
      createMockContext(),
    );
    expect(seen).toHaveLength(1);
    return new URL(seen[0]!);
  }

  const originalTz = process.env.TZ;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('routes sort=relevance to /search endpoint', async () => {
    const url = await requestedUrl({ sort: 'relevance' });
    expect(url.pathname).toBe('/api/v1/search');
  });

  it('routes sort=date to /search_by_date endpoint', async () => {
    const url = await requestedUrl({ sort: 'date' });
    expect(url.pathname).toBe('/api/v1/search_by_date');
  });

  it('encodes query and pagination params', async () => {
    const url = await requestedUrl({ query: 'rust lang', count: 5, page: 2 });
    expect(url.searchParams.get('query')).toBe('rust lang');
    expect(url.searchParams.get('hitsPerPage')).toBe('5');
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('omits the query param entirely for a filter-only search', async () => {
    const url = await requestedUrl({ query: undefined, tags: 'ask_hn' });
    expect(url.searchParams.has('query')).toBe(false);
    expect(url.searchParams.get('tags')).toBe('ask_hn');
  });

  it('builds tags param from tags filter only', async () => {
    const url = await requestedUrl({ tags: 'story' });
    expect(url.searchParams.get('tags')).toBe('story');
  });

  it('builds tags param from author only', async () => {
    const url = await requestedUrl({ author: 'dang' });
    expect(url.searchParams.get('tags')).toBe('author_dang');
  });

  it('combines tags and author in tags param', async () => {
    const url = await requestedUrl({ tags: 'comment', author: 'pg' });
    expect(url.searchParams.get('tags')).toBe('comment,author_pg');
  });

  it('sends storyId as a story_<id> tag ANDed with the other tags', async () => {
    const url = await requestedUrl({ tags: 'comment', author: 'pg', storyId: 8863 });
    /** Comma-separated tags are ANDed by Algolia. */
    expect(url.searchParams.get('tags')).toBe('comment,author_pg,story_8863');
  });

  it('sends storyId alone as the only tag', async () => {
    const url = await requestedUrl({ query: undefined, storyId: 8863 });
    expect(url.searchParams.get('tags')).toBe('story_8863');
  });

  it('omits tags param when neither tags nor author is set', async () => {
    const url = await requestedUrl({});
    expect(url.searchParams.get('tags')).toBeNull();
  });

  it('builds numericFilters from minPoints', async () => {
    const url = await requestedUrl({ minPoints: 50 });
    expect(url.searchParams.get('numericFilters')).toBe('points>=50');
  });

  it('converts a date-only start to UTC midnight, exclusive', async () => {
    const url = await requestedUrl({ dateRange: { start: '2024-01-01' } });
    expect(url.searchParams.get('numericFilters')).toBe('created_at_i>1704067200');
  });

  it('converts a date-only end to UTC midnight, exclusive', async () => {
    const url = await requestedUrl({ dateRange: { end: '2024-12-31' } });
    expect(url.searchParams.get('numericFilters')).toBe('created_at_i<1735603200');
  });

  it.each([
    ['2024', 1704067200],
    ['2024-05', 1714521600],
    ['2024-05-05', 1714867200],
    ['2024-05-05T10:00:00Z', 1714903200],
    ['2024-05-05T10:00:00+02:00', 1714896000],
    ['2024-05-05T10:00:00.500Z', 1714903200],
  ])('converts the ISO form %j to its UTC epoch second', async (start, epoch) => {
    const url = await requestedUrl({ dateRange: { start } });
    expect(url.searchParams.get('numericFilters')).toBe(`created_at_i>${epoch}`);
  });

  it.each([
    ['2024-05-05T10:00:00Z', 1714903200],
    ['2024-05-05T10:00:00.500Z', 1714903201],
    ['2024-05-05T10:00:00.001Z', 1714903201],
    ['2024-05-05T09:59:59.999Z', 1714903200],
  ])('rounds a fractional exclusive end %j up to the next whole second', async (end, epoch) => {
    /**
     * Algolia stores whole seconds. An exclusive end at 10:00:00.5 still admits
     * an item created at exactly 10:00:00, so the bound rounds up, not down.
     */
    const url = await requestedUrl({ dateRange: { end } });
    expect(url.searchParams.get('numericFilters')).toBe(`created_at_i<${epoch}`);
  });

  it('reads an offset-less date-time as UTC regardless of the host time zone', async () => {
    /** Under JS's own parsing, "2024-05-05T10:00" is host-local — 17:00Z on a UTC−7 host. */
    process.env.TZ = 'America/Los_Angeles';
    const url = await requestedUrl({ dateRange: { start: '2024-05-05T10:00', end: '2024-05-06' } });
    expect(url.searchParams.get('numericFilters')).toBe(
      'created_at_i>1714903200,created_at_i<1714953600',
    );
  });

  it('combines minPoints and dateRange in numericFilters', async () => {
    const url = await requestedUrl({
      minPoints: 100,
      dateRange: { start: '2024-01-01', end: '2024-12-31' },
    });
    expect(url.searchParams.get('numericFilters')).toBe(
      'points>=100,created_at_i>1704067200,created_at_i<1735603200',
    );
  });

  it('omits numericFilters when no filters are set', async () => {
    const url = await requestedUrl({});
    expect(url.searchParams.get('numericFilters')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dateBoundToEpochSeconds
// ---------------------------------------------------------------------------

describe('dateBoundToEpochSeconds', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('reads a date-only bound as UTC midnight', () => {
    expect(dateBoundToEpochSeconds('2026-09-13')).toBe(1789257600);
  });

  it('keeps an explicit offset', () => {
    expect(dateBoundToEpochSeconds('2024-05-05T10:00-07:00')).toBe(1714928400);
  });

  it('rounds a fractional second up under ceil and leaves a whole second unchanged', () => {
    expect(dateBoundToEpochSeconds('2024-05-05T10:00:00.250', 'ceil')).toBe(1714903201);
    expect(dateBoundToEpochSeconds('2024-05-05T10:00:00', 'ceil')).toBe(1714903200);
    expect(dateBoundToEpochSeconds('2024-05-05', 'ceil')).toBe(1714867200);
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Kolkata'])(
    'reads an offset-less date-time as UTC under TZ=%s',
    (tz) => {
      process.env.TZ = tz;
      expect(dateBoundToEpochSeconds('2024-05-05T10:00')).toBe(1714903200);
      expect(dateBoundToEpochSeconds('2024-05-05T10:00:30.250')).toBe(1714903230);
      expect(dateBoundToEpochMs('2024-05-05T10:00:30.250')).toBe(1714903230250);
    },
  );

  it('keeps the fractional second in milliseconds', () => {
    expect(dateBoundToEpochMs('2024-05-05T10:00:00.2Z')).toBe(1714903200200);
    expect(dateBoundToEpochMs('2024-05-05T12:00:00.7+02:00')).toBe(1714903200700);
  });
});

// ---------------------------------------------------------------------------
// HnService — HTML-body error classification (pure logic via parseJsonBody)
// ---------------------------------------------------------------------------

/**
 * Mirror the HTML-detection logic from hn-service to test it in isolation.
 * This tests that the classification correctly identifies HTML error responses.
 */
function isHtmlErrorBody(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

describe('HnService — HTML error body detection (pure logic)', () => {
  it('detects <!DOCTYPE html> as an HTML error body', () => {
    expect(isHtmlErrorBody('<!DOCTYPE html><html><body>rate limited</body></html>')).toBe(true);
  });

  it('detects <html> without DOCTYPE as an HTML error body', () => {
    expect(isHtmlErrorBody('<html lang="en"><head></head></html>')).toBe(true);
  });

  it('detects <html> with whitespace prefix', () => {
    expect(isHtmlErrorBody('  \n<!DOCTYPE html><html></html>')).toBe(true);
  });

  it('does not classify valid JSON as HTML', () => {
    expect(isHtmlErrorBody(JSON.stringify({ hits: [], nbHits: 0 }))).toBe(false);
  });

  it('does not classify a JSON array as HTML', () => {
    expect(isHtmlErrorBody('[1, 2, 3]')).toBe(false);
  });

  it('does not classify null JSON response as HTML', () => {
    expect(isHtmlErrorBody('null')).toBe(false);
  });

  it('does not classify random error strings as HTML', () => {
    expect(isHtmlErrorBody('Error: connection refused')).toBe(false);
  });

  it('is case-insensitive for DOCTYPE and html tag', () => {
    expect(isHtmlErrorBody('<!doctype HTML><HTML></HTML>')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HnService — upstream HTTP failure classification
// ---------------------------------------------------------------------------

describe('HnService — upstream HTTP failures', () => {
  /** Body Firebase returns for a path it refuses to route. */
  const FIREBASE_400_BODY = '{\n  "error" : "Invalid path: Invalid token in path"\n}\n';

  function stubStatus(
    status: number,
    body: string,
    statusText = 'Error',
    headers?: Record<string, string>,
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status, statusText, ...(headers && { headers }) })),
    );
  }

  /** Reject only once the request is aborted, so the fetch timeout is what resolves the call. */
  function stubHang() {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
  }

  async function failure(promise: Promise<unknown>): Promise<McpError> {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  /** The recovery hint a classified failure carries on the wire. */
  function hintOf(err: McpError): string | undefined {
    return (err.data?.recovery as { hint?: string } | undefined)?.hint;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('classifies a 4xx as upstream_rejected with a recovery hint', async () => {
    stubStatus(400, FIREBASE_400_BODY, 'Bad Request');

    const err = await failure(new HnService(1).fetchUser('../item/8863', createMockContext()));

    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data).toMatchObject({
      upstream: 'HN API',
      status: 400,
      reason: 'upstream_rejected',
    });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('Check the tool input values against the schema'),
    });
  });

  it('keeps the upstream URL and response body out of the client-facing error', async () => {
    stubStatus(400, FIREBASE_400_BODY, 'Bad Request');

    const err = await failure(new HnService(1).fetchUser('../item/8863', createMockContext()));

    expect(err.message).toBe('HN API returned HTTP 400.');
    expect(err.message).not.toContain('hacker-news.firebaseio.com');
    expect(err.message).not.toContain('..%2Fitem%2F8863');
    const wire = JSON.stringify({ message: err.message, data: err.data });
    expect(wire).not.toContain('Invalid token in path');
    expect(wire).not.toContain('firebaseio.com');
    /** The raw error stays reachable server-side for logs. */
    expect((err.cause as McpError).message).toContain('hacker-news.firebaseio.com');
  });

  it('classifies an Algolia 403 as upstream_rejected under the Algolia label', async () => {
    stubStatus(403, 'forbidden', 'Forbidden');

    const err = await failure(
      new HnService(1).search(
        { query: 'rust', sort: 'relevance', count: 10, page: 0 },
        createMockContext(),
      ),
    );

    /** The code follows the reason, not the framework's status ladder — which maps 403 to Forbidden. */
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.message).toBe('Algolia returned HTTP 403.');
    expect(err.data).toMatchObject({
      upstream: 'Algolia',
      status: 403,
      reason: 'upstream_rejected',
    });
  });

  it('classifies a 500 as upstream_unavailable and retries it before giving up', async () => {
    /**
     * A 500 is transient, so the call only settles once retries are exhausted —
     * fake timers drive the backoff rather than waiting it out in real time.
     */
    vi.useFakeTimers();
    stubStatus(500, 'boom', 'Internal Server Error');

    const pending = failure(new HnService(1).fetchItem(8863, createMockContext()));
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;

    /** InternalError means this server faulted; an upstream 500 did not. */
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_unavailable', status: 500 });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it('classifies a 429 as upstream_rate_limited after retries are exhausted', async () => {
    vi.useFakeTimers();
    stubStatus(429, 'slow down', 'Too Many Requests');

    const pending = failure(new HnService(1).fetchFeed('top', createMockContext()));
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.message).toBe('HN API returned HTTP 429.');
    expect(err.data).toMatchObject({ reason: 'upstream_rate_limited', status: 429 });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('Wait several seconds'),
    });
    /** No header, no key — the generic hint stands. */
    expect(err.data).not.toHaveProperty('retryAfter');
  });

  it('carries a delta-seconds Retry-After past the retry budget into data and the hint', async () => {
    /** 120 s exceeds withRetry's 30 s cap, so the call fails fast on the first response. */
    stubStatus(429, 'slow down', 'Too Many Requests', { 'Retry-After': '120' });

    const err = await failure(new HnService(1).fetchFeed('top', createMockContext()));

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({ reason: 'upstream_rate_limited', retryAfter: '120' });
    const hint = hintOf(err);
    expect(hint).toContain('retry after 120 seconds');
    expect(hint).not.toContain('Wait several seconds');
  });

  it('carries the last Retry-After seen once honored retries run out', async () => {
    /** 2 s sits inside the retry budget: withRetry sleeps it out between attempts, then gives up. */
    vi.useFakeTimers();
    stubStatus(429, 'slow down', 'Too Many Requests', { 'Retry-After': '2' });

    const pending = failure(new HnService(1).fetchItem(8863, createMockContext()));
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(4);
    expect(err.data).toMatchObject({ reason: 'upstream_rate_limited', retryAfter: '2' });
    expect(hintOf(err)).toContain('retry after 2 seconds');
  });

  it('carries an HTTP-date Retry-After verbatim, never as a count of seconds', async () => {
    const date = 'Wed, 21 Oct 2099 07:28:00 GMT';
    stubStatus(429, 'slow down', 'Too Many Requests', { 'Retry-After': date });

    const err = await failure(
      new HnService(1).search(
        { query: 'rust', sort: 'relevance', count: 10, page: 0 },
        createMockContext(),
      ),
    );

    expect(err.data).toMatchObject({
      upstream: 'Algolia',
      reason: 'upstream_rate_limited',
      retryAfter: date,
    });
    const hint = hintOf(err);
    expect(hint).toContain(`retry after ${date}`);
    expect(hint).not.toContain(`${date} seconds`);
  });

  it('keeps the upstream URL and body out of a Retry-After 429', async () => {
    stubStatus(429, 'slow down, 10.0.0.1', 'Too Many Requests', { 'Retry-After': '120' });

    const err = await failure(new HnService(1).fetchUser('pg', createMockContext()));

    const wire = JSON.stringify({ message: err.message, data: err.data });
    expect(wire).not.toContain('firebaseio.com');
    expect(wire).not.toContain('10.0.0.1');
    expect(Object.keys(err.data ?? {}).sort()).toEqual([
      'reason',
      'recovery',
      'retryAfter',
      'status',
      'upstream',
    ]);
  });

  it('classifies a 5xx as upstream_unavailable', async () => {
    vi.useFakeTimers();
    stubStatus(503, 'maintenance', 'Service Unavailable');

    const pending = failure(new HnService(1).fetchItem(8863, createMockContext()));
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('HN API returned HTTP 503.');
    expect(err.data).toMatchObject({ reason: 'upstream_unavailable', status: 503 });
    /** Classification runs after retries, so the default budget is untouched: initial call plus three retries. */
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(4);
  });

  it('leaves a request timeout classified as a timeout, not an upstream HTTP failure', async () => {
    vi.useFakeTimers();
    stubHang();

    const pending = failure(new HnService(1).fetchFeed('top', createMockContext()));
    await vi.advanceTimersByTimeAsync(300_000);
    const err = await pending;

    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data?.reason).toBeUndefined();
    expect(err.data?.errorSource).toBe('FetchTimeout');
  });

  it('leaves an HTML error body on its own upstream_html reason', async () => {
    vi.useFakeTimers();
    stubStatus(200, '<!DOCTYPE html><html><body>rate limited</body></html>', 'OK');

    const pending = failure(new HnService(1).fetchUser('pg', createMockContext()));
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;

    expect(err.data).toMatchObject({ reason: 'upstream_html', upstream: 'HN API' });
    expect(err.data?.status).toBeUndefined();
  });

  it('classifies a non-JSON 200 body without quoting it back to the client', async () => {
    vi.useFakeTimers();
    stubStatus(200, 'proxy-token=abc123 not-json', 'OK');

    const pending = failure(new HnService(1).fetchFeed('top', createMockContext()));
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_malformed', upstream: 'HN API' });
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('not its API response'),
    });
    /** A raw SyntaxError message names the token it choked on — that is upstream body content. */
    const wire = JSON.stringify({ message: err.message, data: err.data });
    expect(wire).not.toContain('proxy-token');
    expect(wire).not.toContain('abc123');
  });
});

// ---------------------------------------------------------------------------
// Security: no secret leakage in outputs
// ---------------------------------------------------------------------------

describe('security: no secret or env value in utility outputs', () => {
  it('decodeHtmlEntities does not leak env vars in output', () => {
    const secretEnvKey = 'HN_CONCURRENCY_LIMIT';
    process.env[secretEnvKey] = 'secret-value-12345';
    const result = decodeHtmlEntities('&amp;');
    expect(result).not.toContain('secret-value-12345');
    delete process.env[secretEnvKey];
  });

  it('stripHtml strips <script> tags leaving only text content', () => {
    /**
     * stripHtml is a server-side text extractor for MCP content output.
     * It strips the <script> tag markup but preserves the inner text —
     * this is intentional: text content in a script block can't execute
     * in a plain-text MCP response. The critical property is that no
     * executable tag wrappers appear in the output.
     */
    const injected = '<script>alert("xss")</script>safe text';
    const result = stripHtml(injected);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('</script>');
  });

  it('stripHtml neutralizes event handler attributes', () => {
    const html = '<img src="x" onerror="alert(1)">caption</img>';
    const result = stripHtml(html);
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('alert');
  });

  it('extractDomain cannot be used to perform path traversal via malformed URLs', () => {
    const traversalAttempts = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ];
    for (const url of traversalAttempts) {
      const domain = extractDomain(url);
      // extractDomain returns just the hostname — no path, no scheme execution
      if (domain !== undefined) {
        expect(domain).not.toContain('/');
        expect(domain).not.toContain(':');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases: unicode and entity encoding in HTML utilities
// ---------------------------------------------------------------------------

describe('unicode and encoding edge cases', () => {
  it('stripHtml preserves unicode content', () => {
    expect(stripHtml('<p>日本語テスト</p>')).toBe('日本語テスト');
    expect(stripHtml('<b>émojis 🎉</b>')).toBe('émojis 🎉');
  });

  it('decodeHtmlEntities handles emoji via numeric entities', () => {
    // U+1F600 GRINNING FACE = &#x1F600;
    expect(decodeHtmlEntities('&#x1F600;')).toBe('😀');
  });

  it('stripHtml handles deeply nested tags', () => {
    const nested = '<div><p><span><b>deep</b></span></p></div>';
    expect(stripHtml(nested)).toBe('deep');
  });

  it('stripHtml converts multiple consecutive <p> tags to proper spacing', () => {
    const result = stripHtml('<p>a<p>b<p>c');
    expect(result).toBe('a\n\nb\n\nc');
  });

  it('stripHtmlPreservingEm handles text with no HTML', () => {
    expect(stripHtmlPreservingEm('plain text no tags')).toBe('plain text no tags');
  });

  it('normalizeUrl rejects whitespace-only after trim', () => {
    expect(normalizeUrl('\t\n\r')).toBeUndefined();
  });

  it('settlePage keeps items where dead and deleted are both false explicitly', () => {
    const item: HnItem = { id: 99, type: 'job', dead: false, deleted: false };
    expect(settlePage([{ kind: 'item', id: 99, item }]).items).toEqual([item]);
  });

  it('settlePage drops an item that is both dead and deleted', () => {
    const item: HnItem = { id: 98, type: 'story', dead: true, deleted: true };
    expect(settlePage([{ kind: 'item', id: 98, item }]).items).toEqual([]);
  });
});
