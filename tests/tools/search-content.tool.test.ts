/**
 * @fileoverview Tests for the hn_search_content tool — handler, format, and input validation.
 * @module mcp-server/tools/definitions/search-content.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext as createFrameworkMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteBody } from '@/mcp-server/tools/markdown-escape.js';
import type { AlgoliaResponse } from '@/services/hn/types.js';
import { expectLinearCpu } from '../helpers/cpu-time.js';

vi.mock('@/services/hn/hn-service.js', async (importOriginal) => ({
  dateBoundToEpochMs: (await importOriginal<typeof import('@/services/hn/hn-service.js')>())
    .dateBoundToEpochMs,
  dateRangeToEpochSeconds: (await importOriginal<typeof import('@/services/hn/hn-service.js')>())
    .dateRangeToEpochSeconds,
  decodeHtmlEntities: (await importOriginal<typeof import('@/services/hn/hn-service.js')>())
    .decodeHtmlEntities,
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

import {
  composeSearchNotice,
  searchHn,
  stripUrlPrefix,
} from '@/mcp-server/tools/definitions/search-content.tool.js';
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
        hits: [
          { ...storyHit, _tags: ['story', 'author_alice', 'story_123'] },
          { ...commentHit, _tags: ['comment', 'author_bob', 'story_123'] },
        ],
        nbHits: 100_000,
        nbPages: 34,
        page: 0,
      }),
    );

    const freshCtx = createMockContext();
    const result = await searchHn.handler(searchHn.input.parse({ query: 'test' }), freshCtx);

    expect(result).toStrictEqual({
      hits: [
        {
          id: 123,
          type: 'story',
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
          type: 'comment',
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
      "Try broader keywords, or relax these filters: tags, author, minPoints, dateRange. author must match the username's exact HN casing; hn_get_user answers user_not_found for a mis-cased name.",
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

  it('constrains count to 1-1,000', () => {
    expect(() => searchHn.input.parse({ query: 'test', count: 0 })).toThrow();
    expect(() => searchHn.input.parse({ query: 'test', count: 1001 })).toThrow();
    expect(searchHn.input.parse({ query: 'test', count: 1 }).count).toBe(1);
    expect(searchHn.input.parse({ query: 'test', count: 50 }).count).toBe(50);
    expect(searchHn.input.parse({ query: 'test', count: 51 }).count).toBe(51);
    expect(searchHn.input.parse({ query: 'test', count: 1000 }).count).toBe(1000);
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

  it('format() escapes query in no-results message so a tag cannot open', () => {
    const result = searchHn.format!({ hits: [], query: '<script>alert(1)</script>' });

    expect(firstText(result)).toBe('"\\<script>alert(1)\\</script>" — no results.');
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

  it.each([
    ['with a Z offset', { start: '2024-05-05T10:00:00.2Z', end: '2024-05-05T10:00:00.7Z' }],
    ['offset-less, read as UTC', { start: '2024-05-05T10:00:00.2', end: '2024-05-05T10:00:00.7' }],
  ])('accepts a start before end within the same second (%s)', async (_label, dateRange) => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const result = await callSearch({ query: 'rust', dateRange });

    expect(result.isError).toBeFalsy();
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('still rejects one sub-second instant written with and without an offset', async () => {
    const result = await callSearch({
      query: 'rust',
      dateRange: { start: '2024-05-05T12:00:00.5+02:00', end: '2024-05-05T10:00:00.5' },
    });

    expect(wireError(result).data?.reason).toBe('invalid_date_range');
    expect(mockSearch).not.toHaveBeenCalled();
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

  it('reports the last page Algolia serves as terminal — no truncated, shown, or cap; the notice names the ceiling', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({ ...storyHit, objectID: String(i + 1) }));
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: fifty, nbHits: 2_261_745, nbPages: 20, page: 19, hitsPerPage: 50 }),
    );

    const result = await callSearch({ query: 'a', count: 50, page: 19 });
    const sc = structured(result);

    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('shown');
    expect(sc).not.toHaveProperty('cap');
    expect(sc.notice).toBe(
      'Page 19 is the last page Algolia serves: a search returns at most 1,000 of its matches, and this one matches 2261745. Split it into narrower dateRange windows to reach the rest.',
    );
    expect(contentText(result)).toContain(sc.notice as string);
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

// ---------------------------------------------------------------------------
// Notice sentences in full, so a notice is asserted as exactly the sentences it joins
// ---------------------------------------------------------------------------

const droppedSentence = (prefix: string) =>
  `The leading \`${prefix}\` was dropped from the query, so the URL matches submissions under either scheme, with or without www.`;
const FRAGMENTS_SENTENCE =
  'Submissions often omit #fragments and tracking parameters such as utm_source; search the URL without them.';
const FRONT_PAGE_SENTENCE =
  'front_page matches only the stories on the HN front page right now (about 30), never past front pages; for an earlier window, search tags "story" with dateRange and minPoints instead.';
const AUTHOR_CASE_SENTENCE =
  "author must match the username's exact HN casing; hn_get_user answers user_not_found for a mis-cased name.";
const STORY_ID_SENTENCE =
  "storyId must be a story or poll root id — take it from hits[].storyId, a poll hit's own id (poll hits carry no storyId), or hn_get_thread: the root item's id, or its item.storyId when the root is a comment. A comment id matches nothing.";
const cappedSentence = (page: number, total: string) =>
  `Page ${page} is the last page Algolia serves: a search returns at most 1,000 of its matches, and this one matches ${total}. Split it into narrower dateRange windows to reach the rest.`;
const joined = (...sentences: string[]) => sentences.join(' ');

// ---------------------------------------------------------------------------
// The one notice: page state first, then cause sentences in input order
// ---------------------------------------------------------------------------

describe('composeSearchNotice', () => {
  /** Every input that can call for a sentence, set at once. */
  const everyCause = {
    query: 'example.com/a',
    droppedPrefix: 'https://www.',
    tags: 'front_page',
    author: 'someone',
    storyId: 8863,
    dateRange: { start: '2026-10-01' },
    count: 5,
  };

  it('opens an empty first page with the relax text, then every cause in input order', () => {
    const notice = composeSearchNotice({
      ...everyCause,
      shown: 0,
      page: 0,
      totalHits: 0,
      totalPages: 0,
    });

    expect(notice).toBe(
      joined(
        'Try broader keywords, or relax these filters: tags, author, storyId, dateRange.',
        droppedSentence('https://www.'),
        FRAGMENTS_SENTENCE,
        FRONT_PAGE_SENTENCE,
        AUTHOR_CASE_SENTENCE,
        STORY_ID_SENTENCE,
      ),
    );
  });

  it('opens a page with more behind it with the next-page guidance', () => {
    const notice = composeSearchNotice({
      ...everyCause,
      shown: 5,
      page: 0,
      totalHits: 12,
      totalPages: 3,
    });

    expect(notice).toBe(
      joined(
        'Showing 5 of 12 hits (page 0 of 3). Pass page: 1 for more, or raise count (max 50).',
        droppedSentence('https://www.'),
        FRONT_PAGE_SENTENCE,
      ),
    );
  });

  it('opens the last page of a capped search with the ceiling', () => {
    const notice = composeSearchNotice({
      ...everyCause,
      shown: 5,
      page: 199,
      totalHits: 1142,
      totalHitsExact: true,
      totalPages: 200,
    });

    expect(notice).toBe(
      joined(cappedSentence(199, '1142'), droppedSentence('https://www.'), FRONT_PAGE_SENTENCE),
    );
  });

  it('opens a page past the end with the last valid page', () => {
    const notice = composeSearchNotice({
      ...everyCause,
      shown: 0,
      page: 4,
      totalHits: 12,
      totalPages: 3,
    });

    expect(notice).toBe(
      joined(
        'Page 4 is past the last page of results (12 hits across 3 pages). Pass page: 2 for the last page, or page: 0 to start over.',
        droppedSentence('https://www.'),
        FRONT_PAGE_SENTENCE,
      ),
    );
  });

  it('names one lever for a page past the end of a one-page search, where the last page is page 0', () => {
    const notice = composeSearchNotice({
      query: 'rust',
      count: 5,
      shown: 0,
      page: 2,
      totalHits: 4,
      totalPages: 1,
    });

    expect(notice).toBe(
      'Page 2 is past the last page of results (4 hits across 1 page). Pass page: 0 for that page.',
    );
  });

  it('carries cause sentences alone on an uncapped last page', () => {
    const notice = composeSearchNotice({
      ...everyCause,
      shown: 3,
      page: 0,
      totalHits: 3,
      totalPages: 1,
    });

    expect(notice).toBe(joined(droppedSentence('https://www.'), FRONT_PAGE_SENTENCE));
  });

  it('returns undefined when nothing applies', () => {
    expect(
      composeSearchNotice({
        query: 'rust',
        count: 5,
        shown: 3,
        page: 0,
        totalHits: 3,
        totalPages: 1,
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #34 — estimated totals and capped coverage
// ---------------------------------------------------------------------------

describe('hn_search_content totals and capped coverage', () => {
  const pageOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...storyHit, objectID: String(i + 1) }));

  /** The two exactness flags as Algolia sends them on one response. */
  const exactCount = { exhaustiveNbHits: true, exhaustive: { nbHits: true, typo: true } };
  const estimatedCount = { exhaustiveNbHits: false, exhaustive: { nbHits: false, typo: true } };

  /**
   * Response metadata captured live: a one-day `tags=story` window counts 1,142
   * hits exactly, and 50 per page reaches 20 pages, the last of them full.
   */
  const oneDayStories = { nbHits: 1142, nbPages: 20, hitsPerPage: 50, ...exactCount };

  it.each([
    ['exhaustive.nbHits true', { exhaustive: { nbHits: true } }, true],
    ['exhaustive.nbHits false', { exhaustive: { nbHits: false } }, false],
    ['exhaustiveNbHits alone, true', { exhaustiveNbHits: true }, true],
    ['exhaustiveNbHits alone, false', { exhaustiveNbHits: false }, false],
    [
      'exhaustive.nbHits over a disagreeing exhaustiveNbHits',
      { exhaustive: { nbHits: false }, exhaustiveNbHits: true },
      false,
    ],
  ])('reports totalHitsExact from %s on both surfaces', async (_label, flags, expected) => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: pageOf(5), nbHits: 5, nbPages: 1, ...flags }),
    );

    const result = await callSearch({ query: 'rust' });

    expect(structured(result).totalHitsExact).toBe(expected);
    expect(contentText(result)).toContain(`**totalHitsExact:** ${expected}`);
  });

  it('omits totalHitsExact when Algolia sends neither flag', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: pageOf(5), nbHits: 5, nbPages: 1 }));

    const result = await callSearch({ query: 'rust' });

    expect(structured(result)).not.toHaveProperty('totalHitsExact');
    expect(contentText(result)).not.toContain('totalHitsExact');
  });

  it('omits totalHitsExact and reachableHits past the ceiling, where Algolia reports an exact 0', async () => {
    /** Captured live: page 20 at 50 per page of `tags=story`. */
    mockSearch.mockResolvedValue(
      algoliaResponse({
        hits: [],
        nbHits: 0,
        nbPages: 0,
        page: 20,
        hitsPerPage: 50,
        ...exactCount,
      }),
    );

    const result = await callSearch({ tags: 'story', count: 50, page: 20 });
    const sc = structured(result);

    expect(sc).not.toHaveProperty('totalHitsExact');
    expect(sc).not.toHaveProperty('reachableHits');
    expect(sc.notice).toBe(
      'Page 20 is past the last page Algolia serves for this search (at most 1,000 hits per search), where totalHits and totalPages read 0. Pass page: 0 to start over; if that also returns nothing, the search itself matches nothing.',
    );
    expect(contentText(result)).not.toContain('totalHitsExact');
  });

  it('keeps totalHitsExact on an exact zero-match first page', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ ...exactCount }));

    const sc = structured(await callSearch({ tags: 'poll', author: 'nobody' }));

    expect(sc.totalHitsExact).toBe(true);
  });

  it.each([
    ['the first page', 0, 50],
    ['a middle page', 7, 50],
    ['the last page', 19, 50],
  ])('reports reachableHits 1000 on %s of a search past the ceiling', async (_label, page, n) => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: pageOf(n), page, ...oneDayStories }));

    const result = await callSearch({
      tags: 'story',
      dateRange: { start: '2026-10-01', end: '2026-10-02' },
      count: 50,
      page,
    });

    expect(structured(result).reachableHits).toBe(1000);
    expect(contentText(result)).toContain('**reachableHits:** 1000');
  });

  it.each([
    ['exactly 1,000 hits', 1000, 20, 19, 50],
    ['327 hits', 327, 7, 6, 27],
  ])(
    'omits reachableHits when every hit is reachable (%s)',
    async (_label, nbHits, nbPages, page, n) => {
      mockSearch.mockResolvedValue(
        algoliaResponse({ hits: pageOf(n), nbHits, nbPages, page, hitsPerPage: 50, ...exactCount }),
      );

      const result = await callSearch({ query: 'lisp', count: 50, page });

      expect(structured(result)).not.toHaveProperty('reachableHits');
      expect(contentText(result)).not.toContain('reachableHits');
    },
  );

  it('gives the last page of a capped search a ceiling notice, and no truncated, shown, or cap', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: pageOf(50), page: 19, ...oneDayStories }));

    const result = await callSearch({
      tags: 'story',
      dateRange: { start: '2026-10-01', end: '2026-10-02' },
      count: 50,
      page: 19,
    });
    const sc = structured(result);
    const notice = sc.notice as string;

    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('shown');
    expect(sc).not.toHaveProperty('cap');
    expect(notice).toBe(cappedSentence(19, '1142'));
    expect(contentText(result)).toContain(notice);
  });

  it('reads the capped total as "about N" when it is an estimate', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({
        hits: pageOf(50),
        nbHits: 45_558_372,
        nbPages: 20,
        page: 19,
        hitsPerPage: 50,
        ...estimatedCount,
      }),
    );

    const notice = structured(await callSearch({ tags: 'story', count: 50, page: 19 }))
      .notice as string;

    expect(notice).toBe(cappedSentence(19, 'about 45558372'));
  });

  it('treats a page straddling the ceiling as the last page of a capped search', async () => {
    /** Captured live: page 333 at 3 per page returns only the 1,000th hit. */
    mockSearch.mockResolvedValue(
      algoliaResponse({
        hits: pageOf(1),
        nbHits: 45_559_886,
        nbPages: 334,
        page: 333,
        hitsPerPage: 3,
        ...estimatedCount,
      }),
    );

    const sc = structured(await callSearch({ tags: 'story', count: 3, page: 333 }));

    expect(sc).not.toHaveProperty('truncated');
    expect(sc.reachableHits).toBe(1000);
    expect(sc.notice).toBe(cappedSentence(333, 'about 45559886'));
  });

  it('reads next-page guidance as "of about N" when totalHits is an estimate', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({
        hits: pageOf(50),
        nbHits: 45_558_373,
        nbPages: 20,
        page: 0,
        hitsPerPage: 50,
        ...estimatedCount,
      }),
    );

    const result = await callSearch({ tags: 'story', count: 50 });
    const sc = structured(result);

    expect(sc).toMatchObject({ truncated: true, shown: 50, cap: 50 });
    expect(sc.notice).toBe(
      'Showing 50 of about 45558373 hits (page 0 of 20). Pass page: 1 for more.',
    );
    expect(contentText(result)).toContain(sc.notice as string);
  });

  it.each([
    ['exact', exactCount],
    ['unreported', {}],
  ])('keeps next-page guidance as "of N" when exactness is %s', async (_label, flags) => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: pageOf(5), nbHits: 76, nbPages: 16, hitsPerPage: 5, ...flags }),
    );

    const sc = structured(await callSearch({ query: 'rust', count: 5 }));

    expect(sc.notice).toBe(
      'Showing 5 of 76 hits (page 0 of 16). Pass page: 1 for more, or raise count (max 50).',
    );
  });

  it('leaves an uncapped last page with no notice and no reachableHits', async () => {
    /** Captured live: `lisp` by `pg`, page 6 at 50 per page, counted as an estimate. */
    mockSearch.mockResolvedValue(
      algoliaResponse({
        hits: pageOf(27),
        nbHits: 327,
        nbPages: 7,
        page: 6,
        hitsPerPage: 50,
        ...estimatedCount,
      }),
    );

    const result = await callSearch({ query: 'lisp', author: 'pg', count: 50, page: 6 });
    const sc = structured(result);

    expect(sc).not.toHaveProperty('notice');
    expect(sc).not.toHaveProperty('reachableHits');
    expect(sc.totalHitsExact).toBe(false);
  });

  it('describes totalHits as possibly estimated and the 1,000-hit reach', () => {
    const enrichment = searchHn.enrichment as Record<string, z.ZodType>;
    expect(enrichment.totalHits!.description).toMatch(/estimate/i);
    expect(enrichment.totalHits!.description).toContain('totalHitsExact');
    expect(enrichment.totalHitsExact!.description).toMatch(/estimate/i);
    expect(enrichment.reachableHits!.description).toContain('1,000');
    expect(enrichment.totalPages!.description).toContain('1,000');
    expect(enrichment.notice!.description).not.toMatch(
      /Absent on the last page of a non-empty result/,
    );
  });
});

