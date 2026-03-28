/**
 * @fileoverview Tests for the hn_search_content tool — handler, format, and input validation.
 * @module mcp-server/tools/definitions/search-content.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlgoliaResponse } from '@/services/hn/types.js';

vi.mock('@/services/hn/hn-service.js', () => ({
  getHnService: vi.fn(),
  stripHtml: vi.fn((html: string) => html),
  normalizeUrl: vi.fn((url?: string | null) => url?.trim() || undefined),
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

    const result = await searchHn.handler(searchHn.input.parse({ query: 'test' }), ctx);

    expect(result).toEqual({
      hits: [
        {
          id: 123,
          title: 'Test Story',
          url: 'https://example.com',
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
          author: 'bob',
          points: 5,
          numComments: undefined,
          createdAt: '2024-01-02T00:00:00Z',
          storyTitle: 'Test Story',
          storyId: 123,
          text: 'This is a comment',
        },
      ],
      totalHits: 100,
      page: 0,
      totalPages: 4,
      query: 'test',
    });
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

    const result = await searchHn.handler(searchHn.input.parse({ query: 'nonexistent' }), ctx);

    expect(result.hits).toEqual([]);
    expect(result.totalHits).toBe(0);
    expect(result.query).toBe('nonexistent');
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

    expect(mockSearch).toHaveBeenCalledWith(input);
  });
});

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

describe('hn_search_content format', () => {
  it('shows no-results message for empty hits', () => {
    const content = searchHn.format!({
      hits: [],
      totalHits: 0,
      page: 0,
      totalPages: 0,
      query: 'obscure',
    });

    expect(content).toEqual([{ type: 'text', text: '"obscure" — no results' }]);
  });

  it('formats story results with rank, meta, and url', () => {
    const content = searchHn.format!({
      hits: [
        {
          id: 123,
          title: 'Rust is Great',
          url: 'https://rust.dev',
          author: 'alice',
          points: 200,
          numComments: 80,
          createdAt: '2024-06-15T12:00:00Z',
          storyTitle: undefined,
          storyId: undefined,
          text: undefined,
        },
      ],
      totalHits: 500,
      page: 0,
      totalPages: 17,
      query: 'rust',
    });

    const text = content[0]!.text;
    expect(text).toContain('## "rust" — 500 results (page 1/17)');
    expect(text).toContain('### Rust is Great');
    expect(text).toContain('id:123 | alice | 200 pts | 80 comments | 2024-06-15');
    expect(text).toContain('https://rust.dev');
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
      totalHits: 42,
      page: 1,
      totalPages: 2,
      query: 'best language',
    });

    const text = content[0]!.text;
    expect(text).toContain('## "best language" — 42 results (page 2/2)');
    expect(text).toContain('### Comment on "Ask HN: Best Language?"');
    expect(text).toContain('id:456 | bob | 10 pts | story id:100 | 2024-03-20');
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
      totalHits: 1,
      page: 0,
      totalPages: 1,
      query: 'q',
    });

    const text = content[0]!.text;
    expect(text).toContain('a'.repeat(250));
  });

  it('header shows correct page info (1-indexed display)', () => {
    const content = searchHn.format!({
      hits: [
        {
          id: 1,
          title: 'X',
          url: undefined,
          author: 'a',
          points: 1,
          numComments: 0,
          createdAt: '2024-01-01T00:00:00Z',
          storyTitle: undefined,
          storyId: undefined,
          text: undefined,
        },
      ],
      totalHits: 300,
      page: 2,
      totalPages: 10,
      query: 'search',
    });

    const text = content[0]!.text;
    expect(text).toContain('"search" — 300 results (page 3/10)');
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
      totalHits: 1,
      page: 0,
      totalPages: 1,
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
});
