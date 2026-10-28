/**
 * @fileoverview Tests for the shared response budget: byte measurement of both
 * surfaces against the framework's assembled result, the code-point cut, and
 * the search for the largest shared cut limit.
 * @module tests/tools/response-budget.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { quoteBody } from '@/mcp-server/tools/markdown-escape.js';
import {
  byteLength,
  cutToBytes,
  enrichmentBytes,
  fitsBudget,
  largestFittingLimit,
  longestFittingPrefix,
  measureResponse,
  RESPONSE_BUDGET_BYTES,
  type ResponseBytes,
} from '@/mcp-server/tools/response-budget.js';
import { expectLinearCpu } from '../helpers/cpu-time.js';

describe('byteLength', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('é')).toBe(2);
    expect(byteLength('€')).toBe(3);
    expect(byteLength('😀')).toBe(4);
  });
});

describe('cutToBytes', () => {
  it('keeps text that already fits whole', () => {
    expect(cutToBytes('hello', 5)).toBe('hello');
    expect(cutToBytes('hello', 50)).toBe('hello');
  });

  it('cuts ASCII to exactly the limit', () => {
    expect(cutToBytes('hello world', 5)).toBe('hello');
  });

  it('returns an empty string at a zero limit', () => {
    expect(cutToBytes('hello', 0)).toBe('');
  });

  it.each([
    ['a 2-byte character', 'aé', 2, 'a'],
    ['a 3-byte character', 'a€', 3, 'a'],
    ['a surrogate pair', 'a😀', 4, 'a'],
    ['a surrogate pair one byte short', 'ab😀', 5, 'ab'],
  ])('leaves out %s that would straddle the limit', (_label, text, limit, expected) => {
    expect(cutToBytes(text, limit)).toBe(expected);
  });

  it('keeps a character that ends exactly on the limit', () => {
    expect(cutToBytes('a😀b', 5)).toBe('a😀');
  });

  it('never ends on a lone surrogate', () => {
    const text = '😀'.repeat(100);
    for (let limit = 0; limit <= 400; limit++) {
      const cut = cutToBytes(text, limit);
      expect(cut.length % 2, `limit ${limit}`).toBe(0);
      expect(byteLength(cut)).toBeLessThanOrEqual(limit);
      expect(text.startsWith(cut)).toBe(true);
    }
  });

  describe('worst-case timing', () => {
    const repeat = (unit: string) => (n: number) =>
      unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

    it.each([
      ['one long line ending in a break', (n: number) => `${repeat('§1 x')(n)}\ny`],
      ['breaks throughout', repeat('  \r\n')],
    ])(
      'stays linear on %s',
      (_label, make) => {
        expectLinearCpu({ make, run: (text) => cutToBytes(text, text.length) });
      },
      120_000,
    );
  });
});

// ---------------------------------------------------------------------------
// measureResponse — against the framework's assembled CallToolResult
// ---------------------------------------------------------------------------

/**
 * A probe tool whose enrichment comes straight from its input, so a test can
 * size the same fields measureResponse is given against what the framework
 * actually assembles.
 */
const probe = tool('probe_budget', {
  description: 'Echo items and enrichment, to measure the assembled response.',
  input: z.object({
    items: z.array(z.string()).describe('Items to return.'),
    enrichment: z.record(z.string(), z.unknown()).describe('Generic enrichment fields to write.'),
    notice: z.string().optional().describe('A notice to write.'),
    noticeFirst: z.boolean().default(false).describe('Write the notice before the other fields.'),
  }),
  output: z.object({ items: z.array(z.string()).describe('The items.') }),
  enrichment: {
    total: z.number().optional().describe('A number.'),
    exact: z.boolean().optional().describe('A boolean.'),
    window: z
      .object({ from: z.number(), to: z.number() })
      .optional()
      .describe('A structured field.'),
    notice: z.string().optional().describe('A notice.'),
  },
  enrichmentTrailer: {
    window: { render: (w) => `**window:** ${w?.from}–${w?.to}` },
  },
  handler(input, ctx) {
    if (input.notice != null && input.noticeFirst) ctx.enrich.notice(input.notice);
    ctx.enrich(input.enrichment as never);
    if (input.notice != null && !input.noticeFirst) ctx.enrich.notice(input.notice);
    return { items: input.items };
  },
  format: (result) => [{ type: 'text', text: result.items.join('\n') }],
});

