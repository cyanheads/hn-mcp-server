/**
 * @fileoverview Tests for the CPU-time linearity check the worst-case timing
 * suites share: a quadratic stand-in fails it, fast, and a linear one passes.
 * @module tests/helpers/cpu-time.test
 */

import { describe, expect, it } from 'vitest';
import { expectLinearCpu } from './cpu-time.js';

/** Alternating characters, about `n` of them. */
const alternating = (n: number) => 'ab'.repeat(Math.ceil(n / 2)).slice(0, n);

/** Written to so the engine cannot discard the stand-ins' work. */
let sink = 0;

/** Counts equal character pairs: quadratic in the input by construction. */
function countEqualPairs(text: string): void {
  let pairs = 0;
  for (let i = 0; i < text.length; i++) {
    for (let j = i + 1; j < text.length; j++) {
      if (text.charCodeAt(i) === text.charCodeAt(j)) pairs++;
    }
  }
  sink = pairs;
}

/** Counts the characters equal to the first one: one pass over the input. */
function countFirstCharacter(text: string): void {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === text.charCodeAt(0)) count++;
  }
  sink = count;
}

/** CPU ms this thread spends in `fn`. */
function cpuMsOf(fn: () => void): number {
  const before = process.threadCpuUsage();
  fn();
  const { user, system } = process.threadCpuUsage(before);
  return (user + system) / 1_000;
}

describe('expectLinearCpu — worst-case timing check', () => {
  it('fails a quadratic stand-in on the default per-size ceiling, well short of the largest size', () => {
    let failure: unknown;
    const spent = cpuMsOf(() => {
      try {
        expectLinearCpu({ make: alternating, run: countEqualPairs });
      } catch (error) {
        failure = error;
      }
    });

    expect(String(failure)).toMatch(/CPU ms per call at (5|10|20|40|80)000 characters/);
    expect(spent).toBeLessThan(10_000);
  }, 120_000);

  it('fails a quadratic stand-in on the growth ratio when every size stays under the ceiling', () => {
    expect(() =>
      expectLinearCpu({
        from: 1_000,
        to: 16_000,
        make: alternating,
        run: countEqualPairs,
        maxMs: () => Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/CPU growth from 1000 to 16000 characters/);
  }, 120_000);

  it('passes a single pass over the same input, doubling across the default 5,000 to 320,000 span', () => {
    const sizes: number[] = [];
    const make = (chars: number) => {
      sizes.push(chars);
      return alternating(chars);
    };

    expect(() => expectLinearCpu({ make, run: countFirstCharacter })).not.toThrow();
    expect(sizes).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000]);
    /** The last call counted the "a"s of the largest input. */
    expect(sink).toBe(160_000);
  }, 120_000);
});