// ---------------------------------------------------------------------------
// #38 — URL queries searched without their scheme and www.
// ---------------------------------------------------------------------------

describe('stripUrlPrefix', () => {
  it.each([
    ['https://www.paulgraham.com/greatwork.html', 'paulgraham.com/greatwork.html', 'https://www.'],
    ['http://www.paulgraham.com/greatwork.html', 'paulgraham.com/greatwork.html', 'http://www.'],
    ['https://paulgraham.com/greatwork.html', 'paulgraham.com/greatwork.html', 'https://'],
    ['www.paulgraham.com/greatwork.html', 'paulgraham.com/greatwork.html', 'www.'],
    ['HTTPS://WWW.PaulGraham.com/greatwork.html', 'PaulGraham.com/greatwork.html', 'HTTPS://WWW.'],
    [
      'https://www.youtube.com/watch?v=4e0fRKHG7Hk',
      'youtube.com/watch?v=4e0fRKHG7Hk',
      'https://www.',
    ],
    ['https://www.example.com/', 'example.com/', 'https://www.'],
  ])('searches %j as %j, dropping %j', (query, searched, dropped) => {
    expect(stripUrlPrefix(query)).toEqual({ query: searched, droppedPrefix: dropped });
  });

  it.each([
    'https://x.com is down',
    'http server rust',
    'HTTP/2',
    'https://',
    'www.',
    'https://www.',
    'paulgraham.com/greatwork.html',
    'ftp://example.com/file',
    'httpx://example.com',
    'wwwexample.com',
    'see https://example.com',
  ])('searches %j as typed', (query) => {
    expect(stripUrlPrefix(query)).toEqual({ query });
  });

  describe('worst-case timing', () => {
    const repeat = (unit: string) => (n: number) =>
      unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

    /** One call's CPU ceiling: 10 ms plus 1 ms per 1,000 characters. */
    const maxMs = (chars: number) => 10 + chars / 1_000;

    it.each([
      ['a long digit run behind a prefix', (n: number) => `https://www.${'7'.repeat(n)}`],
      ['repeated prefixes', repeat('https://www.')],
      ['repeated schemes with no host', repeat('http://')],
      ['one long line ending in a break', (n: number) => `${repeat('§1 x')(n)}\ny`],
      ['breaks throughout', repeat('  \r\n')],
      ['a prefix then a long line ending in a break', (n: number) => `www.${'a'.repeat(n)}\ny`],
    ])(
      'stays linear on %s',
      (_label, make) => {
        expectLinearCpu({ make, run: stripUrlPrefix, maxMs });
      },
      120_000,
    );
  });
});