async function assembled(input: z.input<typeof probe.input>) {
  const result = await runToolContract(probe, input);
  expect(result.isError).toBeFalsy();
  const contentBytes = result.content.reduce(
    (sum, block) => sum + (block.type === 'text' ? byteLength(block.text) : 0),
    0,
  );
  return {
    contentBytes,
    structuredBytes: byteLength(JSON.stringify(result.structuredContent)),
    blocks: result.content.length,
  };
}

function measured(input: z.input<typeof probe.input>) {
  const result = { items: input.items };
  const enrichment = {
    ...(input.noticeFirst && input.notice != null && { notice: input.notice }),
    ...input.enrichment,
    ...(!input.noticeFirst && input.notice != null && { notice: input.notice }),
  };
  return measureResponse({
    content: probe.format!(result),
    result,
    enrichment,
    trailer: probe.enrichmentTrailer,
  });
}

describe('measureResponse', () => {
  it.each([
    ['scalars only', { items: ['a', 'b'], enrichment: { total: 12, exact: true } }],
    [
      'a notice after the scalars',
      { items: ['x'], enrichment: { total: 3 }, notice: 'Page 0 of 4. Pass page: 1 for more.' },
    ],
    [
      'a notice followed by other fields',
      {
        items: ['x'],
        enrichment: { total: 3, exact: false },
        notice: 'First line.\n\nThird line.\r\nFourth.',
        noticeFirst: true,
      },
    ],
    [
      'a rendered structured field',
      { items: ['é😀'], enrichment: { window: { from: 1, to: 9 }, total: 0 }, notice: 'Note.' },
    ],
  ])(
    'sizes structuredContent exactly and content[] within a byte per field: %s',
    async (_label, input) => {
      const actual = await assembled(input);
      const estimate = measured(input);
      const fields =
        Object.keys(input.enrichment).length + ('notice' in input && input.notice != null ? 1 : 0);

      expect(estimate.structuredBytes).toBe(actual.structuredBytes);
      expect(estimate.contentBytes).toBeGreaterThanOrEqual(actual.contentBytes);
      expect(estimate.contentBytes).toBeLessThanOrEqual(actual.contentBytes + fields);
    },
  );

  it('adds nothing for the trailer when no enrichment is written', async () => {
    const input = { items: ['only'], enrichment: {} };
    const actual = await assembled(input);

    expect(actual.blocks).toBe(1);
    expect(measured(input)).toStrictEqual({
      contentBytes: byteLength('only'),
      structuredBytes: actual.structuredBytes,
    });
  });

  it('counts every content[] text block', () => {
    const bytes = measureResponse({
      content: [
        { type: 'text', text: 'abc' },
        { type: 'text', text: 'é' },
      ],
      result: {},
      enrichment: {},
    });
    expect(bytes.contentBytes).toBe(5);
  });

  it('rejects a string field it cannot size without a render', () => {
    expect(() =>
      measureResponse({ content: [], result: {}, enrichment: { effectiveQuery: 'q' } }),
    ).toThrow(/effectiveQuery/);
  });

  it('sizes a result with no members, whose first merged field takes no comma', () => {
    const enrichment = { total: 3, exact: true };
    expect(measureResponse({ content: [], result: {}, enrichment }).structuredBytes).toBe(
      byteLength(JSON.stringify(enrichment)),
    );
  });
});

describe('enrichmentBytes', () => {
  it.each([
    ['scalars and a notice', { items: ['a'], enrichment: { total: 7 }, notice: 'One.\nTwo.' }],
    [
      'a rendered structured field',
      { items: ['é', 'b'], enrichment: { window: { from: 3, to: 4 }, exact: false } },
    ],
  ])('is what the framework adds to the page on each surface: %s', async (_label, input) => {
    const actual = await assembled(input);
    const result = { items: input.items };
    /** The probe's format() joins the items with line breaks. */
    const page = {
      contentBytes: byteLength(input.items.join('\n')),
      structuredBytes: byteLength(JSON.stringify(result)),
    };
    const enrichment = {
      ...input.enrichment,
      ...('notice' in input && { notice: input.notice }),
    };
    const added = enrichmentBytes(enrichment, probe.enrichmentTrailer);
    const fields = Object.keys(enrichment).length;

    expect(page.structuredBytes + added.structuredBytes).toBe(actual.structuredBytes);
    expect(page.contentBytes + added.contentBytes).toBeGreaterThanOrEqual(actual.contentBytes);
    expect(page.contentBytes + added.contentBytes).toBeLessThanOrEqual(
      actual.contentBytes + fields,
    );
  });

  it('adds nothing for a field JSON leaves out', () => {
    expect(enrichmentBytes({ total: undefined }).structuredBytes).toBe(0);
  });
});

