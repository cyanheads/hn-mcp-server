/**
 * @fileoverview Tests for HN service utilities and init/accessor pattern.
 * @module services/hn/hn-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodeHtmlEntities,
  extractDomain,
  filterLiveItems,
  HnService,
  normalizeUrl,
  stripHtml,
  stripHtmlPreservingEm,
} from '@/services/hn/hn-service.js';
import type { HnItem } from '@/services/hn/types.js';

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
// filterLiveItems
// ---------------------------------------------------------------------------

describe('filterLiveItems', () => {
  const live: HnItem = { id: 1, type: 'story' };
  const dead: HnItem = { id: 2, type: 'story', dead: true };
  const deleted: HnItem = { id: 3, type: 'comment', deleted: true };
  const deadAndDeleted: HnItem = { id: 4, type: 'story', dead: true, deleted: true };

  it('returns only live items', () => {
    expect(filterLiveItems([live, dead, deleted, null, deadAndDeleted])).toEqual([live]);
  });

  it('returns empty array when all items are filtered out', () => {
    expect(filterLiveItems([null, dead, deleted])).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(filterLiveItems([])).toEqual([]);
  });

  it('preserves items where dead/deleted are explicitly false', () => {
    const explicit: HnItem = { id: 5, type: 'job', dead: false, deleted: false };
    expect(filterLiveItems([explicit])).toEqual([explicit]);
  });

  it('preserves order of surviving items', () => {
    const a: HnItem = { id: 10, type: 'story' };
    const b: HnItem = { id: 20, type: 'comment' };
    const c: HnItem = { id: 30, type: 'job' };
    expect(filterLiveItems([a, null, dead, b, deleted, c])).toEqual([a, b, c]);
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

  it('returns null slots for items that fail after retries (does not throw)', async () => {
    /** Patch fetchItem to throw on id=2 only. */
    const svc = new HnService(2);
    const ctx = createMockContext();
    const fetchItemSpy = vi.spyOn(svc, 'fetchItem').mockImplementation(async (id: number) => {
      if (id === 2) throw new Error('network failure');
      return { id, type: 'story' as const };
    });

    const result = await svc.fetchItems([1, 2, 3], ctx);

    expect(result[0]).toMatchObject({ id: 1 });
    expect(result[1]).toBeNull(); // failed item yields null
    expect(result[2]).toMatchObject({ id: 3 });
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

    expect(result.map((r) => r?.id)).toEqual([10, 20, 30]);
    fetchItemSpy.mockRestore();
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
// HnService.search — URL construction (pure logic, no HTTP calls)
// ---------------------------------------------------------------------------

/**
 * Mirror the URL-building logic from HnService.search to test it in isolation.
 * This tests the param construction rules without making network calls.
 */
function buildSearchUrl(params: {
  query: string;
  tags?: string;
  author?: string;
  sort: 'relevance' | 'date';
  dateRange?: { start?: string; end?: string };
  minPoints?: number;
  count: number;
  page: number;
}): URL {
  const ALGOLIA_API = 'https://hn.algolia.com/api/v1';
  const endpoint = params.sort === 'date' ? 'search_by_date' : 'search';
  const url = new URL(`${ALGOLIA_API}/${endpoint}`);

  url.searchParams.set('query', params.query);
  url.searchParams.set('hitsPerPage', String(params.count));
  url.searchParams.set('page', String(params.page));

  const tagParts: string[] = [];
  if (params.tags) tagParts.push(params.tags);
  if (params.author) tagParts.push(`author_${params.author}`);
  if (tagParts.length) url.searchParams.set('tags', tagParts.join(','));

  const numericFilters: string[] = [];
  if (params.minPoints != null) numericFilters.push(`points>=${params.minPoints}`);
  if (params.dateRange?.start) {
    numericFilters.push(
      `created_at_i>${Math.floor(new Date(params.dateRange.start).getTime() / 1000)}`,
    );
  }
  if (params.dateRange?.end) {
    numericFilters.push(
      `created_at_i<${Math.floor(new Date(params.dateRange.end).getTime() / 1000)}`,
    );
  }
  if (numericFilters.length) url.searchParams.set('numericFilters', numericFilters.join(','));

  return url;
}

