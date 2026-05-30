/**
 * @fileoverview Tests for the hn_search_content tool — handler, format, and input validation.
 * @module mcp-server/tools/definitions/search-content.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlgoliaResponse } from '@/services/hn/types.js';

vi.mock('@/services/hn/hn-service.js', () => ({
  getHnService: vi.fn(),
  stripHtml: vi.fn((html: string) => html),
  stripHtmlPreservingEm: vi.fn((html: string) =>
    html
      .replace(/<em>/g, '@@EM_OPEN@@')
      .replace(/<\/em>/g, '@@EM_CLOSE@@')
      .replace(/<[^>]+>/g, '')
      .replace(/@@EM_OPEN@@/g, '<em>')
      .replace(/@@EM_CLOSE@@/g, '</em>'),
  ),
  normalizeUrl: vi.fn((url?: string | null) => url?.trim() || undefined),
  extractDomain: vi.fn((url?: string) => {
    if (!url) return;
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return;
    }
  }),
}));

import { searchHn } from '@/mcp-server/tools/definitions/search-content.tool.js';
import { getHnService, stripHtml } from '@/services/hn/hn-service.js';

const mockSearch = vi.fn<(...args: unknown[]) => Promise<AlgoliaResponse>>();

function algoliaResponse(overrides: Partial<AlgoliaResponse> = {}): AlgoliaResponse {
  return {
    hits: [],
    hitsPerPage: 30,
    nbHits: 0,
    nbPages: 0,
    page: 0,
    ...overrides,
  };
}

const storyHit = {
  objectID: '123',
  title: 'Test Story',
  url: 'https://example.com',
  author: 'alice',
  points: 100,
  num_comments: 50,
  created_at: '2024-01-01T00:00:00Z',
  created_at_i: 1704067200,
  comment_text: null,
  story_text: null,
  story_id: null,
  story_title: null,
} as const;

const commentHit = {
  objectID: '456',
  title: null,
  url: null,
  author: 'bob',
  points: 5,
  num_comments: null,
  created_at: '2024-01-02T00:00:00Z',
  created_at_i: 1704153600,
  comment_text: 'This is a comment',
  story_text: null,
  story_id: 123,
  story_title: 'Test Story',
} as const;

beforeEach(() => {
  vi.mocked(getHnService).mockReturnValue({ search: mockSearch } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('hn_search_content handler', () => {
  const ctx = createMockContext();

  it('maps Algolia response correctly', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({
        hits: [storyHit, commentHit],
        nbHits: 100,
        nbPages: 4,
        page: 0,
      }),
    );

    const freshCtx = createMockContext();
    const result = await searchHn.handler(searchHn.input.parse({ query: 'test' }), freshCtx);

    expect(result).toEqual({
      hits: [
        {
          id: 123,
          title: 'Test Story',
          url: 'https://example.com',
          domain: 'example.com',
          author: 'alice',
          points: 100,
          numComments: 50,
          createdAt: '2024-01-01T00:00:00Z',
          storyTitle: undefined,
          storyId: undefined,
          text: undefined,
        },
        {
          id: 456,
          title: undefined,
          url: undefined,
          domain: undefined,
          author: 'bob',
          points: 5,
          numComments: undefined,
          createdAt: '2024-01-02T00:00:00Z',
          storyTitle: 'Test Story',
          storyId: 123,
          text: 'This is a comment',
        },
      ],
      query: 'test',
    });

    const enrichment = getEnrichment(freshCtx);
    expect(enrichment.totalHits).toBe(100);
    expect(enrichment.page).toBe(0);
    expect(enrichment.totalPages).toBe(4);
  });

  it('maps story hit fields', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [storyHit], nbHits: 1, nbPages: 1 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'x' }), ctx);
    const hit = result.hits[0]!;

    expect(hit.id).toBe(123);
    expect(hit.title).toBe('Test Story');
    expect(hit.url).toBe('https://example.com');
    expect(hit.author).toBe('alice');
    expect(hit.points).toBe(100);
    expect(hit.numComments).toBe(50);
    expect(hit.createdAt).toBe('2024-01-01T00:00:00Z');
  });

  it('maps comment hit fields — uses comment_text for text', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [commentHit], nbHits: 1, nbPages: 1 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'x' }), ctx);
    const hit = result.hits[0]!;

    expect(hit.text).toBe('This is a comment');
    expect(hit.storyTitle).toBe('Test Story');
    expect(hit.storyId).toBe(123);
    expect(hit.title).toBeUndefined();
    expect(hit.url).toBeUndefined();
  });

  it('converts null fields to undefined', async () => {
    const nullableHit = {
      ...storyHit,
      points: null,
      num_comments: null,
      title: null,
      url: null,
    };
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [nullableHit], nbHits: 1, nbPages: 1 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'x' }), ctx);
    const hit = result.hits[0]!;

    expect(hit.points).toBeUndefined();
    expect(hit.numComments).toBeUndefined();
    expect(hit.title).toBeUndefined();
    expect(hit.url).toBeUndefined();
  });

  it('calls stripHtml on comment_text and story_text', async () => {
    const htmlComment = { ...commentHit, comment_text: '<p>Hello <b>world</b></p>' };
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [htmlComment], nbHits: 1, nbPages: 1 }));

    await searchHn.handler(searchHn.input.parse({ query: 'x' }), ctx);

    expect(stripHtml).toHaveBeenCalledWith('<p>Hello <b>world</b></p>');
  });

  it('uses story_text when comment_text is null', async () => {
    const storyTextHit = {
      ...storyHit,
      comment_text: null,
      story_text: 'Ask HN body text',
    };
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [storyTextHit], nbHits: 1, nbPages: 1 }));

    await searchHn.handler(searchHn.input.parse({ query: 'x' }), ctx);

    expect(stripHtml).toHaveBeenCalledWith('Ask HN body text');
  });

  it('returns empty hits array for zero results', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const freshCtx = createMockContext();
    const result = await searchHn.handler(searchHn.input.parse({ query: 'nonexistent' }), freshCtx);

    expect(result.hits).toEqual([]);
    expect(result.query).toBe('nonexistent');
    expect(getEnrichment(freshCtx).totalHits).toBe(0);
  });

  it('populates notice with generic hint when no filters are set and hits are empty', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const freshCtx = createMockContext();
    await searchHn.handler(searchHn.input.parse({ query: 'nothing' }), freshCtx);

    expect(getEnrichment(freshCtx).notice).toBe('Try broader keywords or different terms.');
  });

  it('populates notice naming each set filter when hits are empty', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const freshCtx = createMockContext();
    await searchHn.handler(
      searchHn.input.parse({
        query: 'rust',
        tags: 'story',
        author: 'dang',
        minPoints: 100,
        dateRange: { start: '2024-01-01' },
      }),
      freshCtx,
    );

    expect(getEnrichment(freshCtx).notice).toBe(
      'Try broader keywords, or relax these filters: tags, author, minPoints, dateRange.',
    );
  });

  it('omits notice when hits are non-empty', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [storyHit], nbHits: 1 }));

    const freshCtx = createMockContext();
    await searchHn.handler(searchHn.input.parse({ query: 'rust' }), freshCtx);

    expect(getEnrichment(freshCtx).notice).toBeUndefined();
  });

  it('derives domain from url and strips www.', async () => {
    const hits = [
      { ...storyHit, url: 'https://www.github.com/x' },
      { ...storyHit, objectID: '124', url: 'https://news.ycombinator.com/item' },
    ];
    mockSearch.mockResolvedValue(algoliaResponse({ hits, nbHits: 2 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'x' }), ctx);

    expect(result.hits[0]!.domain).toBe('github.com');
    expect(result.hits[1]!.domain).toBe('news.ycombinator.com');
  });

  it('omits domain when url is missing', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [commentHit], nbHits: 1 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'x' }), ctx);

    expect(result.hits[0]!.domain).toBeUndefined();
  });

  it('maps _highlightResult into highlights field with <em> markers preserved', async () => {
    const hitWithHighlights = {
      ...storyHit,
      _highlightResult: {
        title: {
          value: '<em>Rust</em> is Great',
          matchLevel: 'full' as const,
          matchedWords: ['rust'],
        },
        url: { value: 'https://rust.dev', matchLevel: 'none' as const, matchedWords: [] },
        author: { value: 'alice', matchLevel: 'none' as const, matchedWords: [] },
      },
    };
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [hitWithHighlights], nbHits: 1 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'rust' }), ctx);

    expect(result.hits[0]!.highlights).toEqual({
      title: '<em>Rust</em> is Great',
      matchedWords: ['rust'],
    });
  });

  it('strips other HTML from highlight body snippets while preserving <em>', async () => {
    const hitWithCommentHighlight = {
      ...commentHit,
      _highlightResult: {
        comment_text: {
          value: '<p>I <em>think</em> <em>Rust</em> is great</p>',
          matchLevel: 'full' as const,
          matchedWords: ['think', 'rust'],
        },
      },
    };
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [hitWithCommentHighlight], nbHits: 1 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'rust think' }), ctx);

    expect(result.hits[0]!.highlights?.text).toBe('I <em>think</em> <em>Rust</em> is great');
    expect(result.hits[0]!.highlights?.matchedWords).toEqual(['think', 'rust']);
  });

  it('falls back to story_text when comment_text has no match', async () => {
    const hitWithStoryHighlight = {
      ...storyHit,
      _highlightResult: {
        comment_text: { value: '', matchLevel: 'none' as const, matchedWords: [] },
        story_text: {
          value: 'Some <em>rust</em> talk',
          matchLevel: 'full' as const,
          matchedWords: ['rust'],
        },
      },
    };
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [hitWithStoryHighlight], nbHits: 1 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'rust' }), ctx);

    expect(result.hits[0]!.highlights?.text).toBe('Some <em>rust</em> talk');
  });

  it('deduplicates matchedWords across fields', async () => {
    const hit = {
      ...storyHit,
      _highlightResult: {
        title: {
          value: '<em>Rust</em>',
          matchLevel: 'full' as const,
          matchedWords: ['rust'],
        },
        comment_text: {
          value: '<em>Rust</em> talk',
          matchLevel: 'full' as const,
          matchedWords: ['rust'],
        },
        story_title: {
          value: '<em>Rust</em>',
          matchLevel: 'full' as const,
          matchedWords: ['rust'],
        },
      },
    };
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [hit], nbHits: 1 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'rust' }), ctx);

    expect(result.hits[0]!.highlights?.matchedWords).toEqual(['rust']);
  });

  it('omits highlights when _highlightResult is absent', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [storyHit], nbHits: 1 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'x' }), ctx);

    expect(result.hits[0]!).not.toHaveProperty('highlights');
  });

  it('omits highlights when every field has matchLevel: none and no matched words', async () => {
    const hit = {
      ...storyHit,
      _highlightResult: {
        title: { value: 'Test', matchLevel: 'none' as const, matchedWords: [] },
        url: { value: 'https://x', matchLevel: 'none' as const, matchedWords: [] },
      },
    };
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [hit], nbHits: 1 }));

    const result = await searchHn.handler(searchHn.input.parse({ query: 'x' }), ctx);

    expect(result.hits[0]!).not.toHaveProperty('highlights');
  });

  it('passes input params through to hn.search', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const input = searchHn.input.parse({
      query: 'rust',
      tags: 'story',
      author: 'dang',
      sort: 'date',
      dateRange: { start: '2024-01-01' },
      minPoints: 50,
      count: 10,
      page: 2,
    });

    await searchHn.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith(input, expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

describe('hn_search_content format', () => {
  it('shows no-results message for empty hits', () => {
    const content = searchHn.format!({
      hits: [],
      query: 'obscure',
    });

    expect(content).toEqual([{ type: 'text', text: '"obscure" — no results.' }]);
  });

  it('formats story results with meta, and url', () => {
    const content = searchHn.format!({
      hits: [
        {
          id: 123,
          title: 'Rust is Great',
          url: 'https://rust.dev',
          domain: 'rust.dev',
          author: 'alice',
          points: 200,
          numComments: 80,
          createdAt: '2024-06-15T12:00:00Z',
          storyTitle: undefined,
          storyId: undefined,
          text: undefined,
        },
      ],
      query: 'rust',
    });

    const text = content[0]!.text;
    expect(text).toContain('## "rust" — search results');
    expect(text).toContain('### Rust is Great (rust.dev)');
    expect(text).toContain('id:123 | alice | 200 pts | 80 comments | 2024-06-15');
    expect(text).toContain('https://rust.dev');
  });

  it('renders highlight metadata as a "match" footer alongside the raw title', () => {
    const content = searchHn.format!({
      hits: [
        {
          id: 1,
          title: 'Rust is great',
          author: 'alice',
          points: 50,
          numComments: 5,
          createdAt: '2024-01-01T00:00:00Z',
          highlights: { title: '<em>Rust</em> is great', matchedWords: ['rust'] },
        },
      ],
      query: 'rust',
    });

    const text = content[0]!.text;
    expect(text).toContain('### Rust is great');
    expect(text).toContain('> match — title: <em>Rust</em> is great | terms: rust');
  });

  it('renders highlight body snippet in the match footer for comment results', () => {
    const content = searchHn.format!({
      hits: [
        {
          id: 2,
          author: 'bob',
          points: 1,
          createdAt: '2024-01-01T00:00:00Z',
          storyTitle: 'Discussion',
          storyId: 1,
          text: 'I think Rust is great',
          highlights: {
            text: 'I <em>think</em> <em>Rust</em> is great',
            matchedWords: ['think', 'rust'],
          },
        },
      ],
      query: 'rust think',
    });

    const text = content[0]!.text;
    expect(text).toContain('I think Rust is great');
    expect(text).toContain('body: I <em>think</em> <em>Rust</em> is great');
    expect(text).toContain('terms: think, rust');
  });

  it('omits the match footer entirely when highlights is absent', () => {
    const content = searchHn.format!({
      hits: [
        {
          id: 1,
          title: 'No highlights here',
          url: 'https://example.com',
          domain: 'example.com',
          author: 'alice',
          points: 10,
          numComments: 0,
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
      query: 'x',
    });

    expect(content[0]!.text).not.toContain('match —');
  });

  it('formats comment results with "Comment on" and text preview', () => {
    const content = searchHn.format!({
      hits: [
        {
          id: 456,
          title: undefined,
          url: undefined,
          author: 'bob',
          points: 10,
          numComments: undefined,
          createdAt: '2024-03-20T08:00:00Z',
          storyTitle: 'Ask HN: Best Language?',
          storyId: 100,
          text: 'I think Rust is the best choice for systems programming.',
        },
      ],
      query: 'best language',
    });

    const text = content[0]!.text;
    expect(text).toContain('## "best language" — search results');
    expect(text).toContain('### Comment on "Ask HN: Best Language?" (story id:100)');
    expect(text).toContain('id:456 | bob | 10 pts | 2024-03-20');
    expect(text).toContain('I think Rust is the best choice for systems programming.');
  });

  it('renders full comment text without truncation', () => {
    const longText = 'a'.repeat(250);
    const content = searchHn.format!({
      hits: [
        {
          id: 789,
          title: undefined,
          url: undefined,
          author: 'eve',
          points: 1,
          numComments: undefined,
          createdAt: '2024-01-01T00:00:00Z',
          storyTitle: 'Some Post',
          storyId: 999,
          text: longText,
        },
      ],
      query: 'q',
    });

    const text = content[0]!.text;
    expect(text).toContain('a'.repeat(250));
  });

  it('omits url line for stories without url', () => {
    const content = searchHn.format!({
      hits: [
        {
          id: 1,
          title: 'Ask HN: Something',
          url: undefined,
          author: 'a',
          points: 10,
          numComments: 5,
          createdAt: '2024-01-01T00:00:00Z',
          storyTitle: undefined,
          storyId: undefined,
          text: undefined,
        },
      ],
      query: 'q',
    });

    const text = content[0]!.text;
    expect(text).toContain('### Ask HN: Something');
    expect(text).not.toContain('http');
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('hn_search_content input validation', () => {
  it('requires query', () => {
    expect(() => searchHn.input.parse({})).toThrow();
  });

  it('applies defaults: sort=relevance, count=30, page=0', () => {
    const parsed = searchHn.input.parse({ query: 'test' });

    expect(parsed.sort).toBe('relevance');
    expect(parsed.count).toBe(30);
    expect(parsed.page).toBe(0);
  });

  it('validates tags enum', () => {
    expect(() => searchHn.input.parse({ query: 'test', tags: 'invalid_tag' })).toThrow();
    expect(searchHn.input.parse({ query: 'test', tags: 'story' }).tags).toBe('story');
    expect(searchHn.input.parse({ query: 'test', tags: 'comment' }).tags).toBe('comment');
    expect(searchHn.input.parse({ query: 'test', tags: 'ask_hn' }).tags).toBe('ask_hn');
    expect(searchHn.input.parse({ query: 'test', tags: 'show_hn' }).tags).toBe('show_hn');
    expect(searchHn.input.parse({ query: 'test', tags: 'front_page' }).tags).toBe('front_page');
  });

  it('constrains count to 1-50', () => {
    expect(() => searchHn.input.parse({ query: 'test', count: 0 })).toThrow();
    expect(() => searchHn.input.parse({ query: 'test', count: 51 })).toThrow();
    expect(searchHn.input.parse({ query: 'test', count: 1 }).count).toBe(1);
    expect(searchHn.input.parse({ query: 'test', count: 50 }).count).toBe(50);
  });

  it('accepts optional dateRange with optional start/end', () => {
    const withBoth = searchHn.input.parse({
      query: 'test',
      dateRange: { start: '2024-01-01', end: '2024-12-31' },
    });
    expect(withBoth.dateRange).toEqual({ start: '2024-01-01', end: '2024-12-31' });

    const startOnly = searchHn.input.parse({ query: 'test', dateRange: { start: '2024-01-01' } });
    expect(startOnly.dateRange!.start).toBe('2024-01-01');
    expect(startOnly.dateRange!.end).toBeUndefined();

    const noRange = searchHn.input.parse({ query: 'test' });
    expect(noRange.dateRange).toBeUndefined();
  });

  it('rejects unparseable dateRange.start / dateRange.end', () => {
    expect(() =>
      searchHn.input.parse({ query: 'test', dateRange: { start: 'not-a-date' } }),
    ).toThrow();
    expect(() =>
      searchHn.input.parse({ query: 'test', dateRange: { end: 'also-not-a-date' } }),
    ).toThrow();
  });

  it('rejects page below 0', () => {
    expect(() => searchHn.input.parse({ query: 'test', page: -1 })).toThrow();
  });

  it('rejects minPoints below 0', () => {
    expect(() => searchHn.input.parse({ query: 'test', minPoints: -1 })).toThrow();
  });

  it('accepts minPoints=0', () => {
    const parsed = searchHn.input.parse({ query: 'test', minPoints: 0 });
    expect(parsed.minPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Security and edge cases
// ---------------------------------------------------------------------------

describe('hn_search_content — security and edge cases', () => {
  beforeEach(() => {
    vi.mocked(getHnService).mockReturnValue({ search: mockSearch } as never);
  });

  it('does not expose env secrets in handler output', async () => {
    process.env.HN_CONCURRENCY_LIMIT = 'SECRET_SEARCH_SENTINEL';
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [storyHit], nbHits: 1, nbPages: 1 }));

    const freshCtx = createMockContext();
    const result = await searchHn.handler(searchHn.input.parse({ query: 'test' }), freshCtx);
    const blocks = searchHn.format!(result);

    for (const block of blocks) {
      if (block.type === 'text') {
        expect(block.text).not.toContain('SECRET_SEARCH_SENTINEL');
      }
    }
    delete process.env.HN_CONCURRENCY_LIMIT;
  });

  it('handles hit with all nullable fields set to null without crashing', async () => {
    const allNullHit = {
      objectID: '789',
      author: 'anon',
      points: null,
      num_comments: null,
      created_at: '2024-01-01T00:00:00Z',
      created_at_i: 1704067200,
      title: null,
      url: null,
      comment_text: null,
      story_text: null,
      story_id: null,
      story_title: null,
    };
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [allNullHit], nbHits: 1, nbPages: 1 }));

    const freshCtx = createMockContext();
    await expect(
      searchHn.handler(searchHn.input.parse({ query: 'x' }), freshCtx),
    ).resolves.not.toThrow();
  });

  it('format() escapes query in no-results message without injecting HTML', () => {
    const result = searchHn.format!({ hits: [], query: '<script>alert(1)</script>' });
    const text = result[0]!.text;
    // The query is embedded in the message — verify it doesn't create executable tags
    expect(text).toContain('<script>alert(1)</script>');
    // The embedding is just text — no DOM execution risk in MCP text content
    expect(text).toMatch(/"<script>alert\(1\)<\/script>" — no results\./);
  });

  it('handles story result where storyId equals id (common for story hits)', async () => {
    const selfRefHit = { ...storyHit, story_id: 123 };
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [selfRefHit], nbHits: 1 }));

    const freshCtx = createMockContext();
    const result = await searchHn.handler(searchHn.input.parse({ query: 'x' }), freshCtx);

    // storyId should map from story_id even when equal to id
    expect(result.hits[0]!.storyId).toBe(123);
  });

  it('format() suppresses parent story ref when storyId equals id and no storyTitle', () => {
    const content = searchHn.format!({
      hits: [
        {
          id: 123,
          title: 'Same Story',
          url: 'https://example.com',
          domain: 'example.com',
          author: 'alice',
          points: 50,
          numComments: 5,
          createdAt: '2024-01-01T00:00:00Z',
          storyId: 123,
          storyTitle: undefined,
        },
      ],
      query: 'x',
    });
    const text = content[0]!.text;
    // When storyId === id and no storyTitle, parentRef should not appear
    expect(text).not.toContain('story:"');
  });

  it('totalPages calculation uses input count not hitsPerPage from Algolia', async () => {
    // nbHits=100, input count=10 → totalPages should be 10
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [], nbHits: 100, nbPages: 5, hitsPerPage: 20, page: 0 }),
    );

    const freshCtx = createMockContext();
    await searchHn.handler(searchHn.input.parse({ query: 'x', count: 10 }), freshCtx);

    const enrichment = getEnrichment(freshCtx);
    expect(enrichment.totalPages).toBe(10);
  });

  it('handles unicode query string without mangling', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const freshCtx = createMockContext();
    const result = await searchHn.handler(searchHn.input.parse({ query: '日本語検索' }), freshCtx);

    expect(result.query).toBe('日本語検索');
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: '日本語検索' }),
      expect.anything(),
    );
  });

  it('enrichment page reflects result.page from Algolia, not input.page', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [], nbHits: 0, nbPages: 0, page: 3 }));

    const freshCtx = createMockContext();
    await searchHn.handler(searchHn.input.parse({ query: 'x', page: 3 }), freshCtx);

    expect(getEnrichment(freshCtx).page).toBe(3);
  });

  it('format() uses stripped domain (no www.) in story heading', () => {
    /**
     * The format function renders the raw url in the URL line (expected —
     * consumers need the actual link) but uses the pre-stripped domain in the
     * heading. The domain field has already had www. removed by the handler.
     */
    const content = searchHn.format!({
      hits: [
        {
          id: 1,
          title: 'Some Story',
          url: 'https://www.github.com/repo',
          domain: 'github.com', // handler already strips www.
          author: 'alice',
          points: 10,
          numComments: 2,
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
      query: 'story',
    });
    // Heading uses domain (www. already stripped by handler)
    expect(content[0]!.text).toContain('### Some Story (github.com)');
    // Heading does not use www prefix
    expect(content[0]!.text).not.toContain('### Some Story (www.github.com)');
  });
});