describe('fitsBudget', () => {
  it.each([
    [{ contentBytes: RESPONSE_BUDGET_BYTES, structuredBytes: RESPONSE_BUDGET_BYTES }, true],
    [{ contentBytes: RESPONSE_BUDGET_BYTES + 1, structuredBytes: 10 }, false],
    [{ contentBytes: 10, structuredBytes: RESPONSE_BUDGET_BYTES + 1 }, false],
  ])('%o fits: %s', (bytes, expected) => {
    expect(fitsBudget(bytes)).toBe(expected);
  });

  it('is 64,000 bytes', () => {
    expect(RESPONSE_BUDGET_BYTES).toBe(64_000);
  });
});

// ---------------------------------------------------------------------------
// largestFittingLimit
// ---------------------------------------------------------------------------

/**
 * A page whose size is plain arithmetic: `fixed` bytes, plus each body served
 * whole or cut to the limit, plus `overhead` bytes per cut body (its flag, its
 * pointer line, its id in the notice). The structured surface runs `skew`
 * bytes over the content surface.
 */
function arithmeticPage(bodies: readonly number[], fixed: number, overhead: number, skew = 0) {
  const calls: number[] = [];
  const measure = (limit: number): ResponseBytes => {
    calls.push(limit);
    const served = bodies.reduce((sum, len) => sum + Math.min(len, limit), 0);
    const cut = bodies.filter((len) => len > limit).length;
    const contentBytes = fixed + served + overhead * cut;
    return { contentBytes, structuredBytes: contentBytes + skew };
  };
  return { calls, measure };
}

