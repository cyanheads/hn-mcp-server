/**
 * @fileoverview Worst-case timing checks measured in the test thread's own CPU
 * time, never wall clock, so machine load cannot decide them: time the thread
 * spends descheduled is not counted.
 * @module tests/helpers/cpu-time
 */

import { expect } from 'vitest';

/** CPU one sampling round spends at least — several of the 1–4 ms ticks Linux counts thread CPU in. */
const MIN_ROUND_MS = 20;

/** Rounds per reading; the fastest is kept, as the one least disturbed by GC and JIT warm-up. */
const ROUNDS = 3;

/** The per-call ceiling {@link expectLinearCpu} applies by default: 10 ms plus 1 ms per 1,000 characters. */
const DEFAULT_MAX_MS = (chars: number) => 10 + chars / 1_000;

/** This thread's CPU time so far, in ms. */
function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1_000;
}

/**
 * CPU ms one call of `fn` costs: the fastest of {@link ROUNDS} rounds, each
 * calling `fn` until the round has spent at least {@link MIN_ROUND_MS}, so a
 * call far shorter than the clock's tick still reads accurately.
 */
export function cpuMsPerCall(fn: () => void): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let round = 0; round < ROUNDS; round++) {
    const start = threadCpuMs();
    let calls = 0;
    let spent = 0;
    do {
      fn();
      calls++;
      spent = threadCpuMs() - start;
    } while (spent < MIN_ROUND_MS);
    fastest = Math.min(fastest, spent / calls);
  }
  return fastest;
}

/** What {@link expectLinearCpu} measures, over which sizes, against which ceiling. */
export interface LinearCpuCheck {
  /** Smallest input, in characters. Defaults to 5,000. */
  from?: number;
  /** Build an input of about `chars` characters. */
  make: (chars: number) => string;
  /** The most CPU ms one call may cost at `chars` characters. Defaults to 10 ms plus 1 ms per 1,000 characters. */
  maxMs?: (chars: number) => number;
  /** The code under test. */
  run: (input: string) => void;
  /** Largest input, in characters. Defaults to 320,000, a 64× span. */
  to?: number;
}

/**
 * Assert that `run` grows linearly in its input. Sizes double from `from` to
 * `to`, and each size's per-call CPU must stay under `maxMs` before the next
 * size runs, so a quadratic regression fails at a small size in seconds rather
 * than grinding through the large ones. The largest size must then cost less
 * than four times the span over the smallest — 256× across the default 64×
 * span — which a linear function clears with room and a quadratic one cannot.
 * No step-to-step ratio is asserted.
 */
export function expectLinearCpu({
  from = 5_000,
  make,
  maxMs = DEFAULT_MAX_MS,
  run,
  to = 320_000,
}: LinearCpuCheck): void {
  const readings: number[] = [];
  let largest = from;
  for (let chars = from; chars <= to; chars *= 2) {
    const input = make(chars);
    const ms = cpuMsPerCall(() => run(input));
    expect(ms, `CPU ms per call at ${chars} characters`).toBeLessThan(maxMs(chars));
    readings.push(ms);
    largest = chars;
  }

  const growth = (readings.at(-1) ?? Number.NaN) / (readings[0] ?? Number.NaN);
  expect(growth, `CPU growth from ${from} to ${largest} characters`).toBeLessThan(
    (4 * largest) / from,
  );
}