describe('hn_search_content URL queries', () => {
  /** The 11 stories the scheme-less form matched live, led by the 1,008-point 36550615. */
  const greatWorkIds = [
    36550615, 49132289, 36550665, 36823638, 36569962, 45095262, 36733189, 43125047, 36759822,
    46780410, 46497378,
  ];
  const greatWorkHits = greatWorkIds.map((id) => ({
    ...storyHit,
    objectID: String(id),
    title: 'How to Do Great Work',
    url: 'http://paulgraham.com/greatwork.html',
  }));

  it.each([
    'https://www.paulgraham.com/greatwork.html',
    'http://www.paulgraham.com/greatwork.html',
  ])('searches %j without its scheme and www., and says so on both surfaces', async (query) => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: greatWorkHits, nbHits: 11, nbPages: 1, page: 0 }),
    );

    const result = await callSearch({ query, tags: 'story' });
    const sc = structured(result);
    const notice = sc.notice as string;

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'paulgraham.com/greatwork.html', tags: 'story' }),
      expect.anything(),
    );
    expect(sc.query).toBe('paulgraham.com/greatwork.html');
    expect((sc.hits as { id: number }[]).map((h) => h.id)).toEqual(greatWorkIds);
    expect(contentText(result)).toContain('## "paulgraham.com/greatwork.html" — search results');
    expect(notice).toBe(droppedSentence(query.slice(0, query.indexOf('paulgraham'))));
    expect(contentText(result)).toContain(notice);
  });

  it('keeps the path and query string of a rewritten URL', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    await callSearch({ query: 'https://www.youtube.com/watch?v=4e0fRKHG7Hk' });

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'youtube.com/watch?v=4e0fRKHG7Hk' }),
      expect.anything(),
    );
  });

  it.each(['https://x.com is down', 'http server rust', 'HTTP/2', 'https://', 'www.'])(
    'searches %j as typed, with no rewrite notice',
    async (query) => {
      mockSearch.mockResolvedValue(algoliaResponse({ hits: [storyHit], nbHits: 1, nbPages: 1 }));

      const result = await callSearch({ query });
      const sc = structured(result);

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query }),
        expect.anything(),
      );
      expect(sc.query).toBe(query);
      expect(sc).not.toHaveProperty('notice');
    },
  );

  it('adds the fragment and tracking-parameter hint to a zero-hit first page, after the page state', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const result = await callSearch({
      query: 'https://paulgraham.com/greatwork.html#notes',
      tags: 'story',
    });
    const notice = structured(result).notice as string;

    expect(notice).toBe(
      joined(
        'Try broader keywords, or relax these filters: tags.',
        droppedSentence('https://'),
        FRAGMENTS_SENTENCE,
      ),
    );
    expect(contentText(result)).toContain(notice);
  });

  it('leaves the fragment hint off a zero-hit first page of a query searched as typed', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const notice = structured(await callSearch({ query: 'paulgraham.com/greatwork.html#notes' }))
      .notice as string;

    expect(notice).toBe('Try broader keywords or different terms.');
  });

  it('puts next-page guidance before the rewrite disclosure', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: greatWorkHits.slice(0, 3), nbHits: 11, nbPages: 4, page: 0 }),
    );

    const sc = structured(
      await callSearch({ query: 'https://www.paulgraham.com/greatwork.html', count: 3 }),
    );
    const notice = sc.notice as string;

    expect(sc).toMatchObject({ truncated: true, shown: 3, cap: 3 });
    expect(notice).toBe(
      joined(
        'Showing 3 of 11 hits (page 0 of 4). Pass page: 1 for more, or raise count (max 50).',
        droppedSentence('https://www.'),
      ),
    );
  });

  it('discloses the rewrite on a page past the end, after the page state', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ nbHits: 11, nbPages: 1, page: 3 }));

    const notice = structured(
      await callSearch({ query: 'www.paulgraham.com/greatwork.html', page: 3 }),
    ).notice as string;

    expect(notice).toBe(
      joined(
        'Page 3 is past the last page of results (11 hits across 1 page). Pass page: 0 for that page.',
        droppedSentence('www.'),
      ),
    );
  });

  it('describes the URL rewrite on the query input and output', () => {
    const description = inputProperty('query').description!;
    expect(description).toMatch(/URL alone/);
    expect(description).toMatch(/http:\/\/, https:\/\/, or www\./);
    const output = (searchHn.output.shape.query as z.ZodType).description!;
    expect(output).toMatch(/scheme/);
  });
});

// ---------------------------------------------------------------------------
// #39 — author matches HN's exact casing
// ---------------------------------------------------------------------------

describe('hn_search_content author casing', () => {
  const CASE_CLAUSE = /author must match the username's exact HN casing/;

  it.each([
    [
      'a keyword search',
      { author: 'animats', query: 'rust' },
      'Try broader keywords, or relax these filters: author.',
    ],
    [
      'a filter-only search',
      { author: 'animats', tags: 'story' },
      'No items matched these filters: tags, author. Relax or change them.',
    ],
  ])(
    'adds the case clause after the relax text on an empty first page of %s',
    async (_label, input, relax) => {
      mockSearch.mockResolvedValue(algoliaResponse());

      const result = await callSearch(input);
      const notice = structured(result).notice as string;

      expect(notice).toBe(joined(relax, AUTHOR_CASE_SENTENCE));
      expect(contentText(result)).toContain(notice);
    },
  );

  it('sends author as typed, with no case folding and one upstream call', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    await callSearch({ author: 'animats', query: 'rust' });

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ author: 'animats' }),
      expect.anything(),
    );
  });

  it('leaves the clause off a zero-hit search without author', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const notice = structured(await callSearch({ query: 'rust', tags: 'story' })).notice as string;

    expect(notice).not.toMatch(CASE_CLAUSE);
  });

  it('leaves the clause off a page past the end', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ nbHits: 9, nbPages: 2, page: 2 }));

    const notice = structured(await callSearch({ author: 'animats', query: 'rust', page: 2 }))
      .notice as string;

    expect(notice.startsWith('Page 2 is past the last page of results')).toBe(true);
    expect(notice).not.toMatch(CASE_CLAUSE);
  });

  it('leaves the clause off a non-empty page', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [{ ...storyHit, author: 'Animats' }], nbHits: 1, nbPages: 1 }),
    );

    const sc = structured(await callSearch({ author: 'Animats', query: 'rust' }));

    expect(sc).not.toHaveProperty('notice');
  });

  it('describes author matching as exact and case-sensitive, without the stale hn_get_user aside', () => {
    const description = inputProperty('author').description!;
    expect(description).toMatch(/case-sensitive/i);
    expect(description).toMatch(/exact/i);
    expect(description).not.toMatch(/only shows recent submissions/);
  });
});