describe('largestFittingLimit', () => {
  it('cuts one oversized body to exactly what fits', () => {
    const { measure } = arithmeticPage([100_000], 1_000, 50);
    /** 1,000 + L + 50 ≤ 64,000. */
    expect(largestFittingLimit([100_000], measure)).toBe(62_950);
  });

  it('shares one limit across the bodies it cuts and leaves shorter bodies whole', () => {
    const bodies = [50_000, 40_000, 2_000];
    const { measure } = arithmeticPage(bodies, 1_000, 50);
    /** 1,000 + 2L + 2,000 + 100 ≤ 64,000 → L = 30,450, above the short body. */
    const limit = largestFittingLimit(bodies, measure);
    expect(limit).toBe(30_450);
    expect(measure(limit).contentBytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(measure(limit + 1).contentBytes).toBeGreaterThan(RESPONSE_BUDGET_BYTES);
  });

  it('binds on the larger surface', () => {
    const { measure } = arithmeticPage([100_000], 1_000, 50, 500);
    expect(largestFittingLimit([100_000], measure)).toBe(62_450);
  });

  it('reaches into shorter bodies when the longest alone cannot make room', () => {
    const bodies = [40_000, 30_000, 25_000];
    const { measure } = arithmeticPage(bodies, 0, 0);
    /** Cutting two leaves 2L + 25,000 > 64,000 at L = 25,000; cutting all three, 3L ≤ 64,000 → L = 21,333. */
    expect(largestFittingLimit(bodies, measure)).toBe(21_333);
  });

  it('finds the largest limit where returning a body whole frees its cut overhead', () => {
    /**
     * Bodies of 100 and 60 bytes over a 63,850-byte remainder, 30 bytes of
     * overhead per cut. Limit 60 keeps the 60-byte body whole: 63,850 + 60 +
     * 60 + 30 = 64,000 fits. Limit 59 cuts both: 63,850 + 118 + 60 = 64,028
     * does not. A plain bisection over 0–99 would settle at 45.
     */
    const { measure } = arithmeticPage([100, 60], 63_850, 30);
    expect(largestFittingLimit([100, 60], measure)).toBe(60);
  });

  it('treats equal bodies as one cut set', () => {
    const bodies = [40_000, 40_000];
    const { measure } = arithmeticPage(bodies, 0, 0);
    expect(largestFittingLimit(bodies, measure)).toBe(32_000);
  });

  it('ignores empty bodies', () => {
    const bodies = [0, 100_000, 0];
    const { measure } = arithmeticPage(bodies, 0, 0);
    expect(largestFittingLimit(bodies, measure)).toBe(64_000);
  });

  it('returns 0 when even cutting every body to nothing leaves the page over budget', () => {
    const { measure } = arithmeticPage([10, 20], 70_000, 0);
    expect(largestFittingLimit([10, 20], measure)).toBe(0);
  });

  it('measures at most once per distinct body length plus one bisection', () => {
    const bodies = Array.from({ length: 50 }, (_, i) => 5_000 + i * 100);
    const { calls, measure } = arithmeticPage(bodies, 2_000, 80);
    const limit = largestFittingLimit(bodies, measure);

    expect(measure(limit).contentBytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(calls.length - 1).toBeLessThanOrEqual(50 + Math.ceil(Math.log2(10_000)));
  });

  describe('worst-case timing', () => {
    const repeat = (unit: string) => (n: number) =>
      unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

    /** One body rendered both ways a tool renders it: quoted for content[], JSON for structuredContent. */
    const fitOne = (body: string) =>
      largestFittingLimit([byteLength(body)], (limit) => {
        const cut = cutToBytes(body, limit);
        return {
          contentBytes: byteLength(quoteBody(cut)),
          structuredBytes: byteLength(JSON.stringify({ text: cut })),
        };
      });

    /** A bisection re-renders the body once per halving, so the ceiling allows the log factor. */
    const maxMs = (chars: number) => 20 + (chars / 1_000) * 4;

    it.each([
      ['one long line ending in a break', (n: number) => `${repeat('§1 x')(n)}\ny`],
      ['breaks throughout', repeat('  \r\n')],
    ])(
      'stays near-linear on %s',
      (_label, make) => {
        expectLinearCpu({ make, run: fitOne, maxMs });
      },
      120_000,
    );

    /**
     * Fifty bodies of distinct lengths, the longest the whole input, each
     * rendered both ways. Every cut set but the last keeps far more than the
     * budget whole, so only limits whose page is near the budget are worth
     * rendering.
     */
    const fitMany = (text: string) => {
      const total = byteLength(text);
      const bodies = Array.from({ length: 50 }, (_, k) => {
        const body = text.slice(0, text.length - k);
        return { body, bytes: total - byteLength(text.slice(text.length - k)) };
      });
      const measured: number[] = [];
      const limit = largestFittingLimit(
        bodies.map((b) => b.bytes),
        (limitBytes) => {
          measured.push(limitBytes);
          let contentBytes = 0;
          let structuredBytes = 0;
          for (const { body, bytes } of bodies) {
            const cut = bytes > limitBytes ? cutToBytes(body, limitBytes) : body;
            contentBytes += byteLength(quoteBody(cut));
            structuredBytes += byteLength(JSON.stringify({ text: cut }));
          }
          return { contentBytes, structuredBytes };
        },
      );
      return { limit, measured };
    };

    it('renders only pages near the budget, however long the bodies', () => {
      const { limit, measured } = fitMany('x'.repeat(40_000));
      /** Fifty bodies share the budget: every one is cut. */
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThan(RESPONSE_BUDGET_BYTES / 50);
      expect(measured.every((l) => l * 50 <= RESPONSE_BUDGET_BYTES)).toBe(true);
      expect(measured.length).toBeLessThanOrEqual(
        2 + Math.ceil(Math.log2(50)) + Math.ceil(Math.log2(40_000)),
      );
    });

    it.each([
      ['one long line ending in a break', (n: number) => `${repeat('§1 x')(n)}\ny`],
      ['breaks throughout', repeat('  \r\n')],
    ])(
      'stays near-flat in body length on many distinct long bodies: %s',
      (_label, make) => {
        /** The page rendered is budget-sized whatever the bodies' length; slicing them is all that grows. */
        expectLinearCpu({ make, run: fitMany, maxMs: (chars) => 30 + chars / 10_000 });
      },
      120_000,
    );
  });
});

// ---------------------------------------------------------------------------
// longestFittingPrefix
// ---------------------------------------------------------------------------

/**
 * Prefixes of a page of `items`-byte items over `fixed` bytes, on both
 * surfaces alike, plus `extra(index)` bytes of enrichment for prefix `index`
 * (index 0 holds the first item).
 */
function prefixPage(items: readonly number[], fixed: number, extra: (index: number) => number) {
  const pageBytes: ResponseBytes[] = [];
  let sum = fixed;
  for (const bytes of items) {
    sum += bytes;
    pageBytes.push({ contentBytes: sum, structuredBytes: sum });
  }
  const measured: number[] = [];
  const measure = (index: number): ResponseBytes => {
    measured.push(index);
    const page = pageBytes[index]!;
    return {
      contentBytes: page.contentBytes + extra(index),
      structuredBytes: page.structuredBytes + extra(index),
    };
  };
  return { measured, measure, pageBytes };
}

describe('longestFittingPrefix', () => {
  it('serves the whole page when it fits, measuring it alone', () => {
    const { measure, measured, pageBytes } = prefixPage([20_000, 20_000, 20_000], 0, () => 3_000);
    expect(longestFittingPrefix(pageBytes, measure)).toBe(2);
    expect(measured).toEqual([2]);
  });

  it('drops the items the overflow says must go, in one step', () => {
    /** 10 items of 7,000 bytes: prefix i holds 7,000(i + 1), plus 1,500 of enrichment. */
    const { measure, measured, pageBytes } = prefixPage(Array(10).fill(7_000), 0, () => 1_500);
    const index = longestFittingPrefix(pageBytes, measure);

    /** 7,000 × 9 + 1,500 = 64,500 is over; 7,000 × 8 + 1,500 = 57,500 fits. */
    expect(index).toBe(7);
    expect(measured).toEqual([9, 7]);
  });

  it('binds on whichever surface overflows', () => {
    const pageBytes = [10_000, 30_000, 50_000, 63_000].map((n) => ({
      contentBytes: n / 2,
      structuredBytes: n,
    }));
    const measure = (index: number) => ({
      contentBytes: pageBytes[index]!.contentBytes + 100,
      structuredBytes: pageBytes[index]!.structuredBytes + 2_000,
    });
    expect(longestFittingPrefix(pageBytes, measure)).toBe(2);
  });

  it('falls to the first prefix when the enrichment outgrows what each shorter page frees', () => {
    /** Each dropped item adds 4,000 bytes of enrichment, more than the 3,000 it frees. */
    const { measure, measured, pageBytes } = prefixPage(
      Array(22).fill(3_000),
      0,
      (i) => (21 - i) * 4_000,
    );
    expect(longestFittingPrefix(pageBytes, measure)).toBe(0);
    expect(measured.slice(0, 3)).toEqual([21, 20, 19]);
    expect(measured).toEqual([...measured].sort((a, b) => b - a));
    expect(new Set(measured).size).toBe(measured.length);
    expect(measured).not.toContain(0);
  });

  it('steps down again when the prefix the skip lands on still overflows', () => {
    /**
     * Enrichment grows 1,000 per dropped item. Prefix 9 is 70,000 + 6,200 over;
     * the skip lands on 7: 56,000 + 8,200 = 64,200, still over; then 6:
     * 49,000 + 9,200 = 58,200 fits.
     */
    const { measure, measured, pageBytes } = prefixPage(
      Array(10).fill(7_000),
      0,
      (i) => 6_200 + (9 - i) * 1_000,
    );
    expect(longestFittingPrefix(pageBytes, measure)).toBe(6);
    expect(measured).toEqual([9, 7, 6]);
  });

  it('serves the first prefix, unmeasured, when nothing shorter fits', () => {
    const { measure, measured, pageBytes } = prefixPage([90_000, 100], 0, () => 50);
    expect(longestFittingPrefix(pageBytes, measure)).toBe(0);
    expect(measured).toEqual([1]);
  });

  it('serves a single prefix without measuring it', () => {
    const { measure, measured, pageBytes } = prefixPage([200_000], 0, () => 0);
    expect(longestFittingPrefix(pageBytes, measure)).toBe(0);
    expect(measured).toEqual([]);
  });

  it('measures each prefix at most once when every one overflows by a byte', () => {
    /** Each dropped item frees 320 bytes and grows the enrichment by as many. */
    const { measure, measured, pageBytes } = prefixPage(
      Array(200).fill(320),
      0,
      (i) => 64_001 - 320 * (i + 1),
    );
    expect(longestFittingPrefix(pageBytes, measure)).toBe(0);
    expect(measured).toEqual(Array.from({ length: 199 }, (_, k) => 199 - k));
  });
});
