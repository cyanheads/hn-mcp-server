/**
 * @fileoverview Tests for the stubbed HN Firebase and Algolia APIs the tool
 * suites share: a route answers only a request to its own API's host and path,
 * so a request built against the wrong host fails the suite that sent it, and a
 * stall route settles the way `fetch` does under an abort.
 * @module tests/helpers/hn-api-stub.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { stall, stubHnApi } from './hn-api-stub.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ITEM_URL = 'https://hacker-news.firebaseio.com/v0/item/1.json';

/** Settle state of `promise`, read without waiting for it. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const routes = { '/item/1.json': { id: 1 }, '/api/v1/search': { hits: [] } };

describe('stubHnApi', () => {
  it.each([
    ['an HN item', 'https://hacker-news.firebaseio.com/v0/item/1.json', '/item/1.json', { id: 1 }],
    [
      'an Algolia search',
      'https://hn.algolia.com/api/v1/search?query=x',
      '/api/v1/search',
      { hits: [] },
    ],
  ])('answers %s on its own host and records its route', async (_label, url, route, body) => {
    const { requested } = stubHnApi(routes);

    const response = await fetch(url);

    expect(await response.json()).toEqual(body);
    expect(requested()).toEqual([route]);
  });

  it.each([
    ['an HN path on another host', 'https://example.com/v0/item/1.json'],
    ['an HN path on the Algolia host', 'https://hn.algolia.com/v0/item/1.json'],
    [
      'an HN path on a host that only starts with the HN API host',
      'https://hacker-news.firebaseio.com.evil.test/v0/item/1.json',
    ],
    [
      'an HN path on a host that only ends with the HN API host',
      'https://evil.hacker-news.firebaseio.com/v0/item/1.json',
    ],
    ['an HN path outside /v0', 'https://hacker-news.firebaseio.com/item/1.json'],
    ['an Algolia path on the HN API host', 'https://hacker-news.firebaseio.com/v0/api/v1/search'],
    ['an Algolia path on another host', 'https://example.com/api/v1/search'],
  ])('fails %s', async (_label, url) => {
    const { requested } = stubHnApi(routes);

    await expect(fetch(url)).rejects.toThrow(/Unrouted HN API request/);
    expect(requested()).toEqual([url]);
  });

  describe('stall', () => {
    it('answers with its body once its delay has passed, and not before', async () => {
      vi.useFakeTimers();
      stubHnApi({ '/item/1.json': stall(1_000, { id: 1 }) });

      const state = track(fetch(ITEM_URL));
      await vi.advanceTimersByTimeAsync(999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(state.settled).toBe(true);
      expect(await (state.value as Response).json()).toEqual({ id: 1 });
    });

    it('rejects with the abort reason when the request is aborted in flight', async () => {
      vi.useFakeTimers();
      stubHnApi({ '/item/1.json': stall(Number.POSITIVE_INFINITY) });
      const controller = new AbortController();

      const state = track(fetch(ITEM_URL, { signal: controller.signal }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.settled).toBe(false);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(state.settled).toBe(true);
      expect(state.error).toBe(controller.signal.reason);
    });

    it('rejects with the abort reason at once when the request was sent already aborted', async () => {
      stubHnApi({ '/item/1.json': stall(Number.POSITIVE_INFINITY) });
      const controller = new AbortController();
      controller.abort();

      await expect(fetch(ITEM_URL, { signal: controller.signal })).rejects.toBe(
        controller.signal.reason,
      );
    });
  });

  describe('onRequest', () => {
    it('names each routed request in call order, and none the stub refuses', async () => {
      const seen: string[] = [];
      stubHnApi(routes, { onRequest: (route) => seen.push(route) });

      await fetch(ITEM_URL);
      await fetch('https://hn.algolia.com/api/v1/search?query=x');
      await fetch('https://example.com/v0/item/1.json').catch(() => undefined);

      expect(seen).toEqual(['/item/1.json', '/api/v1/search']);
    });

    it('runs once a stall route is in flight, so an abort it raises rejects that request', async () => {
      const controller = new AbortController();
      const { requested } = stubHnApi(
        { '/item/1.json': stall(Number.POSITIVE_INFINITY) },
        { onRequest: () => controller.abort() },
      );

      await expect(fetch(ITEM_URL, { signal: controller.signal })).rejects.toBe(
        controller.signal.reason,
      );
      expect(requested()).toEqual(['/item/1.json']);
    });
  });
});
