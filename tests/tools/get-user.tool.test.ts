/**
 * @fileoverview Tests for the hn_get_user tool.
 * @module mcp-server/tools/definitions/get-user.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HnItem, HnUser } from '@/services/hn/types.js';

/**
 * Only the accessor and the text helpers are faked. `settlePage` and
 * `HnService` stay real, so the partial-failure suite below runs the actual
 * service against a stubbed fetch.
 */
vi.mock('@/services/hn/hn-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/hn/hn-service.js')>()),
  getHnService: vi.fn(),
  stripHtml: vi.fn((html: string) => html),
  normalizeUrl: vi.fn((url?: string) => url || undefined),
}));

import { getUser } from '@/mcp-server/tools/definitions/get-user.tool.js';
import { getHnService, HnService, type ItemSlot, stripHtml } from '@/services/hn/hn-service.js';
import { httpStatus, rejectUnmockedFetch, stubHnApi } from '../helpers/hn-api-stub.js';

rejectUnmockedFetch();

const mockFetchUser = vi.fn<(username: string) => Promise<HnUser | null>>();
const mockFetchItems = vi.fn<(ids: number[]) => Promise<ItemSlot[]>>();

/** Wrap returned items as the batch slots `fetchItems` yields. */
function slotsOf(items: HnItem[]): ItemSlot[] {
  return items.map((item) => ({ kind: 'item', id: item.id, item }));
}

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
    mockFetchItems.mockResolvedValue(slotsOf([storyItem, commentItem]));

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
    mockFetchItems.mockResolvedValue(slotsOf([storyItem]));

    await getUser.handler(parse({ includeSubmissions: true, submissionCount: 1 }), ctx);

    expect(mockFetchItems).toHaveBeenCalledWith([100], expect.anything());
  });

  it('filters out dead and deleted submissions', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue({ ...baseUser, submitted: [100, 102, 103] });
    mockFetchItems.mockResolvedValue(slotsOf([storyItem, deadItem, deletedItem]));

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
    mockFetchItems.mockResolvedValue(slotsOf([storyItem, commentItem]));

    await getUser.handler(parse({ includeSubmissions: true, submissionCount: 10 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/positions 1–10 of 100 submissions/);
    expect(enrichment.notice).toMatch(/Set submissionOffset to 10 for the next page/);
  });

  it('does not emit notice when resolved submission count equals total', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    // User has 2 submissions and both resolve as live items — no truncation
    const smallUser: HnUser = { ...baseUser, submitted: [100, 101] };
    mockFetchUser.mockResolvedValue(smallUser);
    mockFetchItems.mockResolvedValue(slotsOf([storyItem, commentItem]));

    await getUser.handler(parse({ includeSubmissions: true, submissionCount: 10 }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('does not emit notice when all submitted IDs were fetched but some were dead/deleted', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    // User has 3 submissions total, all fetched (submissionCount=10 > 3), but 2 are dead/deleted
    mockFetchUser.mockResolvedValue({ ...baseUser, submitted: [100, 102, 103] });
    mockFetchItems.mockResolvedValue(slotsOf([storyItem, deadItem, deletedItem]));

    await getUser.handler(parse({ includeSubmissions: true, submissionCount: 10 }), ctx);

    // submissions.length (1) < totalSubmissions (3) but we already fetched all IDs — not a pagination gap
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Submission pagination (submissionOffset)
// ---------------------------------------------------------------------------

describe('hn_get_user submission pagination', () => {
  /** 25 submissions with IDs 201..225 — offset windows never overlap the first page. */
  const prolificUser: HnUser = {
    ...baseUser,
    submitted: Array.from({ length: 25 }, (_, i) => 201 + i),
  };

  function itemsFor(ids: number[]): ItemSlot[] {
    return slotsOf(ids.map((id) => ({ id, type: 'story', by: 'testuser', title: `Post ${id}` })));
  }

  it('resolves the first page from the start of the submitted list', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(prolificUser);
    mockFetchItems.mockResolvedValue(itemsFor([201, 202, 203]));

    const result = await getUser.handler(
      parse({ includeSubmissions: true, submissionCount: 3 }),
      ctx,
    );

    expect(mockFetchItems).toHaveBeenCalledWith([201, 202, 203], expect.anything());
    expect(result.submissions?.map((s) => s.id)).toEqual([201, 202, 203]);
    expect(getEnrichment(ctx).submissionOffset).toBe(0);
  });

  it('resolves a later page from the offset window, not the head of the list', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(prolificUser);
    mockFetchItems.mockResolvedValue(itemsFor([211, 212, 213]));

    const result = await getUser.handler(
      parse({ includeSubmissions: true, submissionCount: 3, submissionOffset: 10 }),
      ctx,
    );

    expect(mockFetchItems).toHaveBeenCalledWith([211, 212, 213], expect.anything());
    expect(result.submissions?.map((s) => s.id)).toEqual([211, 212, 213]);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.submissionOffset).toBe(10);
    expect(enrichment.notice).toMatch(/positions 11–13 of 25 submissions/);
    expect(enrichment.notice).toMatch(/Set submissionOffset to 13 for the next page/);
  });

  it('returns an empty page and a range warning when the offset is past the end', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(prolificUser);
    mockFetchItems.mockResolvedValue([]);

    const result = await getUser.handler(
      parse({ includeSubmissions: true, submissionCount: 3, submissionOffset: 100 }),
      ctx,
    );

    expect(mockFetchItems).toHaveBeenCalledWith([], expect.anything());
    expect(result.submissions).toEqual([]);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.submissionOffset).toBe(100);
    expect(enrichment.notice).toMatch(/submissionOffset 100 is past the end of 25 submissions/);
    expect(enrichment.notice).toMatch(/Valid offsets are 0 to 24/);
    expect(enrichment.truncated).toBeUndefined();
  });

  it('emits no next-page notice when the window reaches the end of the history', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(prolificUser);
    mockFetchItems.mockResolvedValue(itemsFor([221, 222, 223, 224, 225]));

    await getUser.handler(
      parse({ includeSubmissions: true, submissionCount: 5, submissionOffset: 20 }),
      ctx,
    );

    expect(mockFetchItems).toHaveBeenCalledWith([221, 222, 223, 224, 225], expect.anything());
    const enrichment = getEnrichment(ctx);
    expect(enrichment.submissionOffset).toBe(20);
    expect(enrichment.notice).toBeUndefined();
    expect(enrichment.truncated).toBeUndefined();
  });

  it('reports the live count when the offset window contains dead items', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(prolificUser);
    mockFetchItems.mockResolvedValue(
      slotsOf([
        { id: 206, type: 'story', title: 'Live' },
        { id: 207, type: 'story', dead: true },
        { id: 208, type: 'story', deleted: true },
      ]),
    );

    const result = await getUser.handler(
      parse({ includeSubmissions: true, submissionCount: 3, submissionOffset: 5 }),
      ctx,
    );

    expect(mockFetchItems).toHaveBeenCalledWith([206, 207, 208], expect.anything());
    expect(result.submissions?.map((s) => s.id)).toEqual([206]);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/Showing 1 live item from positions 6–8 of 25 submissions/);
    /** The next offset advances by the window, not the live count — otherwise dead items are re-fetched forever. */
    expect(enrichment.notice).toMatch(/Set submissionOffset to 8 for the next page/);
    expect(enrichment.shown).toBe(1);
    expect(enrichment.cap).toBe(3);
  });

  it('omits submissions and pagination enrichment for a user who has never submitted', async () => {
    const ctx = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue({ ...baseUser, submitted: [] });

    const result = await getUser.handler(parse({ includeSubmissions: true }), ctx);

    expect(mockFetchItems).not.toHaveBeenCalled();
    expect(result.submissions).toBeUndefined();
    expect(result.user.totalSubmissions).toBe(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.submissionOffset).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('echoes submissionOffset only when submissions were resolved', async () => {
    const skipped = createMockContext({ errors: getUser.errors });
    mockFetchUser.mockResolvedValue(prolificUser);

    await getUser.handler(parse({ submissionOffset: 10 }), skipped);

    expect(mockFetchItems).not.toHaveBeenCalled();
    expect(getEnrichment(skipped).submissionOffset).toBeUndefined();

    const resolved = createMockContext({ errors: getUser.errors });
    mockFetchItems.mockResolvedValue(itemsFor([211]));

    await getUser.handler(
      parse({ includeSubmissions: true, submissionCount: 1, submissionOffset: 10 }),
      resolved,
    );

    expect(getEnrichment(resolved).submissionOffset).toBe(10);
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

    expect(text).toContain('### Submissions');
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

  it.each(['   ', '\t', '\n '])('rejects whitespace-only username (%j)', (username) => {
    expect(() => getUser.input.parse({ username })).toThrow();
  });

  it('trims surrounding whitespace from username', () => {
    expect(getUser.input.parse({ username: '  dang  ' }).username).toBe('dang');
  });

  it('preserves username case after trimming', () => {
    expect(getUser.input.parse({ username: ' PaulGraham ' }).username).toBe('PaulGraham');
  });

  it('rejects fractional submissionCount', () => {
    expect(() => getUser.input.parse({ username: 'test', submissionCount: 2.5 })).toThrow();
  });

  it('defaults includeSubmissions to false', () => {
    const input = getUser.input.parse({ username: 'test' });
    expect(input.includeSubmissions).toBe(false);
  });

  it('defaults submissionCount to 10', () => {
    const input = getUser.input.parse({ username: 'test' });
    expect(input.submissionCount).toBe(10);
  });

  it('defaults submissionOffset to 0', () => {
    expect(getUser.input.parse({ username: 'test' }).submissionOffset).toBe(0);
  });

  it('rejects a negative or fractional submissionOffset', () => {
    expect(() => getUser.input.parse({ username: 'test', submissionOffset: -1 })).toThrow();
    expect(() => getUser.input.parse({ username: 'test', submissionOffset: 2.5 })).toThrow();
  });

  it('accepts a submissionOffset beyond the 50-item page cap', () => {
    expect(
      getUser.input.parse({ username: 'test', submissionOffset: 15000 }).submissionOffset,
    ).toBe(15000);
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

// ---------------------------------------------------------------------------
// Blank-after-trim username message
// ---------------------------------------------------------------------------

describe('hn_get_user blank username message', () => {
  it.each(['', '  ', '\t\n'])(
    'names the trimmed-blank username and the fix (%j)',
    async (username) => {
      const result = await runToolContract(getUser, { username } as never, {
        context: { errors: getUser.errors },
      });
      const error = (
        result.structuredContent as {
          error: { code: number; data?: { reason?: string; recovery?: { hint?: string } } };
        }
      ).error;
      const text = result.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(error.data?.recovery?.hint).toContain(
        'blank after trimming whitespace — pass an HN username',
      );
      expect(text).toContain('username: blank after trimming whitespace — pass an HN username');
      expect(text).not.toContain('Too small');
      expect(mockFetchUser).not.toHaveBeenCalled();
    },
  );

  it('still advertises minLength 1 on username', () => {
    const schema = z.toJSONSchema(getUser.input) as {
      properties: Record<string, { minLength?: number }>;
    };
    expect(schema.properties.username?.minLength).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Partial submission failures — the real HnService against a stubbed HN API
// ---------------------------------------------------------------------------

describe('hn_get_user — partial submission failures', () => {
  type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

  /** User `pg` whose submissions all load, with `overrides` replacing individual item routes. */
  function user(submitted: number[], overrides: Record<number, unknown> = {}) {
    return stubHnApi({
      '/user/pg.json': { id: 'pg', karma: 1, created: 1600000000, submitted },
      ...Object.fromEntries(
        submitted.map((id) => [
          `/item/${id}.json`,
          overrides[id] ?? { id, type: 'story', title: `Post ${id}`, by: 'pg' },
        ]),
      ),
    });
  }

  /** Run the tool, letting fake timers drive any retry backoff to completion. */
  async function call(input: Record<string, unknown>): Promise<ToolResult> {
    const pending = runToolContract(
      getUser,
      { username: 'pg', includeSubmissions: true, ...input } as never,
      { context: { errors: getUser.errors } },
    );
    await vi.advanceTimersByTimeAsync(120_000);
    return pending;
  }

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

  const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getHnService).mockReturnValue(new HnService(3));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('names a failed submission on both surfaces', async () => {
    user([301, 302, 303], { 302: httpStatus(500) });

    const result = await call({});
    const sc = structured(result);

    expect((sc.submissions as Array<{ id: number }>).map((s) => s.id)).toEqual([301, 303]);
    expect(sc.failedIds).toEqual([302]);
    expect(sc.notice).toBe(
      'Could not fetch 1 of 3 submissions in this window (id 302). Retry with submissionOffset: 0, or pass an id as itemId to hn_get_thread to fetch that item alone.',
    );
    const text = contentText(result);
    expect(text).toContain('id:301');
    expect(text).toContain('id:303');
    expect(text).toContain(sc.notice as string);
    expect(text).toContain('**Failed to load:** 302');
  });

  it('keeps the next-offset guidance and pagination by window when a failure lands mid-history', async () => {
    user(range(401, 25), { 405: httpStatus(500) });

    const sc = structured(await call({ submissionCount: 3, submissionOffset: 3 }));

    expect((sc.submissions as Array<{ id: number }>).map((s) => s.id)).toEqual([404, 406]);
    expect(sc).toMatchObject({ truncated: true, shown: 2, cap: 3, failedIds: [405] });
    expect(sc.notice).toBe(
      'Showing 2 live items from positions 4–6 of 25 submissions. Could not fetch 1 of 3 submissions in this window (id 405). Retry with submissionOffset: 3, or pass an id as itemId to hn_get_thread to fetch that item alone. Set submissionOffset to 6 for the next page.',
    );
  });

  it('returns an empty page, not an error, when failures and deletions leave nothing live', async () => {
    user([301, 302], { 301: httpStatus(500), 302: { id: 302, type: 'story', deleted: true } });

    const result = await call({});
    const sc = structured(result);

    expect(sc.submissions).toEqual([]);
    expect(sc.failedIds).toEqual([301]);
    expect(sc.notice).toMatch(/^Could not fetch 1 of 2 submissions in this window \(id 301\)/);
  });

  it('throws the classified upstream error, Retry-After included, when every submission failed', async () => {
    const limited = httpStatus(429, { 'Retry-After': '120' });
    user([301, 302, 303], { 301: limited, 302: limited, 303: limited });

    const result = await call({});
    const error = (
      result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
    ).error;

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'upstream_rate_limited', retryAfter: '120' });
    expect(contentText(result)).toContain('retry after 120 seconds');
  });

  it('carries no failure field or failure notice when every submission loaded', async () => {
    user([301, 302]);

    const result = await call({});
    const sc = structured(result);

    expect(sc).not.toHaveProperty('failedIds');
    expect(sc).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('Failed to load');
  });

  it('fetches no items and reports no failure when submissionOffset is past the end', async () => {
    const { requested } = user([301, 302]);

    const sc = structured(await call({ submissionOffset: 5 }));

    expect(requested()).toEqual(['/user/pg.json']);
    expect(sc).not.toHaveProperty('failedIds');
    expect(sc.notice).toMatch(/submissionOffset 5 is past the end of 2 submissions/);
  });

  it('links a comment submission to its parent and a poll option to its poll, on both surfaces', async () => {
    user([501, 502, 503], {
      501: { id: 501, type: 'comment', by: 'pg', text: 'reply', parent: 400 },
      502: { id: 502, type: 'pollopt', by: 'pg', text: 'Yes', poll: 450, score: 9 },
    });

    const result = await call({});
    const submissions = structured(result).submissions as Array<Record<string, unknown>>;

    expect(submissions[0]).toMatchObject({ id: 501, parent: 400 });
    expect(submissions[1]).toMatchObject({ id: 502, poll: 450 });
    expect(submissions[2]).toMatchObject({ id: 503 });
    expect(submissions[2]).not.toHaveProperty('parent');
    expect(submissions[2]).not.toHaveProperty('poll');
    const text = contentText(result);
    expect(text).toMatch(/id:501 \| parent:400/);
    expect(text).toMatch(/id:502 \| poll:450/);
  });
});