// ---------------------------------------------------------------------------
// #40 — front_page is the current front page only
// ---------------------------------------------------------------------------

describe('hn_search_content front_page scope', () => {
  const pageOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...storyHit, objectID: String(50_124_730 + i) }));

  it('describes front_page as the current front page, with the story proxy', () => {
    const description = inputProperty('tags').description!;
    expect(description).toMatch(/front page right now/);
    expect(description).toMatch(/about 30/);
    expect(description).toMatch(/no filter selects/i);
    expect(description).toContain('"story" with dateRange and minPoints');
  });

  it.each([
    [
      'a filter-only search with dateRange',
      { tags: 'front_page', dateRange: { start: '2020-01-01', end: '2020-01-02' } },
      'No items matched these filters: tags, dateRange. Relax or change them.',
    ],
    [
      'a keyword search',
      { query: 'paulgraham.com/greatwork.html', tags: 'front_page' },
      'Try broader keywords, or relax these filters: tags.',
    ],
  ])(
    'adds the front_page sentence after the relax text on an empty first page of %s',
    async (_label, input, relax) => {
      mockSearch.mockResolvedValue(algoliaResponse());

      const result = await callSearch(input);
      const notice = structured(result).notice as string;

      expect(notice).toBe(joined(relax, FRONT_PAGE_SENTENCE));
      expect(contentText(result)).toContain(notice);
    },
  );

  it('adds the front_page sentence to a non-empty last page when dateRange is set', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: pageOf(3), nbHits: 3, nbPages: 1 }));

    const result = await callSearch({
      tags: 'front_page',
      dateRange: { start: '2026-10-15', end: '2026-10-17' },
      count: 50,
    });
    const notice = structured(result).notice as string;

    expect(notice).toBe(FRONT_PAGE_SENTENCE);
    expect(contentText(result)).toContain(notice);
  });

  it('puts next-page guidance before the front_page sentence', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: pageOf(5), nbHits: 12, nbPages: 3 }));

    const sc = structured(
      await callSearch({ tags: 'front_page', dateRange: { start: '2026-10-01' }, count: 5 }),
    );
    const notice = sc.notice as string;

    expect(sc).toMatchObject({ truncated: true, shown: 5, cap: 5 });
    expect(notice).toBe(
      joined(
        'Showing 5 of 12 hits (page 0 of 3). Pass page: 1 for more, or raise count (max 50).',
        FRONT_PAGE_SENTENCE,
      ),
    );
  });

  it.each([
    ['bare front_page', { tags: 'front_page', count: 50 }],
    ['front_page with minPoints', { tags: 'front_page', minPoints: 300, count: 50 }],
  ])('leaves %s with no notice', async (_label, input) => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: pageOf(30), nbHits: 30, nbPages: 1 }));

    const sc = structured(await callSearch(input));

    expect(sc).not.toHaveProperty('notice');
  });

  it('keeps the zero-hit notice of other tags unchanged', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const notice = structured(
      await callSearch({ tags: 'story', dateRange: { start: '2020-01-01', end: '2020-01-02' } }),
    ).notice;

    expect(notice).toBe('No items matched these filters: tags, dateRange. Relax or change them.');
  });
});

// ---------------------------------------------------------------------------
// #35 — applied search criteria
// ---------------------------------------------------------------------------

describe('hn_search_content applied criteria', () => {
  const criteriaOf = (result: ToolResult) =>
    structured(result).criteria as Record<string, unknown> & {
      dateRange?: { start?: string; end?: string };
    };

  /** The params object the handler handed to hn.search on its one call. */
  const sentParams = () => mockSearch.mock.calls[0]![0] as Record<string, unknown>;

  it('echoes the filters, sort, count, and view sent, on both surfaces', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [commentHit, commentHit], nbHits: 299, nbPages: 150 }),
    );

    const result = await callSearch({
      author: 'dang',
      tags: 'comment',
      sort: 'date',
      dateRange: { start: '2026-09-01', end: '2026-10-01' },
      count: 2,
    });

    expect(criteriaOf(result)).toStrictEqual({
      tags: 'comment',
      author: 'dang',
      dateRange: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
      sort: 'date',
      count: 2,
      view: 'full',
    });
    expect(contentText(result)).toContain(
      '**criteria:** tags: comment | author: "dang" | dateRange: after 2026-09-01T00:00:00Z, before 2026-10-01T00:00:00Z | sort: date | count: 2 | view: full',
    );
  });

  it('echoes the defaults of omitted inputs and leaves unset filters out', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [storyHit], nbHits: 1, nbPages: 1 }));

    const result = await callSearch({ query: 'rust' });
    const criteria = criteriaOf(result);

    expect(Object.keys(criteria)).toEqual(['sort', 'count', 'view']);
    expect(criteria).toStrictEqual({ sort: 'relevance', count: 30, view: 'full' });
    expect(contentText(result)).toContain('**criteria:** sort: relevance | count: 30 | view: full');
  });

  it('echoes storyId and minPoints, and every value matches the params sent', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [storyHit], nbHits: 1, nbPages: 1 }));

    const result = await callSearch({
      query: 'rust',
      tags: 'poll',
      author: 'pg',
      storyId: 8863,
      minPoints: 10,
      sort: 'relevance',
      count: 7,
      view: 'compact',
    });
    const criteria = criteriaOf(result);
    const sent = sentParams();

    expect(criteria).toStrictEqual({
      tags: 'poll',
      author: 'pg',
      storyId: 8863,
      minPoints: 10,
      sort: 'relevance',
      count: 7,
      view: 'compact',
    });
    for (const key of ['tags', 'author', 'storyId', 'minPoints', 'sort', 'count', 'view']) {
      expect(criteria[key]).toBe(sent[key]);
    }
    expect(contentText(result)).toContain(
      '**criteria:** tags: poll | author: "pg" | storyId: 8863 | minPoints: 10 | sort: relevance | count: 7 | view: compact',
    );
  });

  const defaults = { sort: 'relevance', count: 30, view: 'full' };
  const defaultsLine = 'sort: relevance | count: 30 | view: full';

  it.each([
    [
      'a non-empty page',
      { query: 'rust' },
      { hits: [storyHit], nbHits: 1, nbPages: 1 },
      defaults,
      defaultsLine,
    ],
    ['an empty first page', { query: 'zzz' }, {}, defaults, defaultsLine],
    [
      'a page past the end',
      { query: 'rust', page: 4 },
      { nbHits: 3, nbPages: 1, page: 4 },
      defaults,
      defaultsLine,
    ],
    [
      'a page past the 1,000-hit ceiling',
      { tags: 'story', page: 40 },
      { nbHits: 0, nbPages: 0, page: 40 },
      { tags: 'story', ...defaults },
      `tags: story | ${defaultsLine}`,
    ],
  ])('sets criteria on %s', async (_label, input, response, criteria, line) => {
    mockSearch.mockResolvedValue(algoliaResponse(response));

    const result = await callSearch(input);

    expect(criteriaOf(result)).toStrictEqual(criteria);
    expect(contentText(result).split('\n')).toContain(`**criteria:** ${line}`);
  });

  it('leaves criteria off a call the handler rejects', async () => {
    const result = await callSearch({ tags: 'comment', minPoints: 5 });

    expect(wireError(result).data?.reason).toBe('min_points_unscored_type');
    expect(result.structuredContent).not.toHaveProperty('criteria');
    expect(contentText(result)).not.toContain('criteria');
  });

  it('leaves criteria off a call the upstream fails', async () => {
    mockSearch.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Algolia answered 503.', {
        reason: 'upstream_unavailable',
      }),
    );

    const result = await callSearch({ query: 'rust', author: 'dang' });

    expect(wireError(result).data?.reason).toBe('upstream_unavailable');
    expect(result.structuredContent).not.toHaveProperty('criteria');
    expect(contentText(result)).not.toContain('criteria');
  });

  it('echoes author trimmed, as matched', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const result = await callSearch({ author: ' dang ' });

    expect(criteriaOf(result).author).toBe('dang');
    expect(sentParams().author).toBe('dang');
  });

  it.each([
    [{ start: '2024-05-05T10:00:00+02:00' }, { start: '2024-05-05T08:00:00Z' }],
    [{ end: '2024-05-05T10:00:00.5Z' }, { end: '2024-05-05T10:00:01Z' }],
    [{ start: '2024' }, { start: '2024-01-01T00:00:00Z' }],
    [{ start: '2024-05-05T10:00' }, { start: '2024-05-05T10:00:00Z' }],
    [
      { start: '2024-05-05T10:00:00.5Z', end: '2024-05-06' },
      { start: '2024-05-05T10:00:00Z', end: '2024-05-06T00:00:00Z' },
    ],
  ])('echoes dateRange %j as the whole-second UTC bounds sent', async (dateRange, expected) => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const result = await callSearch({ dateRange });

    expect(criteriaOf(result).dateRange).toStrictEqual(expected);
  });

  it('renders a one-sided dateRange with only its own bound', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const text = contentText(await callSearch({ dateRange: { end: '2024-05-06' } }));

    expect(text).toContain(
      '**criteria:** dateRange: before 2024-05-06T00:00:00Z | sort: relevance',
    );
    expect(text).not.toContain('dateRange: after');
  });

  it('keeps the rewritten URL query in query, out of criteria', async () => {
    mockSearch.mockResolvedValue(algoliaResponse({ hits: [storyHit], nbHits: 1, nbPages: 1 }));

    const sc = structured(await callSearch({ query: 'https://www.example.com/a' }));

    expect(sc.query).toBe('example.com/a');
    expect(sc.criteria).not.toHaveProperty('query');
  });

  it('escapes author in content[] and keeps it raw in structuredContent', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());
    const author = 'mallory"\n## Injected **bold** `x`';

    const result = await callSearch({ author });
    const text = contentText(result);

    expect(criteriaOf(result).author).toBe(author);
    expect(text).toContain(
      '**criteria:** author: "mallory\\" ## Injected \\*\\*bold\\*\\* \\`x\\`" | sort: relevance',
    );
    expect(text).not.toMatch(/^## Injected/m);
  });

  it.each([
    ['with hits', { hits: [storyHit], nbHits: 1, nbPages: 1 }, '## "x\\" ## y" — search results'],
    ['without hits', {}, '"x\\" ## y" — no results.'],
  ])(
    'escapes the query heading %s so a line break cannot open a heading',
    async (_l, response, heading) => {
      mockSearch.mockResolvedValue(algoliaResponse(response));

      const result = await callSearch({ query: 'x"\n## y' });
      const text = contentText(result);

      expect(structured(result).query).toBe('x"\n## y');
      expect(text.startsWith(heading)).toBe(true);
      expect(text).not.toMatch(/^## y/m);
    },
  );

  it('describes criteria as the values sent, defaults included', () => {
    const description = searchHn.enrichment!.criteria!.description!;

    expect(description).toMatch(/sent/);
    expect(description).toMatch(/default/i);
  });

  it('describes cap as the count served, not the per-call cap', () => {
    expect(searchHn.enrichment!.cap!.description).toBe(
      'The count value served: as passed, or 50 when count was above that cap.',
    );
  });
});

