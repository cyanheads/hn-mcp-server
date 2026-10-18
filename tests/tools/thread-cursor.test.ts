/**
 * @fileoverview Tests for the hn_get_thread cursor codec — the packed layout,
 * the JSON format earlier releases issued, and hostile input.
 * @module tests/tools/thread-cursor.test
 */

import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import {
  decodeThreadCursor,
  encodeThreadCursor,
  MAX_CURSOR_LENGTH,
  type ThreadCursor,
} from '@/mcp-server/tools/thread-cursor.js';
import { cpuMsPerCall, expectLinearCpu } from '../helpers/cpu-time.js';

const MAX_DEPTH = 10;
const decode = (cursor: string) => decodeThreadCursor(cursor, MAX_DEPTH);

/** The most CPU ms one decode may cost at `chars` characters: 5 ms plus 1 ms per 1,000. */
const maxMs = (chars: number) => 5 + chars / 1_000;

/** A count past the entries any payload in this file holds. */
const CLAIMED = 2 ** 24;

/** LEB128-style varint, the payload's integer encoding. */
function varint(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  while (rest >= 0x80) {
    out.push((rest % 0x80) + 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

const zigzag = (n: number) => (n < 0 ? -2 * n - 1 : 2 * n);

/** A packed cursor: the format byte, then each number as a varint and each array as raw bytes. */
function packed(...fields: Array<number | number[]>): string {
  return Buffer.from([
    0x01,
    ...fields.flatMap((f) => (typeof f === 'number' ? varint(f) : f)),
  ]).toString('base64url');
}

/** itemId 1, depth 2, offset 0, no depth cut, one group (level 0, parent 1) holding comment 10, no story. */
const minimal = () => packed(1, 2, 0, 0, 1, 0, zigzag(0), 1, zigzag(9), 0);

const state = (overrides: Partial<ThreadCursor> = {}): ThreadCursor => ({
  itemId: 100,
  depth: 3,
  offset: 7,
  depthCut: false,
  frontier: [
    { id: 105, level: 0, parentId: 100 },
    { id: 103, level: 0, parentId: 100 },
    { id: 230, level: 1, parentId: 105 },
  ],
  ...overrides,
});

describe('thread cursor — packed format', () => {
  it('encodes the documented layout', () => {
    const cursor = encodeThreadCursor(state({ depthCut: true, story: { id: 90, by: 'pg' } }));

    expect(cursor).toBe(
      packed(
        100, // itemId
        3, // depth
        7, // offset
        1, // depthCut
        2, // groupCount
        0, // level
        zigzag(100 - 100), // parentId - itemId
        2, // idCount
        zigzag(105 - 100), // first ID, from parentId
        zigzag(103 - 105), // next ID, from the previous one
        1,
        zigzag(105 - 100),
        1,
        zigzag(230 - 105),
        90, // storyId
        2, // author byte length
        [0x70, 0x67], // "pg"
      ),
    );
  });

  it('decodes the minimal hand-built payload', () => {
    expect(decode(minimal())).toEqual({
      itemId: 1,
      depth: 2,
      offset: 0,
      depthCut: false,
      frontier: [{ id: 10, level: 0, parentId: 1 }],
    });
  });

  it.each<[string, ThreadCursor]>([
    ['a two-level frontier with a depth cut', state({ depthCut: true })],
    [
      'IDs that fall and rise across a wide span, and a parent below the root',
      state({
        itemId: 2 ** 40,
        frontier: [
          { id: 2 ** 40 + 9_000_000, level: 0, parentId: 2 ** 40 },
          { id: 2 ** 40 + 3, level: 0, parentId: 2 ** 40 },
          { id: 5, level: 2, parentId: 4 },
        ],
      }),
    ],
    [
      'one (level, parentId) pair split by another, kept in traversal order',
      state({
        frontier: [
          { id: 230, level: 1, parentId: 105 },
          { id: 104, level: 0, parentId: 100 },
          { id: 231, level: 1, parentId: 105 },
        ],
      }),
    ],
    ['a resolved story and its author', state({ story: { id: 90, by: 'pg' } })],
    ['a multibyte author', state({ story: { id: 90, by: 'zoë_日本' } })],
    ['a resolved story with no author', state({ story: { id: 90 } })],
    ['the largest safe offset', state({ offset: Number.MAX_SAFE_INTEGER })],
  ])('round-trips %s', (_label, original) => {
    expect(decode(encodeThreadCursor(original))).toEqual(original);
  });

  it('writes 0 for an unresolved story and decodes it to none', () => {
    const cursor = encodeThreadCursor(state());

    expect(Buffer.from(cursor, 'base64url').at(-1)).toBe(0);
    expect(decode(cursor)).not.toHaveProperty('story');
  });
});

describe('thread cursor — the JSON format earlier releases issued', () => {
  const json = (fields: Record<string, unknown>) => encodeCursor(fields as never);

  it('decodes to the same state as the packed cursor for that state', () => {
    const original = state({ depthCut: true });
    const legacy = json({
      offset: 7,
      limit: 50,
      itemId: 100,
      depth: 3,
      frontier: [
        [0, 100, 105, 103],
        [1, 105, 230],
      ],
      depthCut: true,
    });

    expect(decode(legacy)).toEqual(original);
    expect(decode(legacy)).toEqual(decode(encodeThreadCursor(original)));
  });

  it('decodes the valid cursor the rejections below vary', () => {
    expect(
      decode(json({ offset: 0, limit: 5, itemId: 1, depth: 1, frontier: [[0, 1, 10]] })),
    ).toEqual({
      itemId: 1,
      depth: 1,
      offset: 0,
      depthCut: false,
      frontier: [{ id: 10, level: 0, parentId: 1 }],
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['no limit', { offset: 0, itemId: 1, depth: 1, frontier: [[0, 1, 10]] }],
    ['a zero limit', { offset: 0, limit: 0, itemId: 1, depth: 1, frontier: [[0, 1, 10]] }],
    ['a level at its depth', { offset: 0, limit: 5, itemId: 1, depth: 1, frontier: [[1, 1, 10]] }],
    [
      'a depth past the maximum',
      { offset: 0, limit: 5, itemId: 1, depth: 11, frontier: [[0, 1, 10]] },
    ],
    ['a group with no IDs', { offset: 0, limit: 5, itemId: 1, depth: 1, frontier: [[0, 1]] }],
    ['an empty frontier', { offset: 0, limit: 5, itemId: 1, depth: 1, frontier: [] }],
    ['a negative ID', { offset: 0, limit: 5, itemId: 1, depth: 1, frontier: [[0, 1, -10]] }],
    ['a generic pagination state', { offset: 0, limit: 10 }],
  ])('rejects %s', (_label, fields) => {
    expect(decode(json(fields))).toBeUndefined();
  });

  it('rejects a payload that opens with "{" but is not JSON', () => {
    expect(decode(Buffer.from('{"offset":0,').toString('base64url'))).toBeUndefined();
  });

  describe('reads every payload earlier releases read', () => {
    const fields = {
      offset: 7,
      limit: 50,
      itemId: 100,
      depth: 3,
      frontier: [
        [0, 100, 105, 103],
        [1, 105, 230],
      ],
      depthCut: true,
    };
    const text = JSON.stringify(fields);
    const fromBytes = (...parts: Array<string | number[]>) =>
      Buffer.concat(parts.map((p) => Buffer.from(p as never))).toString('base64url');

    it.each<[string, string]>([
      ['whitespace before the opening brace', fromBytes(' \t\r\n', text)],
      ['whitespace between tokens', fromBytes(JSON.stringify(fields, null, 2))],
      ['an ignored key', fromBytes(`{"note":"x",${text.slice(1)}`)],
      [
        'invalid UTF-8 inside an ignored key',
        fromBytes('{"note":"', [0xff, 0xfe, 0xc3], `",${text.slice(1)}`),
      ],
      ['invalid UTF-8 as an ignored key', fromBytes('{"', [0xff], `":1,${text.slice(1)}`)],
      [
        'a truncated UTF-8 sequence just before a closing quote',
        fromBytes('{"note":"', [0xe2, 0x82], `",${text.slice(1)}`),
      ],
    ])('decodes a payload with %s to the same state', (_label, cursor) => {
      const canonical = encodeCursor(fields as never);
      expect(decode(canonical)).toEqual(state({ depthCut: true }));

      expect(decode(cursor)).toEqual(decode(canonical));
    });
  });
});

describe('thread cursor — transport, read as earlier releases read it', () => {
  /**
   * Each cursor holds `_` — the packed one through its author's multibyte
   * UTF-8, the JSON-format one through `?` characters in an ignored key — and
   * a length that is a multiple of 4, so one more character completes no byte.
   */
  const packedCursor = encodeThreadCursor(state({ story: { id: 90, by: 'zoë_日本x' } }));
  const jsonCursor = encodeCursor({
    offset: 7,
    limit: 50,
    itemId: 100,
    depth: 3,
    frontier: [
      [0, 100, 105, 103],
      [1, 105, 230],
    ],
    note: '?????',
  } as never);

  const variants: Array<[string, (cursor: string) => string]> = [
    ['base64 padding', (c) => `${c}==`],
    ['a single "=" of padding', (c) => `${c}=`],
    ['the standard base64 alphabet', (c) => c.replace(/-/g, '+').replace(/_/g, '/')],
    ['a stray space', (c) => `${c.slice(0, 4)} ${c.slice(4)}`],
    ['whitespace around it', (c) => ` \t${c}\r\n`],
    ['a line break every 8 characters', (c) => (c.match(/.{1,8}/g) ?? []).join('\n')],
    ['a character outside both alphabets', (c) => `${c.slice(0, 6)}.${c.slice(6)}`],
  ];

  describe.each<[string, string, ThreadCursor]>([
    ['packed', packedCursor, state({ story: { id: 90, by: 'zoë_日本x' } })],
    ['JSON-format', jsonCursor, state()],
  ])('a %s cursor', (_format, cursor, expected) => {
    it('holds a character only base64url uses, and a length one more character cannot complete a byte of', () => {
      expect(cursor).toMatch(/[-_]/);
      expect(cursor.length % 4).toBe(0);
      expect(decode(cursor)).toEqual(expected);
    });

    it.each(variants)('decodes with %s to the same state', (_label, vary) => {
      const varied = vary(cursor);
      expect(varied).not.toBe(cursor);

      expect(decode(varied)).toEqual(expected);
    });

    it('decodes with a dangling character that completes no byte to the same state', () => {
      expect(decode(`${cursor}A`)).toEqual(expected);
    });

    it('rejects an "=" inside it, which ends what is read', () => {
      expect(decode(`${cursor.slice(0, 8)}=${cursor.slice(8)}`)).toBeUndefined();
    });
  });
});

describe('thread cursor — malformed input', () => {
  const MAX_SAFE = Number.MAX_SAFE_INTEGER;

  it.each<[string, string]>([
    ['an empty string', ''],
    ['whitespace alone', ' \r\n\t'],
    ['text that decodes to neither format', 'garbage!!'],
    ['an "=" that ends what is read mid-payload', `${minimal().slice(0, 8)}=${minimal().slice(8)}`],
    ['a dangling character that completes a trailing byte', `${minimal()}A`],
    ['format byte 0x00', Buffer.from([0x00, 1, 2, 0, 0, 1, 0, 0, 1, 18, 0]).toString('base64url')],
    ['format byte 0x02', Buffer.from([0x02, 1, 2, 0, 0, 1, 0, 0, 1, 18, 0]).toString('base64url')],
    ['format byte 0xff', Buffer.from([0xff, 1, 2, 0, 0, 1, 0, 0, 1, 18, 0]).toString('base64url')],
    ['a trailing byte', packed(1, 2, 0, 0, 1, 0, 0, 1, 18, 0, 0)],
    ['a varint past MAX_SAFE_INTEGER', packed(1, 2, MAX_SAFE + 1, 0, 1, 0, 0, 1, 18, 0)],
    [
      'a nine-byte varint',
      packed(1, 2, [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00], 0, 1, 0, 0, 1, 18, 0),
    ],
    [
      'a varint that never ends',
      packed(
        1,
        2,
        Array.from({ length: 64 }, () => 0xff),
      ),
    ],
    ['a depth-cut flag of 2', packed(1, 2, 0, 2, 1, 0, 0, 1, 18, 0)],
    ['depth 0', packed(1, 0, 0, 0, 1, 0, 0, 1, 18, 0)],
    ['a depth past the maximum', packed(1, 11, 0, 0, 1, 10, 0, 1, 18, 0)],
    ['a level at its depth', packed(1, 2, 0, 0, 1, 2, 0, 1, 18, 0)],
    ['no groups', packed(1, 2, 0, 0, 0, 0)],
    ['a group with no IDs', packed(1, 2, 0, 0, 1, 0, 0, 0, 0)],
    ['an ID below zero', packed(1, 2, 0, 0, 1, 0, 0, 1, zigzag(-5), 0)],
    ['a parent below zero', packed(1, 2, 0, 0, 1, 0, zigzag(-5), 1, zigzag(9), 0)],
    ['an ID past MAX_SAFE_INTEGER', packed(MAX_SAFE, 2, 0, 0, 1, 0, 0, 1, zigzag(1), 0)],
    ['an author longer than the payload', packed(1, 2, 0, 0, 1, 0, 0, 1, 18, 90, 5, [0x70, 0x67])],
    ['an author that is not UTF-8', packed(1, 2, 0, 0, 1, 0, 0, 1, 18, 90, 2, [0xff, 0xfe])],
  ])('rejects %s', (_label, cursor) => {
    expect(decode(cursor)).toBeUndefined();
  });

  it('rejects every proper prefix of a valid cursor', () => {
    const bytes = Buffer.from(
      encodeThreadCursor(state({ depthCut: true, story: { id: 90, by: 'pg' } })),
      'base64url',
    );
    expect(decode(bytes.toString('base64url'))).toBeDefined();

    for (let end = 0; end < bytes.length; end++) {
      expect(decode(bytes.subarray(0, end).toString('base64url'))).toBeUndefined();
    }
  });

  it.each<[string, (count: number) => string]>([
    ['group count', (count) => packed(1, 2, 0, 0, count)],
    ['ID count', (count) => packed(1, 2, 0, 0, 1, 0, 0, count)],
    ['author length', (count) => packed(1, 2, 0, 0, 1, 0, 0, 1, 18, 90, count)],
  ])("rejects an out-of-range %s in CPU bounded by the cursor's length", (_label, withCount) => {
    const cursor = withCount(CLAIMED);
    expect(cpuMsPerCall(() => decode(cursor))).toBeLessThan(maxMs(cursor.length));
    expect(decode(cursor)).toBeUndefined();

    expect(decode(withCount(MAX_SAFE))).toBeUndefined();
  });
});

describe('thread cursor — length bound', () => {
  it.each<[string, string]>([
    ['packed', encodeThreadCursor(state({ story: { id: 90, by: 'pg' } }))],
    [
      'JSON-format',
      encodeCursor({ offset: 7, limit: 50, itemId: 100, depth: 3, frontier: [[0, 100, 105]] }),
    ],
  ])(
    'reads a %s cursor of 150,000 characters and rejects one a character longer',
    (_format, cursor) => {
      const atBound = cursor.padEnd(150_000, ' ');
      expect(atBound).toHaveLength(150_000);
      expect(decode(cursor)).toBeDefined();

      expect(decode(atBound)).toEqual(decode(cursor));
      expect(decode(`${atBound} `)).toBeUndefined();
      expect(decode(` ${atBound}`)).toBeUndefined();
    },
  );
});

describe('thread cursor — worst-case timing', () => {
  /** Build a cursor string of about `chars` characters. */
  const fromBytes = (bytes: number) => (chars: number) => Math.ceil((chars * 3) / 4 / bytes);

  const oneGroup = (chars: number) => {
    const n = fromBytes(1)(chars);
    return packed(
      1,
      2,
      0,
      0,
      1,
      0,
      0,
      n,
      Array.from({ length: n }, () => zigzag(1)),
      0,
    );
  };
  const manyGroups = (chars: number) => {
    const n = fromBytes(4)(chars);
    const group = [0, 0, 1, zigzag(9)];
    return packed(1, 2, 0, 0, n, Array.from({ length: n }, () => group).flat(), 0);
  };
  const json = (chars: number) => {
    const n = fromBytes(9)(chars);
    const ids = Array.from({ length: n }, (_, i) => 49_257_378 + i);
    return encodeCursor({
      offset: 0,
      limit: 5,
      itemId: 1,
      depth: 2,
      frontier: [[0, 1, ...ids]],
    } as never);
  };
  const outOfRangeGroupCount = (chars: number) => {
    const n = fromBytes(4)(chars);
    const group = [0, 0, 1, zigzag(9)];
    return packed(1, 2, 0, 0, CLAIMED, Array.from({ length: n }, () => group).flat());
  };
  const repeat = (unit: string) => (chars: number) =>
    unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);

  it.each<[string, (chars: number) => string]>([
    ['one group of consecutive IDs', oneGroup],
    ['one ID per group', manyGroups],
    ['a JSON-format cursor', json],
    ['an out-of-range group count', outOfRangeGroupCount],
    ['a run of digits', repeat('1')],
    ['one long line ending in a break', (chars) => `${repeat('§1 x')(chars)}\ny`],
    ['line breaks throughout', repeat('  \r\n')],
  ])(
    'stays linear on %s from 2k to 128k characters, inside the length bound',
    (_label, make) => {
      expect(128_000).toBeLessThanOrEqual(MAX_CURSOR_LENGTH);
      expectLinearCpu({ make, run: decode, maxMs, from: 2_000, to: 128_000 });
    },
    120_000,
  );
});
