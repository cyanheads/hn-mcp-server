/**
 * @fileoverview Tests for the hn_get_user tool.
 * @module mcp-server/tools/definitions/get-user.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    const ctx = createMockContext();
    mockFetchUser.mockResolvedValue(null);

    await expect(getUser.handler(parse(), ctx)).rejects.toThrow('User testuser not found');
  });

  it('returns basic profile without submissions', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    vi.mocked(stripHtml).mockReturnValue('Hello world');
    mockFetchUser.mockResolvedValue(baseUser);

    const result = await getUser.handler(parse(), ctx);

    expect(stripHtml).toHaveBeenCalledWith('<p>Hello world</p>');
    expect(result.user.about).toBe('Hello world');
  });

  it('sets totalSubmissions to 0 when submitted is absent', async () => {
    const ctx = createMockContext();
    const { submitted: _, ...userNoSubmitted } = baseUser;
    mockFetchUser.mockResolvedValue(userNoSubmitted);

    const result = await getUser.handler(parse(), ctx);

    expect(result.user.totalSubmissions).toBe(0);
  });

  it('fetches and returns submissions when includeSubmissions is true', async () => {
    const ctx = createMockContext();
    mockFetchUser.mockResolvedValue(baseUser);
    mockFetchItems.mockResolvedValue([storyItem, commentItem]);

    const result = await getUser.handler(parse({ includeSubmissions: true }), ctx);

    expect(mockFetchItems).toHaveBeenCalledWith([100, 101, 102]);
    const subs = result.submissions;
    expect(subs).toHaveLength(2);
    expect(subs?.[0]).toMatchObject({ id: 100, type: 'story', title: 'My Post' });
    expect(subs?.[1]).toMatchObject({ id: 101, type: 'comment' });
  });

  it('limits fetched submissions to submissionCount', async () => {
    const ctx = createMockContext();
    mockFetchUser.mockResolvedValue(baseUser);
    mockFetchItems.mockResolvedValue([storyItem]);

    await getUser.handler(parse({ includeSubmissions: true, submissionCount: 1 }), ctx);

    expect(mockFetchItems).toHaveBeenCalledWith([100]);
  });

  it('filters out dead and deleted submissions', async () => {
    const ctx = createMockContext();
    mockFetchUser.mockResolvedValue({ ...baseUser, submitted: [100, 102, 103] });
    mockFetchItems.mockResolvedValue([storyItem, deadItem, deletedItem]);

    const result = await getUser.handler(parse({ includeSubmissions: true }), ctx);

    expect(result.submissions).toHaveLength(1);
    expect(result.submissions?.[0]?.id).toBe(100);
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

    expect(blocks).toEqual([{ type: 'text', text: `pg | 1000 karma | joined ${joined}` }]);
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

    expect(text).toContain('Recent submissions:');
    expect(text).toContain('1. First Post (42 pts, 10 comments)');
    expect(text).toContain('2. [comment]');
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
});