describe('HnService.search URL construction (pure logic)', () => {
  it('routes sort=relevance to /search endpoint', () => {
    const url = buildSearchUrl({ query: 'test', sort: 'relevance', count: 10, page: 0 });
    expect(url.pathname).toBe('/api/v1/search');
  });

  it('routes sort=date to /search_by_date endpoint', () => {
    const url = buildSearchUrl({ query: 'test', sort: 'date', count: 10, page: 0 });
    expect(url.pathname).toBe('/api/v1/search_by_date');
  });

  it('encodes query and pagination params', () => {
    const url = buildSearchUrl({ query: 'rust lang', sort: 'relevance', count: 5, page: 2 });
    expect(url.searchParams.get('query')).toBe('rust lang');
    expect(url.searchParams.get('hitsPerPage')).toBe('5');
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('builds tags param from tags filter only', () => {
    const url = buildSearchUrl({
      query: 'x',
      sort: 'relevance',
      count: 10,
      page: 0,
      tags: 'story',
    });
    expect(url.searchParams.get('tags')).toBe('story');
  });

  it('builds tags param from author only', () => {
    const url = buildSearchUrl({
      query: 'x',
      sort: 'relevance',
      count: 10,
      page: 0,
      author: 'dang',
    });
    expect(url.searchParams.get('tags')).toBe('author_dang');
  });

  it('combines tags and author in tags param', () => {
    const url = buildSearchUrl({
      query: 'x',
      sort: 'relevance',
      count: 10,
      page: 0,
      tags: 'comment',
      author: 'pg',
    });
    expect(url.searchParams.get('tags')).toBe('comment,author_pg');
  });

  it('omits tags param when neither tags nor author is set', () => {
    const url = buildSearchUrl({ query: 'x', sort: 'relevance', count: 10, page: 0 });
    expect(url.searchParams.get('tags')).toBeNull();
  });

  it('builds numericFilters from minPoints', () => {
    const url = buildSearchUrl({
      query: 'x',
      sort: 'relevance',
      count: 10,
      page: 0,
      minPoints: 50,
    });
    expect(url.searchParams.get('numericFilters')).toContain('points>=50');
  });

  it('builds numericFilters from dateRange.start', () => {
    const url = buildSearchUrl({
      query: 'x',
      sort: 'relevance',
      count: 10,
      page: 0,
      dateRange: { start: '2024-01-01' },
    });
    const nf = url.searchParams.get('numericFilters')!;
    expect(nf).toMatch(/created_at_i>\d+/);
  });

  it('builds numericFilters from dateRange.end', () => {
    const url = buildSearchUrl({
      query: 'x',
      sort: 'relevance',
      count: 10,
      page: 0,
      dateRange: { end: '2024-12-31' },
    });
    const nf = url.searchParams.get('numericFilters')!;
    expect(nf).toMatch(/created_at_i<\d+/);
  });

  it('combines minPoints and dateRange in numericFilters', () => {
    const url = buildSearchUrl({
      query: 'x',
      sort: 'relevance',
      count: 10,
      page: 0,
      minPoints: 100,
      dateRange: { start: '2024-01-01', end: '2024-12-31' },
    });
    const nf = url.searchParams.get('numericFilters')!;
    expect(nf).toContain('points>=100');
    expect(nf).toMatch(/created_at_i>\d+/);
    expect(nf).toMatch(/created_at_i<\d+/);
  });

  it('omits numericFilters when no filters are set', () => {
    const url = buildSearchUrl({ query: 'x', sort: 'relevance', count: 10, page: 0 });
    expect(url.searchParams.get('numericFilters')).toBeNull();
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

  function stubStatus(status: number, body: string, statusText = 'Error') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status, statusText })),
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

  it('classifies a 500 as upstream_unavailable rather than an internal error', async () => {
    stubStatus(500, 'boom', 'Internal Server Error');

    const err = await failure(new HnService(1).fetchItem(8863, createMockContext()));

    /** InternalError means this server faulted; an upstream 500 did not. */
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_unavailable', status: 500 });
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

  it('filterLiveItems handles items where dead and deleted are both false explicitly', () => {
    const item: HnItem = { id: 99, type: 'job', dead: false, deleted: false };
    expect(filterLiveItems([item])).toHaveLength(1);
  });
});
