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
import { quoteBody } from '@/mcp-server/tools/markdown-escape.js';
import { getHnService, HnService, type ItemSlot, stripHtml } from '@/services/hn/hn-service.js';
import { httpStatus, rejectUnmockedFetch, stall, stubHnApi } from '../helpers/hn-api-stub.js';

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

    expect(mockFetchItems).toHaveBeenCalledWith(
      [100, 101, 102],
      expect.anything(),
      expect.any(Number),
    );
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

    expect(mockFetchItems).toHaveBeenCalledWith([100], expect.anything(), expect.any(Number));
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

    expect(mockFetchItems).toHaveBeenCalledWith(
      [201, 202, 203],
      expect.anything(),
      expect.any(Number),
    );
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

    expect(mockFetchItems).toHaveBeenCalledWith(
      [211, 212, 213],
      expect.anything(),
      expect.any(Number),
    );
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

    expect(mockFetchItems).toHaveBeenCalledWith([], expect.anything(), expect.any(Number));
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

    expect(mockFetchItems).toHaveBeenCalledWith(
      [221, 222, 223, 224, 225],
      expect.anything(),
      expect.any(Number),
    );
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

    expect(mockFetchItems).toHaveBeenCalledWith(
      [206, 207, 208],
      expect.anything(),
      expect.any(Number),
    );
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
// submissionCount above the per-call cap — served at the cap, not rejected
// ---------------------------------------------------------------------------