// ---------------------------------------------------------------------------
// #41 — hit types, poll options, and job bodies
// ---------------------------------------------------------------------------

describe('hn_search_content hit types', () => {
  /** Algolia records captured live: an Ask HN story and an option of poll 3746692, both by GreekOphion. */
  const askHnHit = {
    _tags: ['story', 'author_GreekOphion', 'story_3747180', 'ask_hn'],
    author: 'GreekOphion',
    created_at: '2012-03-23T20:42:49Z',
    created_at_i: 1332535369,
    num_comments: 0,
    objectID: '3747180',
    points: 2,
    story_id: 3747180,
    story_text: 'When I click on my name it tells me how much karma I have but not my average.',
    title: "Ask HN: Why Isn't My Average Calculated?",
    url: '',
  };
  const pollOptionHit = {
    _tags: ['pollopt', 'author_GreekOphion'],
    author: 'GreekOphion',
    created_at: '2012-03-23T19:19:37Z',
    created_at_i: 1332530377,
    objectID: '3746728',
    points: 193,
  };
  /** An older poll option whose `story_` tag names the option itself, not its poll 2595605. */
  const selfTaggedOptionHit = {
    _tags: ['pollopt', 'author_pg', 'story_2595606'],
    author: 'pg',
    created_at: '2011-05-29T01:13:53Z',
    created_at_i: 1306631633,
    objectID: '2595606',
    points: 2743,
  };
  const pollHit = {
    _tags: ['poll', 'author_jv22222'],
    author: 'jv22222',
    created_at: '2026-10-07T01:20:57Z',
    created_at_i: 1791336057,
    num_comments: 8,
    objectID: '49986710',
    points: 6,
    title: 'Poll HN: Is there a skill to coding with AI?',
  };
  const JOB_TEXT =
    'Quill | Fullstack SWE | Full-time | Remote<p>A fullstack SDK for customer-facing analytics.';
  /** A job record: its body arrives as job_text, and only the title is searched and highlighted. */
  const jobHit = {
    _tags: ['job', 'author_R_R'],
    author: 'R_R',
    created_at: '2026-09-01T17:00:14Z',
    created_at_i: 1788282014,
    job_text: JOB_TEXT,
    objectID: '49524704',
    title: 'Quill (YC W20) Is Hiring a Fullstack SWE',
    _highlightResult: {
      author: { matchLevel: 'none' as const, matchedWords: [], value: 'R_R' },
      title: {
        matchLevel: 'full' as const,
        matchedWords: ['quill', 'fullstack'],
        value: '<em>Quill</em> (YC W20) Is Hiring a <em>Fullstack</em> SWE',
      },
    },
  };
  const taggedComment = { ...commentHit, _tags: ['comment', 'author_bob', 'story_123'] };

  const hitsOf = async (hits: unknown[], input: Record<string, unknown> = { tags: 'story' }) => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: hits as never, nbHits: hits.length, nbPages: 1 }),
    );
    const result = await callSearch(input);
    return {
      hits: structured(result).hits as Array<Record<string, unknown>>,
      text: contentText(result),
    };
  };

  it.each([
    ['story', ['story', 'author_a', 'story_1'], 'story'],
    ['ask_hn', ['story', 'author_a', 'story_1', 'ask_hn'], 'story'],
    ['show_hn ahead of story', ['show_hn', 'story', 'author_a', 'story_1'], 'story'],
    ['front_page ahead of story', ['front_page', 'author_a', 'story', 'story_1'], 'story'],
    ['comment', ['comment', 'author_a', 'story_9'], 'comment'],
    ['poll', ['poll', 'author_a'], 'poll'],
    ['pollopt', ['pollopt', 'author_a'], 'pollopt'],
    ['pollopt with a story_ tag', ['pollopt', 'author_pg', 'story_2595606'], 'pollopt'],
    ['job', ['job', 'author_a'], 'job'],
  ])('reads type from the first type tag: %s', async (_label, _tags, type) => {
    const { hits } = await hitsOf([{ ...storyHit, _tags }]);

    expect(hits[0]!.type).toBe(type);
  });

  it.each([
    ['no _tags', {}],
    ['empty _tags', { _tags: [] }],
    ['_tags without a type tag', { _tags: ['author_a', 'story_5', 'ask_hn'] }],
  ])('leaves type absent for %s, and renders as before', async (_label, tags) => {
    const { hits, text } = await hitsOf([{ ...commentHit, ...tags }]);

    expect(hits[0]).not.toHaveProperty('type');
    expect(text).toContain('### Comment on "Test Story" (story id:123)\nid:456 | bob | 5 pts |');
    expect(text).not.toContain('type:');
  });

  it('types an untagged search of GreekOphion as a story and a poll option, with no storyId on the option', async () => {
    const { hits } = await hitsOf([askHnHit, pollOptionHit], {
      author: 'GreekOphion',
      dateRange: { start: '2012-03-23', end: '2012-03-24' },
      sort: 'date',
    });

    expect(hits[0]).toMatchObject({ id: 3747180, type: 'story', storyId: 3747180 });
    expect(hits[1]).toMatchObject({ id: 3746728, type: 'pollopt', points: 193 });
    expect(hits[1]!.storyId).toBeUndefined();
  });

  it('keeps a poll option whose story_ tag is its own id a parentless poll option', async () => {
    const { hits, text } = await hitsOf([selfTaggedOptionHit], { author: 'pg' });

    expect(hits[0]!.type).toBe('pollopt');
    expect(hits[0]!.storyId).toBeUndefined();
    expect(text).not.toContain('story id:2595606');
  });

  it('gives a poll option its own heading that points to hn_get_thread', async () => {
    const { text } = await hitsOf([pollOptionHit], { author: 'GreekOphion' });

    expect(text).toContain(
      [
        '### Poll option by GreekOphion',
        'id:3746728 | type:pollopt | GreekOphion | 193 pts | 2012-03-23T19:19:37Z',
        'Option text and its poll: hn_get_thread with itemId 3746728',
      ].join('\n'),
    );
    expect(text).not.toContain('Comment on');
  });

  it('puts type:<type> after the id in the meta line of every typed hit', async () => {
    const { text } = await hitsOf([askHnHit, taggedComment, pollHit, jobHit, pollOptionHit], {
      author: 'x',
    });

    expect(text).toContain(
      "### Ask HN: Why Isn't My Average Calculated?\nid:3747180 | type:story | GreekOphion | 2 pts | 0 comments | 2012-03-23T20:42:49Z",
    );
    expect(text).toContain(
      '### Comment on "Test Story" (story id:123)\nid:456 | type:comment | bob | 5 pts | 2024-01-02T00:00:00Z',
    );
    expect(text).toContain(
      '### Poll HN: Is there a skill to coding with AI?\nid:49986710 | type:poll | jv22222 | 6 pts | 8 comments | 2026-10-07T01:20:57Z',
    );
    expect(text).toContain(
      '### Quill (YC W20) Is Hiring a Fullstack SWE\nid:49524704 | type:job | R_R | 2026-09-01T17:00:14Z',
    );
    expect(text).toContain('### Poll option by GreekOphion\nid:3746728 | type:pollopt |');
  });

  it('falls back to job_text for a job body, after comment_text and story_text', async () => {
    const { hits, text } = await hitsOf([jobHit], { query: 'Quill Fullstack', tags: 'job' });

    expect(vi.mocked(stripHtml)).toHaveBeenCalledWith(JOB_TEXT);
    expect(hits[0]!.text).toBe(JOB_TEXT);
    expect(text).toContain(`\n> ${JOB_TEXT}`);
  });

  it('prefers comment_text, then story_text, over job_text', async () => {
    const { hits } = await hitsOf([
      { ...jobHit, comment_text: 'comment body', story_text: 'story body' },
      { ...jobHit, objectID: '2', story_text: 'story body' },
    ]);

    expect(hits.map((h) => h.text)).toEqual(['comment body', 'story body']);
  });

  it('leaves highlights.text to comment_text and story_text — Algolia does not highlight job_text', async () => {
    const { hits } = await hitsOf([jobHit], { query: 'Quill Fullstack', tags: 'job' });

    expect(hits[0]!.highlights).toStrictEqual({
      title: '<em>Quill</em> (YC W20) Is Hiring a <em>Fullstack</em> SWE',
      matchedWords: ['quill', 'fullstack'],
    });
  });

  it('omits the job body from both surfaces under view "compact"', async () => {
    const { hits, text } = await hitsOf([jobHit], {
      query: 'Quill Fullstack',
      tags: 'job',
      view: 'compact',
    });

    expect(hits[0]!.text).toBeUndefined();
    expect(hits[0]!.type).toBe('job');
    expect(text).not.toContain('analytics');
  });

  it('declares type as an optional enum of the five item types, and describes job bodies as not searched', () => {
    interface HitSchema {
      properties: Record<string, SchemaNode & { enum?: string[] }>;
      required: string[];
    }
    const output = z.toJSONSchema(searchHn.output) as unknown as {
      properties: { hits: { items: HitSchema } };
    };
    const hit = output.properties.hits.items;

    expect(hit.properties.type?.enum).toEqual(['story', 'comment', 'poll', 'pollopt', 'job']);
    expect(hit.required).not.toContain('type');
    expect(hit.properties.text?.description).toMatch(/job/);
    expect(hit.properties.text?.description).toMatch(/not keyword-searched/);
  });

  it('says untagged searches include poll options, and where a poll hit finds its discussion root', () => {
    expect(inputProperty('tags').description).toMatch(/poll options/);
    const storyId = inputProperty('storyId').description!;
    expect(storyId).toMatch(/poll hit/);
    expect(storyId).toContain('item.storyId');
  });

  it('names poll hits and item.storyId in the zero-hit storyId hint', async () => {
    mockSearch.mockResolvedValue(algoliaResponse());

    const notice = structured(await callSearch({ storyId: 9707, tags: 'comment' })).notice;

    expect(notice).toBe(
      joined(
        'No items matched these filters: tags, storyId. Relax or change them.',
        STORY_ID_SENTENCE,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// #45 — count above the per-call cap is served at the cap, not rejected
// ---------------------------------------------------------------------------

describe('hn_search_content count above the per-call cap', () => {
  const pageOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...storyHit, objectID: String(i + 1) }));

  /** The params object the handler handed to hn.search on its one call. */
  const sentParams = () => mockSearch.mock.calls[0]![0] as Record<string, unknown>;

  it('serves count: 100 on page 0 as one page of 50, naming count: 50 for the next page', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: pageOf(50), nbHits: 600, nbPages: 12, page: 0, hitsPerPage: 50 }),
    );

    const result = await callSearch({ query: 'rust', count: 100 });
    const sc = structured(result);

    expect(sentParams()).toMatchObject({ count: 50, page: 0 });
    expect(sc.hits).toHaveLength(50);
    expect(sc).toMatchObject({ page: 0, totalPages: 12, truncated: true, shown: 50, cap: 50 });
    expect(sc.criteria).toMatchObject({ count: 50 });
    expect(sc.notice).toBe(
      'Showing 50 of 600 hits (page 0 of 12). Pass count: 50, page: 1 for more. count 100 is above the per-call cap of 50, so this call served count: 50.',
    );
    const text = contentText(result);
    expect(text).toContain(sc.notice as string);
    expect(text).toContain('count: 50 | view: full');
  });

  it('serves {count: 100, page: 2} as hits 200–249 (page 4 at count 50), never hits 100–149', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: pageOf(50), nbHits: 600, nbPages: 12, page: 4, hitsPerPage: 50 }),
    );

    const result = await callSearch({ query: 'rust', count: 100, page: 2 });
    const sc = structured(result);

    expect(sentParams()).toMatchObject({ count: 50, page: 4 });
    expect(sc).toMatchObject({ page: 4, totalPages: 12, shown: 50, cap: 50 });
    expect(sc.notice).toBe(
      'Showing 50 of 600 hits (page 4 of 12). Pass count: 50, page: 5 for more. count 100 is above the per-call cap of 50, so this call served count: 50. Page 2 at count 100 starts at the same hit as page 4 at count 50, the page served.',
    );
    expect(contentText(result)).toContain(sc.notice as string);
  });

  it('serves the 1,000 ceiling on page 0 at the cap', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: pageOf(50), nbHits: 600, nbPages: 12, page: 0, hitsPerPage: 50 }),
    );

    const sc = structured(await callSearch({ tags: 'story', count: 1000 }));

    expect(sentParams()).toMatchObject({ count: 50, page: 0 });
    expect(sc).toMatchObject({ shown: 50, cap: 50 });
    expect(sc.notice).toBe(
      'Showing 50 of 600 hits (page 0 of 12). Pass count: 50, page: 1 for more. count 1000 is above the per-call cap of 50, so this call served count: 50.',
    );
  });

  it('maps {count: 1000, page: 1} past the 1,000-hit ceiling and says which page it ran as', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [], nbHits: 0, nbPages: 0, page: 20, hitsPerPage: 50 }),
    );

    const result = await callSearch({ query: 'a', count: 1000, page: 1 });
    const sc = structured(result);

    expect(sentParams()).toMatchObject({ count: 50, page: 20 });
    expect(sc).not.toHaveProperty('truncated');
    expect(sc.notice).toBe(
      'Page 20 is past the last page Algolia serves for this search (at most 1,000 hits per search), where totalHits and totalPages read 0. Pass page: 0 to start over; if that also returns nothing, the search itself matches nothing. count 1000 is above the per-call cap of 50, so this call served count: 50. Page 1 at count 1000 starts at the same hit as page 20 at count 50, the page served.',
    );
  });

  it('names count: 50 with the last valid page when the mapped page is past the end', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [], nbHits: 120, nbPages: 3, page: 6, hitsPerPage: 50 }),
    );

    const sc = structured(await callSearch({ query: 'lisp', count: 100, page: 3 }));

    expect(sentParams()).toMatchObject({ count: 50, page: 6 });
    expect(sc.notice).toBe(
      'Page 6 is past the last page of results (120 hits across 3 pages). Pass count: 50, page: 2 for the last page, or page: 0 to start over. count 100 is above the per-call cap of 50, so this call served count: 50. Page 3 at count 100 starts at the same hit as page 6 at count 50, the page served.',
    );
  });

  it('names one lever when the mapped page is past the end of a one-page search', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: [], nbHits: 30, nbPages: 1, page: 2, hitsPerPage: 50 }),
    );

    const result = await callSearch({ query: 'lisp', count: 100, page: 1 });
    const sc = structured(result);

    expect(sentParams()).toMatchObject({ count: 50, page: 2 });
    expect(sc.notice).toBe(
      'Page 2 is past the last page of results (30 hits across 1 page). Pass count: 50, page: 0 for that page. count 100 is above the per-call cap of 50, so this call served count: 50. Page 1 at count 100 starts at the same hit as page 2 at count 50, the page served.',
    );
    expect(contentText(result)).toContain(sc.notice as string);
  });

  it('adds nothing on page 0 when the served page already holds every hit', async () => {
    mockSearch.mockResolvedValue(
      algoliaResponse({ hits: pageOf(30), nbHits: 30, nbPages: 1, page: 0, hitsPerPage: 50 }),
    );

    const sc = structured(await callSearch({ query: 'rust', count: 100 }));

    expect(sentParams()).toMatchObject({ count: 50, page: 0 });
    expect(sc.hits).toHaveLength(30);
    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('shown');
    expect(sc).not.toHaveProperty('cap');
    expect(sc).not.toHaveProperty('notice');
  });

  it('rejects count above the 1,000 ceiling before any upstream call', async () => {
    const result = await callSearch({ query: 'rust', count: 1001 });
    const error = wireError(result);

    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data).toMatchObject({
      reason: 'invalid_arguments',
      issues: [{ path: ['count'], code: 'too_big', maximum: 1000 }],
    });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it.each([
    [75, 1, 75, 'Pass count: 25, page: 3 to start at the same hit.'],
    [
      51,
      1,
      51,
      'Pass count: 17, page: 3 to start at the same hit, or count: 50, page: 1 for hits 50–99, which include hit 51.',
    ],
    [120, 3, 360, 'Pass count: 45, page: 8 to start at the same hit.'],
  ])(
    'rejects count %i with page %i, whose first hit %i starts no page of 50, naming a count and page that start there',
    async (count, page, firstHit, hint) => {
      const result = await callSearch({ query: 'rust', count, page });
      const error = wireError(result);

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('count_page_unaligned');
      expect(error.message).toBe(
        `count ${count} is above the per-call cap of 50, and page ${page} at count ${count} starts after ${firstHit} hits, where no page of 50 hits begins.`,
      );
      expect(error.data?.recovery?.hint).toBe(hint);
      expect(contentText(result)).toContain(hint);
      expect(mockSearch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [52, 1, 'Pass count: 26, page: 2 to start at the same hit.'],
    [
      69,
      1,
      'Pass count: 23, page: 3 to start at the same hit, or count: 50, page: 1 for hits 50–99, which include hit 69.',
    ],
    [
      53,
      1,
      'Pass count: 1, page: 53 to start at the same hit, or count: 50, page: 1 for hits 50–99, which include hit 53.',
    ],
    [
      997,
      1,
      'Pass count: 1, page: 997 to start at the same hit, or count: 50, page: 19 for hits 950–999, which include hit 997.',
    ],
  ])(
    'adds the page of 50 holding the first hit only when the count starting there is under 25 — count %i, page %i',
    async (count, page, hint) => {
      const result = await callSearch({ query: 'rust', count, page });
      const error = wireError(result);

      expect(error.data?.reason).toBe('count_page_unaligned');
      expect(error.data?.recovery?.hint).toBe(hint);
      expect(contentText(result)).toContain(hint);
    },
  );

  it('advertises the 1,000 ceiling and describes the per-call cap', () => {
    const count = inputProperty('count') as SchemaNode & { maximum?: number };
    expect(count.maximum).toBe(1000);
    expect(count.description).toBe(
      'Number of results to return, at most 50 per call. A larger value is served at 50: the search runs at count 50 from the hit where the requested page starts, and the notice names the count and page to pass next. With page above 0, that hit (page × count) must begin a page of 50 hits.',
    );
  });
});

