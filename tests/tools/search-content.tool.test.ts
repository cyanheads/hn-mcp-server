/**
 * @fileoverview Tests for the hn_search_content tool — handler, format, and input validation.
 * @module mcp-server/tools/definitions/search-content.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext as createFrameworkMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlgoliaResponse } from '@/services/hn/types.js';

vi.mock('@/services/hn/hn-service.js', async (importOriginal) => ({
  dateBoundToEpochSeconds: (await importOriginal<typeof import('@/services/hn/hn-service.js')>())
    .dateBoundToEpochSeconds,
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

function createMockContext() {
  return createFrameworkMockContext({ errors: searchHn.errors });
}

function firstText(blocks: ReturnType<NonNullable<typeof searchHn.format>>): string {
  const block = blocks[0];
  if (block?.type !== 'text') throw new Error('Expected a text content block');
  return block.text;
}

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
  mockSearch.mockReset();
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
    /**
     * nbPages is deliberately far below `Math.ceil(nbHits / count)` (34 vs 3334):
     * Algolia caps the reachable result window well under nbHits for broad
     * queries, so the two numbers must not be interchangeable in this fixture.
     */
    mockSearch.mockResolvedValue(
      algoliaResponse({
        hits: [storyHit, commentHit],
        nbHits: 100_000,
        nbPages: 34,
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
    expect(enrichment.totalHits).toBe(100_000);
    expect(enrichment.page).toBe(0);
    expect(enrichment.totalPages).toBe(34);
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
// Result projection (view)
// ---------------------------------------------------------------------------

describe('hn_search_content view projection', () => {
  const BODY = 'The model context protocol spec is worth reading end to end.';
  const HIGHLIGHTED =
    'The model <em>context</em> <em>protocol</em> spec is worth reading end to end.';

  const longCommentHit = {
    ...commentHit,
    comment_text: BODY,
    _highlightResult: {
      comment_text: {
        value: HIGHLIGHTED,
        matchLevel: 'full' as const,
        matchedWords: ['context', 'protocol'],
      },
      story_title: {
        value: 'Test <em>Story</em>',
        matchLevel: 'full' as const,
        matchedWords: ['story'],
      },
    },
  };

  /** Run the handler, then render content[] from the same result — the two surfaces a client may read. */
  async function run(view: 'full' | 'compact') {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [longCommentHit], nbHits: 1, nbPages: 1 }),
    );
    const result = await searchHn.handler(
      searchHn.input.parse({ query: 'model context protocol', view }),
      createMockContext(),
    );
    const rendered = (searchHn.format!(result)[0] as { text: string }).text;
    return { hit: result.hits[0]!, rendered };
  }

  it('defaults to the full projection', () => {
    expect(searchHn.input.parse({ query: 'x' }).view).toBe('full');
  });

  it('rejects an unknown view value', () => {
    expect(() => searchHn.input.parse({ query: 'x', view: 'brief' })).toThrow();
  });

  it('carries body text and body highlight in both surfaces under view "full"', async () => {
    const { hit, rendered } = await run('full');

    expect(hit.text).toBe(BODY);
    expect(hit.highlights?.text).toBe(HIGHLIGHTED);
    expect(rendered).toContain(BODY);
    expect(rendered).toContain(HIGHLIGHTED);
  });

  it('omits body text and body highlight from both surfaces under view "compact"', async () => {
    const { hit, rendered } = await run('compact');

    expect(hit.text).toBeUndefined();
    expect(hit.highlights?.text).toBeUndefined();
    /** The body must not survive anywhere in content[] — not as text, not as a highlight fragment. */
    expect(rendered).not.toContain('worth reading end to end');
  });

  it('keeps identity, metadata, and matched terms in both surfaces under view "compact"', async () => {
    const { hit, rendered } = await run('compact');

    expect(hit.text).toBeUndefined();
    expect(rendered).not.toContain('worth reading end to end');

    expect(hit).toMatchObject({
      id: 456,
      author: 'bob',
      points: 5,
      createdAt: '2024-01-02T00:00:00Z',
      storyTitle: 'Test Story',
      storyId: 123,
    });
    expect(hit.highlights?.matchedWords).toEqual(['context', 'protocol', 'story']);

    expect(rendered).toContain('id:456');
    expect(rendered).toContain('bob');
    expect(rendered).toContain('5 pts');
    expect(rendered).toContain('Test Story');
    expect(rendered).toContain('terms: context, protocol, story');
  });

  it('keeps the title highlight under view "compact"', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({
        hits: [
          {
            ...storyHit,
            story_text: BODY,
            _highlightResult: {
              title: {
                value: 'Test <em>Story</em>',
                matchLevel: 'full' as const,
                matchedWords: ['story'],
              },
              story_text: {
                value: HIGHLIGHTED,
                matchLevel: 'full' as const,
                matchedWords: ['context'],
              },
            },
          },
        ],
        nbHits: 1,
      }),
    );

    const result = await searchHn.handler(
      searchHn.input.parse({ query: 'story', view: 'compact' }),
      createMockContext(),
    );
    const rendered = (searchHn.format!(result)[0] as { text: string }).text;

    expect(result.hits[0]!.highlights?.title).toBe('Test <em>Story</em>');
    expect(result.hits[0]!.highlights?.text).toBeUndefined();
    expect(result.hits[0]!.text).toBeUndefined();
    expect(rendered).toContain('title: Test <em>Story</em>');
    expect(rendered).not.toContain('worth reading end to end');
  });

  it('drops highlights entirely under view "compact" when only the body matched and no terms were reported', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({
        hits: [
          {
            ...commentHit,
            _highlightResult: {
              comment_text: { value: HIGHLIGHTED, matchLevel: 'full' as const, matchedWords: [] },
            },
          },
        ],
        nbHits: 1,
      }),
    );

    const result = await searchHn.handler(
      searchHn.input.parse({ query: 'x', view: 'compact' }),
      createMockContext(),
    );

    expect(result.hits[0]!).not.toHaveProperty('highlights');
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

    const text = firstText(content);
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

    const text = firstText(content);
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

    const text = firstText(content);
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

    expect(firstText(content)).not.toContain('match —');
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

    const text = firstText(content);
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

    const text = firstText(content);
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

    const text = firstText(content);
    expect(text).toContain('### Ask HN: Something');
    expect(text).not.toContain('http');
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('hn_search_content input validation', () => {
  it('accepts an omitted query at the schema — the handler decides whether a filter is present', () => {
    expect(searchHn.input.parse({}).query).toBeUndefined();
    expect(searchHn.input.parse({ tags: 'ask_hn' })).toMatchObject({ tags: 'ask_hn' });
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

  it.each(['', '   ', '\t\n'])('rejects blank query (%j)', (query) => {
    expect(() => searchHn.input.parse({ query })).toThrow();
  });

  it('trims surrounding whitespace from query', () => {
    expect(searchHn.input.parse({ query: '  rust lang  ' }).query).toBe('rust lang');
  });

  it.each(['', '   '])('rejects blank author (%j)', (author) => {
    expect(() => searchHn.input.parse({ query: 'rust', author })).toThrow();
  });

  it('trims surrounding whitespace from author', () => {
    expect(searchHn.input.parse({ query: 'rust', author: '  dang  ' }).author).toBe('dang');
  });

  it.each([
    ['count', { count: 2.5 }],
    ['page', { page: 1.5 }],
    ['minPoints', { minPoints: 10.5 }],
  ])('rejects fractional %s', (_field, overrides) => {
    expect(() => searchHn.input.parse({ query: 'rust', ...overrides })).toThrow();
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
    const text = firstText(result);
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
    const text = firstText(content);
    // When storyId === id and no storyTitle, parentRef should not appear
    expect(text).not.toContain('story:"');
  });

  it('totalPages reports Algolia nbPages, not a recomputation from nbHits', async () => {
    /**
     * Every candidate formula over the other fields is distinct here:
     * ceil(nbHits / count) = 10, ceil(nbHits / hitsPerPage) = 5 — but Algolia
     * says 3, and that is the only page count it will serve.
     */
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [], nbHits: 100, nbPages: 3, hitsPerPage: 20, page: 0 }),
    );

    const freshCtx = createMockContext();
    await searchHn.handler(searchHn.input.parse({ query: 'x', count: 10 }), freshCtx);

    const enrichment = getEnrichment(freshCtx);
    expect(enrichment.totalPages).toBe(3);
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
    expect(firstText(content)).toContain('### Some Story (github.com)');
    // Heading does not use www prefix
    expect(firstText(content)).not.toContain('### Some Story (www.github.com)');
  });
});