describe('hn_get_user — submissionCount above the per-call cap', () => {
  type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

  /** 120 submissions with IDs 1001..1120, most recent first. */
  const history = Array.from({ length: 120 }, (_, i) => 1001 + i);

  beforeEach(() => {
    mockFetchUser.mockResolvedValue({ ...baseUser, submitted: history });
    mockFetchItems.mockImplementation(async (ids) =>
      slotsOf(ids.map((id) => ({ id, type: 'story', by: 'testuser', title: `Post ${id}` }))),
    );
  });

  function call(input: Record<string, unknown>): Promise<ToolResult> {
    return runToolContract(
      getUser,
      { username: 'testuser', includeSubmissions: true, ...input } as never,
      { context: { errors: getUser.errors } },
    );
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

  it('serves submissionCount: 51 as the first 50 submissions, naming the cap and the next offset', async () => {
    const result = await call({ submissionCount: 51 });
    const sc = structured(result);

    expect(mockFetchItems).toHaveBeenCalledWith(
      history.slice(0, 50),
      expect.anything(),
      expect.any(Number),
    );
    expect((sc.submissions as { id: number }[]).map((s) => s.id)).toEqual(history.slice(0, 50));
    expect(sc).toMatchObject({ submissionOffset: 0, truncated: true, shown: 50, cap: 50 });
    expect(sc.notice).toBe(
      'Showing 50 live items from positions 1–50 of 120 submissions. submissionCount 51 is above the per-call cap of 50, so this call served submissionCount: 50. Set submissionOffset to 50 for the next page.',
    );
    expect(contentText(result)).toContain(sc.notice as string);
  });

  it('serves the 1,000 ceiling as the first 50 submissions of the window asked for', async () => {
    const result = await call({ submissionCount: 1000, submissionOffset: 60 });
    const sc = structured(result);

    expect((sc.submissions as { id: number }[]).map((s) => s.id)).toEqual(history.slice(60, 110));
    expect(sc).toMatchObject({ submissionOffset: 60, shown: 50, cap: 50 });
    expect(sc.notice).toBe(
      'Showing 50 live items from positions 61–110 of 120 submissions. submissionCount 1000 is above the per-call cap of 50, so this call served submissionCount: 50. Set submissionOffset to 110 for the next page.',
    );
    expect(contentText(result)).toContain(sc.notice as string);
  });

  it('rejects submissionCount above the 1,000 ceiling before any upstream call', async () => {
    const result = await call({ submissionCount: 1001 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'invalid_arguments',
          issues: [{ path: ['submissionCount'], code: 'too_big', maximum: 1000 }],
        },
      },
    });
    expect(mockFetchUser).not.toHaveBeenCalled();
  });

  it('adds nothing when the capped window already reaches the end of the history', async () => {
    const sc = structured(await call({ submissionCount: 80, submissionOffset: 100 }));

    expect((sc.submissions as { id: number }[]).map((s) => s.id)).toEqual(history.slice(100));
    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('notice');
  });

  it('keeps the past-the-end notice alone when an over-cap window starts past the end', async () => {
    const sc = structured(await call({ submissionCount: 500, submissionOffset: 300 }));

    expect(sc.submissions).toEqual([]);
    expect(sc.notice).toBe(
      'submissionOffset 300 is past the end of 120 submissions. Valid offsets are 0 to 119.',
    );
  });

  it('advertises the 1,000 ceiling and pages by the served size, not the requested one', () => {
    const schema = z.toJSONSchema(getUser.input) as {
      properties: Record<string, { maximum?: number; description?: string }>;
    };
    expect(schema.properties.submissionCount?.maximum).toBe(1000);
    expect(schema.properties.submissionCount?.description).toBe(
      'Page size — how many submissions to resolve per call, at most 50 per call. A larger value is served at 50, and the notice names the submissionOffset for the next page. Only used when includeSubmissions is true.',
    );
    expect(schema.properties.submissionOffset?.description).toBe(
      'How many submissions to skip before resolving, counting back from the most recent. Use with submissionCount to page through a long history: request offset 0, then advance by the page size served, and so on. The enrichment block echoes submissionOffset and, when more remain, the offset to send next. Only used when includeSubmissions is true.',
    );
  });

  it('describes cap as the size served and descendants as the live-comment count', () => {
    expect(getUser.enrichment!.cap!.description).toBe(
      'The submissionCount value served: as passed, or 50 when submissionCount was above that cap.',
    );
    expect(getUser.enrichment!.notice!.description).toMatch(/served at its per-call cap/);

    const output = z.toJSONSchema(getUser.output) as unknown as {
      properties: {
        submissions: { items: { properties: Record<string, { description?: string }> } };
      };
    };
    expect(output.properties.submissions.items.properties.descendants?.description).toBe(
      "HN's count of live comments in the thread (descendants); dead and deleted comments are not counted. Present for stories and polls.",
    );
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

  it('constrains submissionCount to 1-1,000', () => {
    expect(() => getUser.input.parse({ username: 'test', submissionCount: 0 })).toThrow();
    expect(() => getUser.input.parse({ username: 'test', submissionCount: 1001 })).toThrow();
    expect(getUser.input.parse({ username: 'test', submissionCount: 1 }).submissionCount).toBe(1);
    expect(getUser.input.parse({ username: 'test', submissionCount: 50 }).submissionCount).toBe(50);
    expect(getUser.input.parse({ username: 'test', submissionCount: 51 }).submissionCount).toBe(51);
    expect(getUser.input.parse({ username: 'test', submissionCount: 1000 }).submissionCount).toBe(
      1000,
    );
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

// ---------------------------------------------------------------------------
// The per-call time budget (#47) — the real HnService at its default
// concurrency against a stubbed HN API, on the fake clock with jitter pinned
// ---------------------------------------------------------------------------

describe('hn_get_user — the per-call time budget', () => {
  type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

  const HUNG = stall(Number.POSITIVE_INFINITY);
  const ids = (n: number) => Array.from({ length: n }, (_, i) => 501 + i);

  /** User `pg` with `n` submissions 501…, every id in `hung` never answering. */
  function history(n: number, hung: readonly number[] = []) {
    return stubHnApi({
      '/user/pg.json': { id: 'pg', karma: 1, created: 1600000000, submitted: ids(n) },
      ...Object.fromEntries(
        ids(n).map((id) => [
          `/item/${id}.json`,
          hung.includes(id) ? HUNG : { id, type: 'story', title: `Post ${id}`, by: 'pg' },
        ]),
      ),
    });
  }

  /** Run a call and note when it settled on the fake clock, relative to its start. */
  async function timedCall(input: Record<string, unknown>) {
    const startedAt = Date.now();
    let settledAfter = Number.NaN;
    const pending = runToolContract(
      getUser,
      { username: 'pg', includeSubmissions: true, ...input } as never,
      { context: { errors: getUser.errors } },
    ).then((result) => {
      settledAfter = Date.now() - startedAt;
      return result;
    });
    /** Far past any budget, so an unbounded call shows its real settle time. */
    await vi.advanceTimersByTimeAsync(1_000_000);
    return { result: await pending, settledAfter };
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

  const submissionIds = (sc: Record<string, unknown>) =>
    (sc.submissions as Array<{ id: number }>).map((s) => s.id);

  beforeEach(() => {
    vi.useFakeTimers();
    /** Backoff without jitter: one hung fetch's ladder is 4 × 10 s + 1 + 2 + 4 s = 47 s. */
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.mocked(getHnService).mockReturnValue(new HnService(10));
  });

  afterEach(() => {
    vi.mocked(Math.random).mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps one hung submission of 30 as it was: 29 submissions at 47 s, no budget named', async () => {
    history(30, [505]);

    const { result, settledAfter } = await timedCall({ submissionCount: 30 });
    const sc = structured(result);

    expect(settledAfter).toBe(47_000);
    expect(submissionIds(sc)).toEqual(ids(30).filter((id) => id !== 505));
    expect(sc.failedIds).toEqual([505]);
    expect(sc.notice).toBe(
      'Could not fetch 1 of 30 submissions in this window (id 505). Retry with submissionOffset: 0, or pass an id as itemId to hn_get_thread to fetch that item alone.',
    );
  });

  it('fails with Timeout at the budget when all 50 submissions hang, starting nothing past it', async () => {
    const { requested } = history(50, ids(50));

    const { result, settledAfter } = await timedCall({ submissionCount: 50 });
    const error = (result.structuredContent as { error: { code: number } }).error;

    /** Unbounded: five rounds of ten 47-second ladders — 235 s. */
    expect(settledAfter).toBe(50_000);
    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    /** 501–510 ran full ladders, 511–520 started at 47 s; 521 onward never started. */
    expect(requested()).toContain('/item/520.json');
    expect(requested()).not.toContain('/item/521.json');
  });

  /**
   * Over the installed stub: the user fetch's first three attempts never
   * answer, and the fourth, sent at 37 s, does. Returns the attempt count.
   */
  function slowUserFetch(): () => number {
    const inner = globalThis.fetch;
    let userAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/user/pg.json') && ++userAttempts <= 3) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }
        return inner(input, init);
      }),
    );
    return () => userAttempts;
  }

  it('bounds a slow user fetch and the submissions after it by one budget, naming the budget', async () => {
    history(30, [505]);
    const userAttempts = slowUserFetch();

    const { result, settledAfter } = await timedCall({ submissionCount: 30 });
    const sc = structured(result);
    const notice =
      "Could not fetch 1 of 30 submissions in this window (id 505). This call's 50-second time budget ran out before it loaded. Retry with submissionOffset: 0, or pass an id as itemId to hn_get_thread to fetch that item alone.";

    /** Unbounded: 37 s of user fetch, then 505's own 47-second ladder — 84 s. */
    expect(settledAfter).toBe(50_000);
    expect(userAttempts()).toBe(4);
    expect(submissionIds(sc)).toEqual(ids(30).filter((id) => id !== 505));
    expect(sc.failedIds).toEqual([505]);
    expect(sc.notice).toBe(notice);
    const text = contentText(result);
    expect(text).toContain(notice);
    expect(text).toContain('**Failed to load:** 505');
  });

  it('names how many of the failures the budget cut when only some ran out of time', async () => {
    /** 501–510 fill all ten workers for a full 47 s ladder; 511 starts at 47 s and is cut at 50 s. */
    history(50, ids(11));

    const { result, settledAfter } = await timedCall({ submissionCount: 50 });
    const sc = structured(result);

    /** Unbounded: two rounds of ladders — 94 s. */
    expect(settledAfter).toBe(50_000);
    expect(submissionIds(sc)).toEqual(ids(50).slice(11));
    expect(sc.failedIds).toEqual(ids(11));
    expect(sc.notice).toBe(
      "Could not fetch 11 of 50 submissions in this window (ids 501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511). This call's 50-second time budget ran out before 1 of them loaded. Retry with submissionOffset: 0, or pass an id as itemId to hn_get_thread to fetch that item alone.",
    );
  });

  it('names the budget for every failure inside the paged notice when the budget cut them all', async () => {
    history(60, [505, 506]);
    slowUserFetch();

    const { result, settledAfter } = await timedCall({ submissionCount: 20 });
    const sc = structured(result);

    /** Unbounded: 37 s of user fetch, then two parallel 47-second ladders — 84 s. */
    expect(settledAfter).toBe(50_000);
    expect(submissionIds(sc)).toEqual(ids(20).filter((id) => id !== 505 && id !== 506));
    expect(sc.failedIds).toEqual([505, 506]);
    expect(sc).toMatchObject({ truncated: true, shown: 18, cap: 20 });
    expect(sc.notice).toBe(
      "Showing 18 live items from positions 1–20 of 60 submissions. Could not fetch 2 of 20 submissions in this window (ids 505, 506). This call's 50-second time budget ran out before they loaded. Retry with submissionOffset: 0, or pass an id as itemId to hn_get_thread to fetch that item alone. Set submissionOffset to 20 for the next page.",
    );
  });

  it('propagates a cancellation that lands while a submission fetch is in flight', async () => {
    const controller = new AbortController();
    const { requested } = stubHnApi(
      {
        '/user/pg.json': { id: 'pg', karma: 1, created: 1600000000, submitted: ids(3) },
        '/item/501.json': HUNG,
        '/item/502.json': { id: 502, type: 'story' },
        '/item/503.json': { id: 503, type: 'story' },
      },
      {
        onRequest: (route) => {
          if (route === '/item/501.json') controller.abort();
        },
      },
    );
    vi.mocked(getHnService).mockReturnValue(new HnService(1));
    const ctx = createMockContext({ errors: getUser.errors, signal: controller.signal });

    const pending = Promise.resolve(
      getUser.handler(parse({ username: 'pg', includeSubmissions: true }), ctx),
    );
    const settled = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    await vi.advanceTimersByTimeAsync(1_000_000);
    await settled;

    expect(requested()).toEqual(['/user/pg.json', '/item/501.json']);
  });

  it('propagates a cancellation that lands while the user fetch is in flight', async () => {
    const controller = new AbortController();
    const { requested } = stubHnApi(
      { '/user/pg.json': HUNG },
      {
        onRequest: (route) => {
          if (route === '/user/pg.json') controller.abort();
        },
      },
    );
    const ctx = createMockContext({ errors: getUser.errors, signal: controller.signal });

    const pending = Promise.resolve(
      getUser.handler(parse({ username: 'pg', includeSubmissions: true }), ctx),
    );
    const settled = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    await vi.advanceTimersByTimeAsync(1_000_000);
    await settled;

    expect(requested()).toEqual(['/user/pg.json']);
  });

  it('describes failedIds as covering the time budget', () => {
    expect(getUser.enrichment?.failedIds?.description).toMatch(/50-second time budget/);
  });
});

// ---------------------------------------------------------------------------
// #49 — the 64,000-byte response budget
// ---------------------------------------------------------------------------

describe('hn_get_user — the 64,000-byte response budget', () => {
  type ToolResult = Awaited<ReturnType<typeof runToolContract>>;
  type WireSubmission = Record<string, any> & {
    id: number;
    text?: string;
    textTruncated?: boolean;
  };

  const BUDGET_BYTES = 64_000;
  const utf8 = new TextEncoder();
  const bytes = (text: string) => utf8.encode(text).byteLength;

  /** The line content[] puts after a cut body, outside its quote. */
  const cutLine = (id: number) =>
    `Text cut short to fit the response budget — hn_get_thread with itemId ${id} returns it whole.`;

  /** The notice sentence for a page whose bodies `cutIds` were cut. */
  const cutSentence = (cutIds: number[]) =>
    `To stay within the 64,000-byte response budget, the text of ${cutIds.length === 1 ? 'submission' : 'submissions'} ${cutIds.join(', ')} is cut short; hn_get_thread with a cut submission's id returns its full text, and a smaller submissionCount cuts less.`;

  const joined = new Date(1600000000 * 1000).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });

  /** `n` UTF-16 units of `unit` repeated. */
  const body = (n: number, unit = 'macro ') => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

  const comment = (id: number, text: string): HnItem => ({
    id,
    type: 'comment',
    by: 'pg',
    text,
    parent: 9,
    time: 1600000000,
  });
  const story = (id: number): HnItem => ({
    id,
    type: 'story',
    by: 'pg',
    title: `Post ${id}`,
    score: 3,
    time: 1600000000,
  });

  /** User `pg` with `submitted` as their history, and `slots` as the window's fetch result. */
  function serve(submitted: number[], slots: ItemSlot[]) {
    mockFetchUser.mockResolvedValue({ id: 'pg', karma: 1, created: 1600000000, submitted });
    mockFetchItems.mockResolvedValue(slots);
  }

  function callUser(input: Record<string, unknown> = {}): Promise<ToolResult> {
    return runToolContract(
      getUser,
      { username: 'pg', includeSubmissions: true, ...input } as never,
      { context: { errors: getUser.errors } },
    );
  }

  /** Both surfaces of an assembled result, sized as the caller receives them; `sc` is the wire JSON. */
  function measure(result: ToolResult) {
    expect(result.isError).toBeFalsy();
    const sc = JSON.parse(JSON.stringify(result.structuredContent)) as Record<string, any> & {
      submissions: WireSubmission[];
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

  it('leaves a page under budget as it was on both surfaces: whole bodies, no flag, no budget sentence', async () => {
    const long = body(55_000);
    serve([1, 2], slotsOf([comment(1, long), story(2)]));

    const { sc, text, contentBytes, structuredBytes } = measure(await callUser());

    expect(contentBytes).toBeGreaterThan(55_000);
    expect(contentBytes).toBeLessThan(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThan(BUDGET_BYTES);
    expect(sc).toStrictEqual({
      user: { id: 'pg', karma: 1, created: 1600000000, totalSubmissions: 2 },
      submissions: [
        { id: 1, type: 'comment', parent: 9, text: long, time: 1600000000 },
        { id: 2, type: 'story', title: 'Post 2', score: 3, time: 1600000000 },
      ],
      submissionOffset: 0,
    });
    expect(text).toBe(
      [
        '## pg',
        `**Karma:** 1 | **Joined:** ${joined} (t:1600000000) | **Total submissions:** 2`,
        '',
        '### Submissions',
        '- **[comment]** — id:1 | parent:9 | 2020-09-13 (t:1600000000)',
        `  > ${long}`,
        '',
        '- **Post 2** — id:2 | story | 3 pts | 2020-09-13 (t:1600000000)',
        '',
        '**submissionOffset:** 0',
      ].join('\n'),
    );
  });

  it('cuts the longest bodies to one shared limit, the largest that fits, keeping every submission and the paging fields', async () => {
    const a = body(40_000, 'lorem ipsum dolor\n\n');
    const b = body(35_000, 'sit amet ');
    const short = body(500);
    serve(
      Array.from({ length: 10 }, (_, i) => i + 1),
      slotsOf([comment(1, a), story(2), comment(3, b), comment(4, short)]),
    );

    const { sc, text, contentBytes, structuredBytes } = measure(
      await callUser({ submissionCount: 4 }),
    );

    expect(contentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    /** One byte more for each cut body would not fit: the limit is the largest. */
    expect(Math.max(contentBytes, structuredBytes)).toBeGreaterThan(BUDGET_BYTES - 64);

    expect(sc.submissions.map((s) => s.id)).toStrictEqual([1, 2, 3, 4]);
    expect(sc).toMatchObject({ submissionOffset: 0, truncated: true, shown: 4, cap: 4 });
    const [cutA, post, cutB, whole] = sc.submissions;
    expect(a.startsWith(cutA!.text!)).toBe(true);
    expect(b.startsWith(cutB!.text!)).toBe(true);
    expect(bytes(cutA!.text!)).toBeLessThan(bytes(b));
    expect(bytes(cutA!.text!)).toBe(bytes(cutB!.text!));
    expect(bytes(cutA!.text!)).toBeGreaterThan(bytes(short));
    expect(cutA!.textTruncated).toBe(true);
    expect(cutB!.textTruncated).toBe(true);
    expect(whole!.text).toBe(short);
    expect(whole).not.toHaveProperty('textTruncated');
    expect(post).not.toHaveProperty('textTruncated');

    expect(sc.notice).toBe(
      `Showing 4 live items from positions 1–4 of 10 submissions. Set submissionOffset to 4 for the next page. ${cutSentence([1, 3])}`,
    );

    /** content[] carries the same cut prefix, quoted, then the pointer after a blank line, inside the list item. */
    expect(text).toContain(
      `\n${quoteBody(cutA!.text!, '  ')}\n\n  ${cutLine(1)}\n\n- **Post 2** — id:2 |`,
    );
    expect(text).toContain(
      `\n${quoteBody(cutB!.text!, '  ')}\n\n  ${cutLine(3)}\n\n- **[comment]** — id:4 |`,
    );
    expect(text).toContain(`\n  > ${short}\n\n**submissionOffset:** 0`);
    expect(text).not.toContain(cutLine(2));
    expect(text).not.toContain(cutLine(4));
    expect(text).toContain(`> ${sc.notice}`);
  });

  it('cuts a single submission larger than the budget to fit, the budget sentence the whole notice', async () => {
    const huge = body(300_000);
    serve([5], slotsOf([comment(5, huge)]));

    const { sc, text, contentBytes, structuredBytes } = measure(await callUser());

    expect(contentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(Math.max(contentBytes, structuredBytes)).toBeGreaterThan(BUDGET_BYTES - 64);
    expect(sc.submissions[0]!.textTruncated).toBe(true);
    expect(huge.startsWith(sc.submissions[0]!.text!)).toBe(true);
    expect(sc).not.toHaveProperty('truncated');
    expect(sc.notice).toBe(cutSentence([5]));
    expect(text).toContain(`\n\n  ${cutLine(5)}\n\n**submissionOffset:** 0`);
  });

  it('follows the failed-IDs sentence with the budget sentence, and fits with failedIds in the trailer', async () => {
    serve(
      [1, 2, 3],
      [
        { kind: 'item', id: 1, item: comment(1, body(100_000)) },
        { kind: 'failed', id: 2, error: new Error('upstream failure') },
        { kind: 'item', id: 3, item: story(3) },
      ],
    );

    const { sc, text, contentBytes, structuredBytes } = measure(await callUser());

    expect(contentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(sc.submissions.map((s) => s.id)).toStrictEqual([1, 3]);
    expect(sc.failedIds).toStrictEqual([2]);
    expect(sc.notice).toBe(
      `Could not fetch 1 of 3 submissions in this window (id 2). Retry with submissionOffset: 0, or pass an id as itemId to hn_get_thread to fetch that item alone. ${cutSentence([1])}`,
    );
    expect(text).toContain('**Failed to load:** 2');
    expect(text).toContain(`\n\n  ${cutLine(1)}\n\n- **Post 3**`);
  });

  it('cuts on a code-point boundary, identically on both surfaces', async () => {
    const emoji = '😀é'.repeat(30_000);
    serve([6], slotsOf([comment(6, emoji)]));

    const { sc, text, contentBytes, structuredBytes } = measure(await callUser());
    const cut = sc.submissions[0]!.text!;

    expect(contentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(cut.length).toBeLessThan(emoji.length);
    expect(emoji.startsWith(cut)).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(text).toContain(`\n  > ${cut}\n\n  ${cutLine(6)}`);
  });

  it('keeps all 50 submissions of a capped page, cutting every body when all share one length', async () => {
    const history = Array.from({ length: 60 }, (_, i) => i + 1);
    serve(
      history,
      slotsOf(history.slice(0, 50).map((id) => comment(id, body(2_000, `${id} words `)))),
    );

    const { sc, contentBytes, structuredBytes } = measure(await callUser({ submissionCount: 51 }));

    expect(contentBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(structuredBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(sc.submissions.map((s) => s.id)).toStrictEqual(history.slice(0, 50));
    expect(sc.submissions.every((s) => s.textTruncated === true)).toBe(true);
    expect(new Set(sc.submissions.map((s) => bytes(s.text!))).size).toBe(1);
    expect(sc).toMatchObject({ truncated: true, shown: 50, cap: 50 });
    expect(sc.notice).toBe(
      `Showing 50 live items from positions 1–50 of 60 submissions. submissionCount 51 is above the per-call cap of 50, so this call served submissionCount: 50. Set submissionOffset to 50 for the next page. ${cutSentence(history.slice(0, 50))}`,
    );
  });

  it('format() puts the pointer after a cut body even when the cut left no text', () => {
    const blocks = getUser.format!({
      user: { id: 'pg', karma: 1, created: 1600000000, totalSubmissions: 2 },
      submissions: [
        { id: 7, type: 'comment', text: '', textTruncated: true },
        { id: 8, type: 'comment', text: 'whole' },
      ],
    } as never);
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain(`- **[comment]** — id:7\n\n  ${cutLine(7)}\n\n- **[comment]** — id:8`);
  });

  it('describes the cut on text, textTruncated, and notice', () => {
    const output = z.toJSONSchema(getUser.output) as unknown as {
      properties: {
        submissions: { items: { properties: Record<string, { description?: string }> } };
      };
    };
    const submission = output.properties.submissions.items.properties;
    expect(submission.text?.description).toMatch(/64,000-byte response budget/);
    expect(submission.textTruncated?.description).toMatch(/hn_get_thread with this id/);
    expect(getUser.enrichment?.notice?.description).toMatch(/64,000-byte response budget/);
  });
});