describe('composeSearchNotice — over-cap count', () => {
  const overCapFacts = {
    query: 'example.com/a',
    droppedPrefix: 'https://www.',
    storyId: 8863,
    count: 50,
    overCap: { count: 100, page: 0 },
  };

  it('appends the over-cap sentence after every other cause', () => {
    const notice = composeSearchNotice({
      ...overCapFacts,
      shown: 50,
      page: 0,
      totalHits: 300,
      totalPages: 6,
    });

    expect(notice).toBe(
      joined(
        'Showing 50 of 300 hits (page 0 of 6). Pass count: 50, page: 1 for more.',
        droppedSentence('https://www.'),
        'count 100 is above the per-call cap of 50, so this call served count: 50.',
      ),
    );
  });

  it('leaves the over-cap sentence out of an empty first page, where the cap withheld nothing', () => {
    const notice = composeSearchNotice({
      ...overCapFacts,
      shown: 0,
      page: 0,
      totalHits: 0,
      totalPages: 0,
    });

    expect(notice).toBe(
      joined(
        'Try broader keywords, or relax these filters: storyId.',
        droppedSentence('https://www.'),
        FRAGMENTS_SENTENCE,
        STORY_ID_SENTENCE,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// #46 — the full view's 64,000-byte response budget
// ---------------------------------------------------------------------------

const BUDGET_BYTES = 64_000;

const HIGHLIGHTS_OMITTED_SENTENCE =
  'To stay within the 64,000-byte response budget, highlights.text is omitted from every hit; matchedWords still lists the matched terms.';

/** The budget sentence for a page whose step 2 cut `ids`, after step 1 dropped highlights.text when `omitted`. */
const cutSentence = (ids: number[], omitted = true) =>
  `To stay within the 64,000-byte response budget, ${omitted ? 'highlights.text is omitted from every hit and ' : ''}the text of ${ids.length === 1 ? 'hit' : 'hits'} ${ids.join(', ')} is cut short; hn_get_thread with a cut hit's id returns its full text, and view: "compact" or a smaller count avoids the cut.`;

/** The unquoted line content[] puts after a cut body. */
const cutLine = (id: number) =>
  `Text cut short to fit the response budget — hn_get_thread with itemId ${id} returns it whole.`;

describe('composeSearchNotice — response budget', () => {
  const page = { query: 'lisp', count: 30, shown: 4, page: 0, totalHits: 4, totalPages: 1 };

  it('says nothing about the budget on a page that fit', () => {
    expect(composeSearchNotice(page)).toBeUndefined();
  });

  it('names the omitted body highlights when only step 1 ran', () => {
    expect(
      composeSearchNotice({ ...page, budget: { highlightsTextOmitted: true, cutIds: [] } }),
    ).toBe(HIGHLIGHTS_OMITTED_SENTENCE);
  });

  it('names the cut hits and the levers after step 2', () => {
    expect(
      composeSearchNotice({ ...page, budget: { highlightsTextOmitted: true, cutIds: [7, 9] } }),
    ).toBe(cutSentence([7, 9]));
    expect(
      composeSearchNotice({ ...page, budget: { highlightsTextOmitted: false, cutIds: [7] } }),
    ).toBe(cutSentence([7], false));
  });

  it('comes after the page-state and cause sentences', () => {
    expect(
      composeSearchNotice({
        ...page,
        author: 'pg',
        count: 50,
        overCap: { count: 100, page: 0 },
        totalHits: 300,
        totalPages: 6,
        budget: { highlightsTextOmitted: true, cutIds: [5] },
      }),
    ).toBe(
      joined(
        'Showing 4 of 300 hits (page 0 of 6). Pass count: 50, page: 1 for more.',
        'count 100 is above the per-call cap of 50, so this call served count: 50.',
        cutSentence([5]),
      ),
    );
  });
});

describe('hn_search_content response budget', () => {
  const utf8 = new TextEncoder();
  const bytes = (text: string) => utf8.encode(text).byteLength;

  type WireHit = Record<string, any> & { id: number; text?: string; textTruncated?: boolean };

  /** Both surfaces of an assembled result, sized as the caller receives them; `sc` is the wire JSON. */
  function measure(result: ToolResult) {
    structured(result);
    const sc = JSON.parse(JSON.stringify(result.structuredContent)) as Record<string, any> & {
      hits: WireHit[];
    };
    const blocks = result.content.filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text',
    );
    return {
      sc,
      text: blocks.map((b) => b.text).join(''),
      contentBytes: blocks.reduce((sum, b) => sum + bytes(b.text), 0),
      structuredBytes: bytes(JSON.stringify(result.structuredContent)),
    };
  }

  /** A comment hit whose body matched the query, so Algolia repeats it in full as the highlight. */
  function matchedComment(id: number, text: string) {
    return {
      ...commentHit,
      objectID: String(id),
      comment_text: text,
      _tags: ['comment', 'author_bob', 'story_123'],
      _highlightResult: {
        comment_text: {
          value: text.replaceAll('lisp', '<em>lisp</em>'),
          matchLevel: 'full' as const,
          matchedWords: ['lisp'],
        },
        story_title: { value: 'Test Story', matchLevel: 'none' as const, matchedWords: [] },
      },
    };
  }

  /** A story hit whose title matched, with no body. */
  const titledStory = {
    ...storyHit,
    objectID: '900',
    title: 'Lisp in Small Pieces',
    _tags: ['story', 'author_alice', 'story_900'],
    _highlightResult: {
      title: {
        value: '<em>Lisp</em> in Small Pieces',
        matchLevel: 'full' as const,
        matchedWords: ['lisp'],
      },
    },
  };

  /** A body of `n` UTF-16 units that matches `lisp` once, at its start, so its highlight runs 9 bytes longer. */
  const body = (n: number, unit = 'macro ') =>
    `lisp ${unit.repeat(Math.ceil(n / unit.length))}`.slice(0, n);

  function servePage(hits: unknown[], overrides: Partial<AlgoliaResponse> = {}) {
    mockSearch.mockResolvedValue(
      algoliaResponse({
        hits: hits as AlgoliaResponse['hits'],
        nbHits: hits.length,
        nbPages: 1,
        ...overrides,
      }),
    );
  }

  it('leaves a page under budget as it was: whole bodies, body highlights, no flags, no budget sentence', async () => {
    const text = body(28_000);
    const highlighted = text.replace('lisp', '<em>lisp</em>');
    servePage([matchedComment(1, text)]);

    const {
      sc,
      text: rendered,
      contentBytes,
      structuredBytes,
    } = measure(await callSearch({ query: 'lisp' }));

    expect(contentBytes).toBeGreaterThan(56_000);
    expect(contentBytes).toBeLessThan(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThan(BUDGET_BYTES);
    expect(sc.hits).toStrictEqual([
      {
        id: 1,
        type: 'comment',
        author: 'bob',
        points: 5,
        createdAt: '2024-01-02T00:00:00Z',
        storyTitle: 'Test Story',
        storyId: 123,
        text,
        highlights: { text: highlighted, matchedWords: ['lisp'] },
      },
    ]);
    expect(sc).not.toHaveProperty('highlightsTextOmitted');
    expect(sc).not.toHaveProperty('notice');
    expect(rendered).toBe(
      [
        '## "lisp" — search results',
        '',
        '### Comment on "Test Story" (story id:123)',
        'id:1 | type:comment | bob | 5 pts | 2024-01-02T00:00:00Z',
        `> ${text}`,
        '',
        `> match — terms: lisp | body: ${highlighted}`,
        '',
        '**criteria:** sort: relevance | count: 30 | view: full',
        '**totalHits:** 1',
        '**page:** 0',
        '**totalPages:** 1',
      ].join('\n'),
    );
  });

  it('leaves compact pages unchanged, however long the bodies behind them', async () => {
    servePage([matchedComment(1, body(200_000)), matchedComment(2, body(90_000))]);

    const { sc, text } = measure(await callSearch({ query: 'lisp', view: 'compact' }));

    expect(sc.hits.map((h) => 'text' in h)).toStrictEqual([false, false]);
    expect(sc.hits.map((h) => h.highlights)).toStrictEqual([
      { matchedWords: ['lisp'] },
      { matchedWords: ['lisp'] },
    ]);
    expect(sc).not.toHaveProperty('highlightsTextOmitted');
    expect(sc).not.toHaveProperty('notice');
    expect(text).not.toContain('Text cut short');
  });

  it('drops highlights.text from every hit first, keeping matchedWords, the title highlight, and whole bodies', async () => {
    const long = body(40_000);
    const short = body(300);
    servePage([matchedComment(1, long), titledStory, matchedComment(2, short)]);

    const { sc, text, contentBytes, structuredBytes } = measure(
      await callSearch({ query: 'lisp' }),
    );

    expect(contentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(sc.highlightsTextOmitted).toBe(true);
    expect(sc.hits.map((h) => h.highlights)).toStrictEqual([
      { matchedWords: ['lisp'] },
      { title: '<em>Lisp</em> in Small Pieces', matchedWords: ['lisp'] },
      { matchedWords: ['lisp'] },
    ]);
    expect(sc.hits.map((h) => h.text)).toStrictEqual([long, undefined, short]);
    expect(sc.hits.some((h) => 'textTruncated' in h)).toBe(false);
    expect(sc.notice).toBe(HIGHLIGHTS_OMITTED_SENTENCE);

    expect(text).not.toContain('<em>lisp</em>');
    expect(text).not.toContain('Text cut short');
    expect(text).toContain(`\n> ${long}\n\n> match — terms: lisp\n\n`);
    expect(text).toContain('> match — title: <em>Lisp</em> in Small Pieces | terms: lisp');
    expect(text).toContain('**highlightsTextOmitted:** true');
    expect(text).toContain(`> ${HIGHLIGHTS_OMITTED_SENTENCE}`);
  });

  it('then cuts the longest bodies to one shared limit, the largest that fits, keeping every hit and the paging fields', async () => {
    const a = body(60_000);
    const b = body(45_000, 'lisp\nmacro\n\n[1]: x\n');
    const short = body(500);
    servePage(
      [matchedComment(11, a), titledStory, matchedComment(12, b), matchedComment(13, short)],
      { nbHits: 120, nbPages: 3 },
    );

    const { sc, text, contentBytes, structuredBytes } = measure(
      await callSearch({ query: 'lisp' }),
    );

    expect(contentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    /** One byte more for each cut body would not fit: the limit is the largest. */
    expect(Math.max(contentBytes, structuredBytes)).toBeGreaterThan(BUDGET_BYTES - 64);

    expect(sc.hits.map((h) => h.id)).toStrictEqual([11, 900, 12, 13]);
    expect(sc).toMatchObject({ page: 0, totalPages: 3, truncated: true, shown: 4, cap: 30 });
    expect(sc.highlightsTextOmitted).toBe(true);
    expect(sc.hits.every((h) => h.highlights?.text === undefined)).toBe(true);

    const [cutA, story, cutB, whole] = sc.hits;
    expect(a.startsWith(cutA!.text!)).toBe(true);
    expect(b.startsWith(cutB!.text!)).toBe(true);
    expect(bytes(cutA!.text!)).toBeLessThan(bytes(a));
    expect(bytes(cutA!.text!)).toBe(bytes(cutB!.text!));
    expect(bytes(cutA!.text!)).toBeGreaterThan(bytes(short));
    expect(cutA!.textTruncated).toBe(true);
    expect(cutB!.textTruncated).toBe(true);
    expect(whole!.text).toBe(short);
    expect(whole).not.toHaveProperty('textTruncated');
    expect(story).not.toHaveProperty('textTruncated');

    expect(sc.notice).toBe(
      joined(
        'Showing 4 of 120 hits (page 0 of 3). Pass page: 1 for more, or raise count (max 50).',
        cutSentence([11, 12]),
      ),
    );

    /** content[] carries the same cut prefix, quoted, then the unquoted pointer after a blank line. */
    expect(text).toContain(
      `\n${quoteBody(cutA!.text!)}\n\n${cutLine(11)}\n\n> match — terms: lisp\n\n`,
    );
    expect(text).toContain(
      `\n${quoteBody(cutB!.text!)}\n\n${cutLine(12)}\n\n> match — terms: lisp\n\n`,
    );
    expect(text).toContain(`\n> ${short}\n\n> match — terms: lisp\n\n`);
    expect(text).not.toContain(cutLine(13));
    expect(text).not.toContain(cutLine(900));
  });

  it('cuts a single hit larger than the budget to fit', async () => {
    const huge = body(300_000);
    servePage([matchedComment(5, huge)]);

    const { sc, text, contentBytes, structuredBytes } = measure(
      await callSearch({ query: 'lisp', count: 1 }),
    );

    expect(contentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(Math.max(contentBytes, structuredBytes)).toBeGreaterThan(BUDGET_BYTES - 64);
    expect(sc.hits[0]!.textTruncated).toBe(true);
    expect(huge.startsWith(sc.hits[0]!.text!)).toBe(true);
    expect(sc.notice).toBe(cutSentence([5]));
    expect(text).toContain(`\n\n${cutLine(5)}\n\n`);
  });

  it('cuts on a code-point boundary, identically on both surfaces', async () => {
    const emoji = `lisp ${'😀é'.repeat(25_000)}`;
    servePage([matchedComment(6, emoji)]);

    const { sc, text, contentBytes, structuredBytes } = measure(
      await callSearch({ query: 'lisp' }),
    );
    const cut = sc.hits[0]!.text!;

    expect(contentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(cut.length).toBeLessThan(emoji.length);
    expect(emoji.startsWith(cut)).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(text).toContain(`\n> ${cut}\n\n${cutLine(6)}`);
  });

  it('goes straight to cutting when no hit carries a body highlight, and claims no omission', async () => {
    servePage([{ ...commentHit, objectID: '8', comment_text: body(100_000) }]);

    const { sc, contentBytes, structuredBytes } = measure(
      await callSearch({ author: 'bob', tags: 'comment' }),
    );

    expect(contentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(sc).not.toHaveProperty('highlightsTextOmitted');
    expect(sc.hits[0]!.textTruncated).toBe(true);
    expect(sc.notice).toBe(cutSentence([8], false));
  });
});
