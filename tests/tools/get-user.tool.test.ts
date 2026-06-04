/**
 * @fileoverview Tests for the hn_get_user tool.
 * @module mcp-server/tools/definitions/get-user.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HnItem, HnUser } from '@/services/hn/types.js';

vi.mock('@/services/hn/hn-service.js', () => ({
  getHnService: vi.fn(),
  filterLiveItems: vi.fn((items: (HnItem | null)[]) =>
    items.filter((i): i is HnItem => i != null && !i.deleted && !i.dead),
  ),
  stripHtml: vi.fn((html: string) => html),
  normalizeUrl: vi.fn((url?: string) => url || undefined),
}));

import { getUser } from '@/mcp-server/tools/definitions/get-user.tool.js';
import { getHnService, stripHtml } from '@/services/hn/hn-service.js';

const mockFetchUser = vi.fn<(username: string) => Promise<HnUser | null>>();
const mockFetchItems = vi.fn<(ids: number[]) => Promise<(HnItem | null)[]>>();

const baseUser: HnUser = {
  id: 'testuser',
  karma: 500,
  created: 1600000000,
  about: '<p>Hello world</p>',
  submitted: [100, 101, 102],
};

const storyItem: HnItem = {
  id: 100,
  type: 'story',
  by: 'testuser',
  title: 'My Post',
  url: 'https://example.com',
  score: 10,
  time: 1600001000,
  descendants: 5,
};

const commentItem: HnItem = {
  id: 101,
  type: 'comment',
  by: 'testuser',
  text: 'Nice article',
  time: 1600002000,
};

const deadItem: HnItem = {
  id: 102,
  type: 'story',
  by: 'testuser',
  title: 'Dead Post',
  dead: true,
  time: 1600003000,
};

const deletedItem: HnItem = {
  id: 103,
  type: 'story',
  by: 'testuser',
  deleted: true,
  time: 1600004000,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(stripHtml).mockImplementation((html: string) => html);
  vi.mocked(getHnService).mockReturnValue({
    fetchUser: mockFetchUser,
    fetchItems: mockFetchItems,
  } as any);
});

function parse(overrides: Record<string, unknown> = {}) {
  return getUser.input.parse({ username: 'testuser', ...overrides });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('hn_get_user handler', () => {
  it('throws when user is not found', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(null);

    await expect(getUser.handler(parse(), ctx)).rejects.toThrow('User testuser not found');
  });

  it('returns basic profile without submissions', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(baseUser);

    const result = await getUser.handler(parse(), ctx);

    expect(result.user).toEqual({
      id: 'testuser',
      karma: 500,
      created: 1600000000,
      about: '<p>Hello world</p>',
      totalSubmissions: 3,
    });
    expect(result.submissions).toBeUndefined();
    expect(mockFetchItems).not.toHaveBeenCalled();
  });

  it('strips HTML from about text', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    vi.mocked(stripHtml).mockReturnValue('Hello world');
    mockFetchUser.mockResolvedValue(baseUser);

    const result = await getUser.handler(parse(), ctx);

    expect(stripHtml).toHaveBeenCalledWith('<p>Hello world</p>');
    expect(result.user.about).toBe('Hello world');
  });

  it('sets totalSubmissions to 0 when submitted is absent', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    const { submitted: _, ...userNoSubmitted } = baseUser;
    mockFetchUser.mockResolvedValue(userNoSubmitted);

    const result = await getUser.handler(parse(), ctx);

    expect(result.user.totalSubmissions).toBe(0);
  });

  it('fetches and returns submissions when includeSubmissions is true', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(baseUser);
    mockFetchItems.mockResolvedValue([storyItem, commentItem]);

    const result = await getUser.handler(parse({ includeSubmissions: true }), ctx);

    expect(mockFetchItems).toHaveBeenCalledWith([100, 101, 102], expect.anything());
    const subs = result.submissions;
    expect(subs).toHaveLength(2);
    expect(subs?.[0]).toMatchObject({ id: 100, type: 'story', title: 'My Post' });
    expect(subs?.[1]).toMatchObject({ id: 101, type: 'comment' });
  });

  it('limits fetched submissions to submissionCount', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(baseUser);
    mockFetchItems.mockResolvedValue([storyItem]);

    await getUser.handler(parse({ includeSubmissions: true, submissionCount: 1 }), ctx);

    expect(mockFetchItems).toHaveBeenCalledWith([100], expect.anything());
  });

  it('filters out dead and deleted submissions', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue({ ...baseUser, submitted: [100, 102, 103] });
    mockFetchItems.mockResolvedValue([storyItem, deadItem, deletedItem]);

    const result = await getUser.handler(parse({ includeSubmissions: true }), ctx);

    expect(result.submissions).toHaveLength(1);
    expect(result.submissions?.[0]?.id).toBe(100);
  });

  it('emits pagination notice when resolved submissions are fewer than total', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    // User has many submissions but we only resolve the default 10
    const prolificUser: HnUser = {
      ...baseUser,
      submitted: Array.from({ length: 100 }, (_, i) => i + 1),
    };
    mockFetchUser.mockResolvedValue(prolificUser);
    mockFetchItems.mockResolvedValue([storyItem, commentItem]);

    await getUser.handler(parse({ includeSubmissions: true, submissionCount: 10 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/Showing 2 of 100 submissions/);
    expect(enrichment.notice).toMatch(/Raise submissionCount \(max 50\)/);
  });

  it('does not emit notice when resolved submission count equals total', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    // User has 2 submissions and both resolve as live items — no truncation
    const smallUser: HnUser = { ...baseUser, submitted: [100, 101] };
    mockFetchUser.mockResolvedValue(smallUser);
    mockFetchItems.mockResolvedValue([storyItem, commentItem]);

    await getUser.handler(parse({ includeSubmissions: true, submissionCount: 10 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('does not emit notice when all submitted IDs were fetched but some were dead/deleted', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    // User has 3 submissions total, all fetched (submissionCount=10 > 3), but 2 are dead/deleted
    mockFetchUser.mockResolvedValue({ ...baseUser, submitted: [100, 102, 103] });
    mockFetchItems.mockResolvedValue([storyItem, deadItem, deletedItem]);

    await getUser.handler(parse({ includeSubmissions: true, submissionCount: 10 }), ctx);

    // submissions.length (1) < totalSubmissions (3) but we already fetched all IDs — not a pagination gap
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

describe('hn_get_user format', () => {
  it('renders id, karma, and join date', () => {
    const joined = new Date(1600000000 * 1000).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
    const blocks = getUser.format!({
      user: { id: 'pg', karma: 1000, created: 1600000000, totalSubmissions: 0 },
    });

    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('## pg');
    expect(text).toContain('**Karma:** 1000');
    expect(text).toContain(`**Joined:** ${joined}`);
    expect(text).toContain('**Total submissions:** 0');
  });

  it('includes about text when present', () => {
    const blocks = getUser.format!({
      user: {
        id: 'pg',
        karma: 1000,
        created: 1600000000,
        about: 'Essay writer',
        totalSubmissions: 0,
      },
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('Essay writer');
  });

  it('renders numbered submissions list', () => {
    const blocks = getUser.format!({
      user: { id: 'pg', karma: 1000, created: 1600000000, totalSubmissions: 2 },
      submissions: [
        { id: 1, type: 'story', title: 'First Post', score: 42, descendants: 10 },
        { id: 2, type: 'comment' },
      ],
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('### Recent submissions');
    expect(text).toContain('**First Post** — id:1 | story | 42 pts | 10 comments');
    expect(text).toMatch(/\*\*\[comment\]\*\* — id:2(?!\s*\|\s*comment)/);
  });

  it.each([
    { label: 'undefined title', submission: { id: 3, type: 'comment' as const } },
    { label: 'empty title', submission: { id: 3, type: 'comment' as const, title: '' } },
    { label: 'real title', submission: { id: 3, type: 'story' as const, title: 'Real' } },
  ])('always renders the item type exactly once ($label)', ({ submission }) => {
    const blocks = getUser.format!({
      user: { id: 'pg', karma: 1, created: 1600000000, totalSubmissions: 1 },
      submissions: [submission],
    });
    const text = (blocks[0] as { text: string }).text;
    const subLine = text.split('\n').find((l) => l.includes(`id:${submission.id}`))!;

    const occurrences = (subLine.match(new RegExp(`\\b${submission.type}\\b`, 'g')) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('hn_get_user input validation', () => {
  it('requires username', () => {
    expect(() => getUser.input.parse({})).toThrow();
  });

  it('rejects empty string username', () => {
    expect(() => getUser.input.parse({ username: '' })).toThrow();
  });

  it('defaults includeSubmissions to false', () => {
    const input = getUser.input.parse({ username: 'test' });
    expect(input.includeSubmissions).toBe(false);
  });

  it('defaults submissionCount to 10', () => {
    const input = getUser.input.parse({ username: 'test' });
    expect(input.submissionCount).toBe(10);
  });

  it('constrains submissionCount to 1-50', () => {
    expect(() => getUser.input.parse({ username: 'test', submissionCount: 0 })).toThrow();
    expect(() => getUser.input.parse({ username: 'test', submissionCount: 51 })).toThrow();
    expect(getUser.input.parse({ username: 'test', submissionCount: 1 }).submissionCount).toBe(1);
    expect(getUser.input.parse({ username: 'test', submissionCount: 50 }).submissionCount).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Security and edge cases
// ---------------------------------------------------------------------------

describe('hn_get_user — security and edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stripHtml).mockImplementation((html: string) => html);
    vi.mocked(getHnService).mockReturnValue({
      fetchUser: mockFetchUser,
      fetchItems: mockFetchItems,
    } as any);
  });

  it('does not expose env secrets in tool output or error messages', async () => {
    process.env.HN_CONCURRENCY_LIMIT = 'SECRET_ENV_SENTINEL';
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(null);

    try {
      await getUser.handler(parse(), ctx);
    } catch (err: unknown) {
      if (err instanceof Error) {
        expect(err.message).not.toContain('SECRET_ENV_SENTINEL');
      }
    }
    delete process.env.HN_CONCURRENCY_LIMIT;
  });

  it('handles user with no about field', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    const { about: _, ...userNoAbout } = baseUser;
    mockFetchUser.mockResolvedValue(userNoAbout);

    const result = await getUser.handler(parse(), ctx);

    expect(result.user.about).toBeUndefined();
  });

  it('does not fetch submissions when includeSubmissions is false even if user has submissions', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(baseUser);

    await getUser.handler(parse({ includeSubmissions: false }), ctx);

    expect(mockFetchItems).not.toHaveBeenCalled();
  });

  it('does not fetch submissions when user has no submitted array, even with includeSubmissions=true', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    const { submitted: _, ...userNoSubmissions } = baseUser;
    mockFetchUser.mockResolvedValue(userNoSubmissions);

    const result = await getUser.handler(parse({ includeSubmissions: true }), ctx);

    expect(mockFetchItems).not.toHaveBeenCalled();
    expect(result.submissions).toBeUndefined();
  });

  it('format() renders url and text for story submissions', () => {
    const blocks = getUser.format!({
      user: { id: 'alice', karma: 500, created: 1600000000, totalSubmissions: 1 },
      submissions: [
        {
          id: 1,
          type: 'story',
          title: 'My Article',
          url: 'https://example.com/article',
          score: 42,
          time: 1600001000,
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('https://example.com/article');
  });

  it('format() renders body text for Ask HN submissions', () => {
    const blocks = getUser.format!({
      user: { id: 'alice', karma: 500, created: 1600000000, totalSubmissions: 1 },
      submissions: [
        {
          id: 2,
          type: 'story',
          title: 'Ask HN: Best tool?',
          text: 'Looking for recommendations.',
          score: 10,
          time: 1600001000,
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Looking for recommendations.');
  });

  it('format() omits submissions section when submissions array is empty', () => {
    const blocks = getUser.format!({
      user: { id: 'alice', karma: 500, created: 1600000000, totalSubmissions: 0 },
      submissions: [],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Recent submissions');
  });

  it('format() renders a join date for the epoch', () => {
    /** Created at Unix 0 (1970-01-01) must not crash the date formatter. */
    const blocks = getUser.format!({
      user: { id: 'ancient', karma: 1, created: 0, totalSubmissions: 0 },
    });
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('ancient');
  });

  it('output schema accepts optional submissions', () => {
    const withoutSubmissions = { user: { id: 'u', karma: 1, created: 1, totalSubmissions: 0 } };
    expect(() => getUser.output.parse(withoutSubmissions)).not.toThrow();

    const withSubmissions = {
      user: { id: 'u', karma: 1, created: 1, totalSubmissions: 1 },
      submissions: [{ id: 1, type: 'story' }],
    };
    expect(() => getUser.output.parse(withSubmissions)).not.toThrow();
  });
});