// ---------------------------------------------------------------------------
// Contract helpers — run the definition through the production-shaped pipeline
// so both client surfaces (structuredContent and content[]) can be asserted.
// ---------------------------------------------------------------------------

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

interface WireError {
  code: number;
  data?: { reason?: string; recovery?: { hint?: string } } & Record<string, unknown>;
  message: string;
}

function callSearch(input: Record<string, unknown>): Promise<ToolResult> {
  return runToolContract(searchHn, input as never, { context: { errors: searchHn.errors } });
}

function wireError(result: ToolResult): WireError {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: WireError }).error;
}

function contentText(result: ToolResult): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function structured(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

/** A JSON Schema node, narrowed to the keys these tests read. */
interface SchemaNode {
  description?: string;
  minLength?: number;
  pattern?: string;
  properties?: Record<string, SchemaNode>;
}

/** The advertised JSON Schema of one input property, e.g. `inputProperty('dateRange', 'start')`. */
function inputProperty(...path: string[]): SchemaNode {
  let node = z.toJSONSchema(searchHn.input) as SchemaNode;
  for (const key of path) node = node.properties?.[key] ?? {};
  return node;
}

// ---------------------------------------------------------------------------
// #24 — blank-after-trim messages
// ---------------------------------------------------------------------------

describe('hn_search_content blank-string messages', () => {
  it.each(['', '   ', '\t\n'])('names the trimmed-blank query and the fix (%j)', async (query) => {
    const result = await callSearch({ query });
    const error = wireError(result);

    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.data?.recovery?.hint).toContain('blank after trimming whitespace');
    expect(error.data?.recovery?.hint).toContain('omit query');
    expect(contentText(result)).toContain('query: blank after trimming whitespace');
    expect(contentText(result)).toContain('omit query');
    expect(contentText(result)).not.toContain('Too small');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('names the trimmed-blank author and the fix (%j)', async (author) => {
    const result = await callSearch({ query: 'rust', author });
    const error = wireError(result);

    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.data?.recovery?.hint).toContain('blank after trimming whitespace');
    expect(error.data?.recovery?.hint).toContain('omit author to search all authors');
    expect(contentText(result)).toContain(
      'author: blank after trimming whitespace — omit author to search all authors',
    );
    expect(contentText(result)).not.toContain('Too small');
  });

  it('still advertises minLength 1 on query and author', () => {
    expect(inputProperty('query').minLength).toBe(1);
    expect(inputProperty('author').minLength).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #21 — ISO 8601 date bounds, validated and ordered
// ---------------------------------------------------------------------------

describe('hn_search_content dateRange validation', () => {
  it.each([
    '2024',
    '2024-05',
    '2024-05-05',
    '2024-05-05T10:00',
    '2024-05-05T10:00:00',
    '2024-05-05T10:00:00.123',
    '2024-05-05T10:00:00Z',
    '2024-05-05T10:00:00+02:00',
    '2024-05-05T10:00-07:00',
    '2024-02-29',
  ])('accepts the ISO 8601 form %j', (start) => {
    expect(searchHn.input.parse({ query: 'x', dateRange: { start } }).dateRange?.start).toBe(start);
    expect(searchHn.input.parse({ query: 'x', dateRange: { end: start } }).dateRange?.end).toBe(
      start,
    );
  });

  it.each([
    '1',
    'May 5 2024',
    '2024/05/05',
    '2024-02-30',
    '2023-02-29',
    '2024-13-01',
    '2024-00-10',
    '2024-05-00',
    '2024-05-05T24:00',
    '2024-05-05T10:60',
    '2024-05-05T10:00:60',
    '2024-05-05T10:00+24:00',
    '2024-05-05 10:00',
    '',
  ])('rejects the non-ISO or calendar-invalid value %j at the schema', async (value) => {
    expect(() => searchHn.input.parse({ query: 'x', dateRange: { start: value } })).toThrow();
    expect(() => searchHn.input.parse({ query: 'x', dateRange: { end: value } })).toThrow();

    const result = await callSearch({ query: 'x', dateRange: { end: value } });
    expect(wireError(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('advertises the accepted pattern on dateRange.start and dateRange.end', () => {
    const pattern = inputProperty('dateRange', 'start').pattern ?? '';
    expect(pattern).not.toBe('');
    expect(inputProperty('dateRange', 'end').pattern).toBe(pattern);
    expect(new RegExp(pattern).test('2024-05-05T10:00:00+02:00')).toBe(true);
    expect(new RegExp(pattern).test('May 5 2024')).toBe(false);
  });

  it('documents exclusive UTC bound semantics in the start/end descriptions', () => {
    const start = inputProperty('dateRange', 'start').description;
    const end = inputProperty('dateRange', 'end').description;
    expect(start).toMatch(/exclusive/i);
    expect(start).toMatch(/UTC/);
    expect(end).toMatch(/exclusive/i);
    expect(end).toMatch(/next day/i);
  });

  it('fails an empty dateRange with invalid_date_range on both surfaces, before any upstream call', async () => {
    const result = await callSearch({ query: 'rust', dateRange: {} });
    const error = wireError(result);

    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_date_range');
    expect(error.data?.recovery?.hint).toMatch(/omit dateRange/i);
    expect(contentText(result)).toMatch(/omit dateRange/i);
    expect(contentText(result)).toContain('invalid_date_range');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('treats form-client blank bounds as invalid input, not as an empty range', async () => {
    const result = await callSearch({ query: 'rust', dateRange: { start: '', end: '' } });
    expect(wireError(result).data?.reason).toBe('invalid_arguments');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it.each([
    ['start equals end', { start: '2024-05-05', end: '2024-05-05' }],
    ['start after end', { start: '2026-08-11T00:00:00Z', end: '2020-01-01T00:00:00Z' }],
    [
      'same instant, different offsets',
      { start: '2024-05-05T12:00+02:00', end: '2024-05-05T10:00Z' },
    ],
    ['reduced forms naming one instant', { start: '2024', end: '2024-01-01' }],
  ])('fails when %s with invalid_date_range on both surfaces', async (_label, dateRange) => {
    const result = await callSearch({ query: 'rust', dateRange });
    const error = wireError(result);

    expect(error.data?.reason).toBe('invalid_date_range');
    expect(error.message).toContain(dateRange.start);
    expect(error.message).toContain(dateRange.end);
    expect(error.data?.recovery?.hint).toBeTruthy();
    expect(contentText(result)).toContain('invalid_date_range');
    expect(contentText(result)).toContain(error.data!.recovery!.hint!);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('passes an ordered range and single-bound ranges through to the service', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    for (const dateRange of [
      { start: '2024-01-01', end: '2024-01-02' },
      { start: '2024-01-01' },
      { end: '2024-12-31' },
    ]) {
      const result = await callSearch({ query: 'rust', dateRange });
      expect(result.isError).toBeFalsy();
    }
    expect(mockSearch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// #22 — filter-only and story-scoped search
// ---------------------------------------------------------------------------

describe('hn_search_content filter-only and story-scoped search', () => {
  it('accepts poll and job in the tags enum', () => {
    expect(searchHn.input.parse({ tags: 'poll' }).tags).toBe('poll');
    expect(searchHn.input.parse({ tags: 'job' }).tags).toBe('job');
  });

  it('accepts a positive integer storyId and rejects anything else', () => {
    expect(searchHn.input.parse({ storyId: 8863 }).storyId).toBe(8863);
    for (const storyId of [0, -1, 1.5, '8863']) {
      expect(() => searchHn.input.parse({ storyId })).toThrow();
    }
  });

  it('describes where to get a storyId', () => {
    expect(inputProperty('storyId').description).toContain('hits[].storyId');
    expect(inputProperty('storyId').description).toContain('hn_get_thread');
  });

  it.each([
    ['tags', { tags: 'ask_hn' }],
    ['author', { author: 'pg' }],
    ['storyId', { storyId: 8863 }],
    ['minPoints', { minPoints: 500 }],
    ['dateRange.start', { dateRange: { start: '2024-01-01' } }],
    ['dateRange.end', { dateRange: { end: '2024-01-01' } }],
  ])('runs a filter-only search with just %s', async (_label, input) => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [storyHit], nbHits: 1, nbPages: 1, page: 0 }),
    );

    const result = await callSearch(input);
    const sc = structured(result);

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch.mock.calls[0]![0]).not.toHaveProperty('query');
    expect(sc).not.toHaveProperty('query');
    expect(contentText(result)).toContain('### Test Story');
    expect(contentText(result)).not.toContain('"undefined"');
  });

  it('forwards storyId to the service alongside tags and query', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    await callSearch({ query: 'lisp', tags: 'comment', storyId: 8863 });

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'lisp', tags: 'comment', storyId: 8863 }),
      expect.anything(),
    );
  });

  it.each([
    ['nothing at all', {}],
    ['only sort, count, page, and view', { sort: 'date', count: 5, page: 1, view: 'compact' }],
  ])('fails %s with missing_query_or_filter on both surfaces', async (_label, input) => {
    const result = await callSearch(input);
    const error = wireError(result);

    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('missing_query_or_filter');
    expect(error.data?.recovery?.hint).toContain('query');
    expect(error.data?.recovery?.hint).toContain('tags');
    expect(error.data?.recovery?.hint).toContain('storyId');
    expect(contentText(result)).toContain('missing_query_or_filter');
    expect(contentText(result)).toContain(error.data!.recovery!.hint!);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('fails a bare empty dateRange with invalid_date_range, not missing_query_or_filter', async () => {
    const result = await callSearch({ dateRange: {} });
    expect(wireError(result).data?.reason).toBe('invalid_date_range');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('keeps the blank-query rejection when a blank query is supplied', async () => {
    const result = await callSearch({ query: '   ', tags: 'story' });
    expect(wireError(result).data?.reason).toBe('invalid_arguments');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('renders a filter-only heading and echoes no query', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [storyHit], nbHits: 1, nbPages: 1, page: 0 }),
    );

    const result = await callSearch({ tags: 'show_hn' });

    expect(contentText(result)).toContain('## Search results (filters only)');
    expect(contentText(result)).not.toContain('""');
  });

  it('format() renders the no-query empty result without an empty quoted query', () => {
    const text = firstText(searchHn.format!({ hits: [] }));
    expect(text).toBe('No results.');
  });

  it('format() keeps the quoted-query heading when a query is present', () => {
    const text = firstText(searchHn.format!({ hits: [], query: 'rust' }));
    expect(text).toBe('"rust" — no results.');
  });

  it('names the applied filters in the zero-result notice of a filter-only search', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const result = await callSearch({ tags: 'poll', author: 'nobody' });
    const notice = structured(result).notice as string;

    expect(notice).toContain('tags, author');
    expect(notice).not.toMatch(/broader keywords/);
    expect(contentText(result)).toContain(notice);
  });

  it('names storyId and where to get one in the zero-result notice', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const result = await callSearch({ storyId: 9707, tags: 'comment' });
    const notice = structured(result).notice as string;

    expect(notice).toContain('storyId');
    expect(notice).toContain('hits[].storyId');
    expect(notice).toContain('hn_get_thread');
    expect(contentText(result)).toContain(notice);
  });

  it('keeps the broaden-keywords notice for a zero-match keyword search with storyId', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const result = await callSearch({ query: 'zzz', storyId: 8863 });
    const notice = structured(result).notice as string;

    expect(notice).toContain('Try broader keywords, or relax these filters: storyId.');
    expect(notice).toContain('hits[].storyId');
  });

  it('renders poll and job hits with their titles', async () => {
    const pollHit = { ...storyHit, objectID: '3746692', title: 'Poll: Favorite language?' };
    const jobHit = { ...storyHit, objectID: '999984', title: 'Acme is hiring', points: null };
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [pollHit, jobHit], nbHits: 2, nbPages: 1, page: 0 }),
    );

    const result = await callSearch({ tags: 'job' });
    const text = contentText(result);

    expect(text).toContain('### Poll: Favorite language?');
    expect(text).toContain('### Acme is hiring');
    expect(text).toContain('id:999984');
  });
});

// ---------------------------------------------------------------------------
// #28 — minPoints cannot match unscored item types
// ---------------------------------------------------------------------------

describe('hn_search_content minPoints on unscored types', () => {
  it.each(['comment', 'job'])(
    'fails tags %j with minPoints before any upstream call, on both surfaces',
    async (tags) => {
      for (const minPoints of [0, 10]) {
        const result = await callSearch({ query: 'rust', tags, minPoints });
        const error = wireError(result);

        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data?.reason).toBe('min_points_unscored_type');
        expect(error.message).toContain(tags);
        expect(error.data?.recovery?.hint).toMatch(/drop minPoints/i);
        expect(contentText(result)).toContain('min_points_unscored_type');
        expect(contentText(result)).toContain(error.data!.recovery!.hint!);
      }
      expect(mockSearch).not.toHaveBeenCalled();
    },
  );

  it.each(['story', 'poll', 'ask_hn', 'show_hn', 'front_page'])(
    'still sends minPoints for tags %j',
    async (tags) => {
      mockSearch.mockResolvedValue(algoliaResponse());
      const result = await callSearch({ query: 'rust', tags, minPoints: 10 });
      expect(result.isError).toBeFalsy();
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ minPoints: 10 }),
        expect.anything(),
      );
    },
  );

  it('explains in the minPoints description that comments and jobs carry no points', () => {
    const { description } = inputProperty('minPoints');
    expect(description).toMatch(/comments/i);
    expect(description).toMatch(/jobs/i);
    expect(description).toMatch(/no points/i);
  });
});

// ---------------------------------------------------------------------------
// #17 — terminal pages versus truncation
// ---------------------------------------------------------------------------

describe('hn_search_content pagination notices', () => {
  const fiveHits = Array.from({ length: 5 }, (_, i) => ({ ...storyHit, objectID: String(i + 1) }));

  it('keeps truncated/shown/cap on a page with more pages behind it', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: fiveHits, nbHits: 76, nbPages: 16, page: 0, hitsPerPage: 5 }),
    );

    const result = await callSearch({ query: 'rust', count: 5 });

    expect(structured(result)).toMatchObject({ truncated: true, shown: 5, cap: 5 });
  });

  it('names the next page and the count ceiling instead of the framework default', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: fiveHits, nbHits: 76, nbPages: 16, page: 0, hitsPerPage: 5 }),
    );

    const result = await callSearch({ query: 'rust', count: 5 });
    const notice = structured(result).notice as string;

    expect(notice).toBe(
      'Showing 5 of 76 hits (page 0 of 16). Pass page: 1 for more, or raise count (max 50).',
    );
    expect(notice).not.toContain('narrow with filters');
    expect(contentText(result)).toContain(notice);
  });

  it('drops the raise-count suggestion when count is already at its max', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({ ...storyHit, objectID: String(i + 1) }));
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: fifty, nbHits: 1000, nbPages: 20, page: 3, hitsPerPage: 50 }),
    );

    const result = await callSearch({ query: 'a', count: 50, page: 3 });
    const notice = structured(result).notice as string;

    expect(notice).toBe('Showing 50 of 1000 hits (page 3 of 20). Pass page: 4 for more.');
  });

  it('reports the last page Algolia serves as terminal — no truncated, shown, cap, or notice', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({ ...storyHit, objectID: String(i + 1) }));
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: fifty, nbHits: 2_261_745, nbPages: 20, page: 19, hitsPerPage: 50 }),
    );

    const result = await callSearch({ query: 'a', count: 50, page: 19 });
    const sc = structured(result);

    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('shown');
    expect(sc).not.toHaveProperty('cap');
    expect(sc).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('capped');
  });

  it('reports a single full page as terminal', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: fiveHits, nbHits: 5, nbPages: 1, page: 0, hitsPerPage: 5 }),
    );

    const sc = structured(await callSearch({ query: 'rust', count: 5 }));

    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('notice');
  });

  it('gives a page past the end an exhausted-page notice naming the last valid page', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [], nbHits: 9, nbPages: 2, page: 2, hitsPerPage: 5 }),
    );

    const result = await callSearch({
      query: 'lisp',
      tags: 'story',
      author: 'pg',
      count: 5,
      page: 2,
    });
    const sc = structured(result);
    const notice = sc.notice as string;

    expect(sc).toMatchObject({ totalHits: 9, totalPages: 2, page: 2 });
    expect(sc).not.toHaveProperty('truncated');
    expect(notice).toContain('Page 2 is past the last page');
    expect(notice).toContain('page: 1');
    expect(notice).not.toMatch(/broader keywords|relax these filters/);
    expect(contentText(result)).toContain(notice);
  });

  it('resets to page 0 when a page lies beyond the 1,000-hit ceiling and the last page is unknown', async () => {
    /** Past the ceiling Algolia answers nbHits 0 / nbPages 0, so the last valid page is unknown. */
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [], nbHits: 0, nbPages: 0, page: 20, hitsPerPage: 50 }),
    );

    const result = await callSearch({ query: 'a', count: 50, page: 20 });
    const notice = structured(result).notice as string;

    expect(notice).toContain('Page 20');
    expect(notice).toContain('1,000');
    expect(notice).toContain('page: 0');
    expect(notice).not.toMatch(/broader keywords|different terms/);
    expect(contentText(result)).toContain(notice);
  });

  it('keeps the relax-filters notice on a zero-match first page', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const result = await callSearch({ query: 'zzzz', tags: 'story', page: 0 });

    expect(structured(result).notice).toBe('Try broader keywords, or relax these filters: tags.');
  });

  it('describes truncated as more pages remaining and notice as covering pagination', () => {
    const enrichment = searchHn.enrichment as Record<string, z.ZodType>;
    expect(enrichment.truncated!.description).toMatch(/more pages/i);
    expect(enrichment.notice!.description).not.toMatch(/Absent on non-empty result pages/);
  });
});
