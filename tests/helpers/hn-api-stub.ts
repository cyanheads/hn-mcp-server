/**
 * @fileoverview Stubbed HN Firebase and Algolia APIs for tool tests that run
 * the real `HnService` — routes each request by host and path to a JSON body,
 * an HTTP status, or a late answer — and a guard that fails any fetch a test
 * did not stub.
 * @module tests/helpers/hn-api-stub
 */

import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Register hooks, for the calling test file, that make any fetch a test did not
 * stub fail loudly instead of reaching the network, and undo every global stub
 * after each test.
 */
export function rejectUnmockedFetch(): void {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        throw new Error(`Unmocked fetch: ${String(input)}`);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

const STATUS = Symbol('httpStatus');

/** A route that answers with an HTTP error status instead of a JSON body. */
interface StatusRoute {
  headers?: Record<string, string>;
  status: number;
  readonly [STATUS]: true;
}

/** Answer a route with `status` (and optional headers) rather than a body. */
export function httpStatus(status: number, headers?: Record<string, string>): StatusRoute {
  return { [STATUS]: true, status, ...(headers && { headers }) };
}

function isStatusRoute(route: unknown): route is StatusRoute {
  return typeof route === 'object' && route !== null && STATUS in route;
}

const STALL = Symbol('stall');

/** A route that answers late, or never. */
interface StallRoute {
  body: unknown;
  ms: number;
  readonly [STALL]: true;
}

/**
 * Answer a route with `body` only after `ms` — never, when `ms` is `Infinity` —
 * rejecting with the abort reason if the request is aborted first, or was
 * already aborted when sent, as `fetch` does. Under fake timers, advancing the
 * clock is what answers it.
 */
export function stall(ms: number, body?: unknown): StallRoute {
  return { [STALL]: true, ms, body };
}

function isStallRoute(route: unknown): route is StallRoute {
  return typeof route === 'object' && route !== null && STALL in route;
}

const HN_API_HOST = 'hacker-news.firebaseio.com';
const ALGOLIA_HOST = 'hn.algolia.com';

/**
 * A request's route key: its path below `/v0` on the HN API host, or its
 * `/api/v1/` path on Algolia's host. Any other request — another host, or one
 * API's path on the other's host — keys as its whole URL, which no route
 * matches.
 */
function routeOf(input: string | URL | Request): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const { hostname, pathname } = url;
  if (hostname === ALGOLIA_HOST && pathname.startsWith('/api/v1/')) return pathname;
  if (hostname === HN_API_HOST && pathname.startsWith('/v0/') && !pathname.startsWith('/v0/api/')) {
    return pathname.slice('/v0'.length);
  }
  return url.href;
}

/**
 * Install a fetch stub for the HN Firebase API and Algolia's search API. Keys
 * are paths below `/v0` (`/topstories.json`, `/item/101.json`,
 * `/user/pg.json`) or Algolia paths (`/api/v1/search`), each answering only on
 * its own API's host; a value is the JSON body to serve — `null` being
 * Firebase's answer for a missing record — an {@link httpStatus} route, or a
 * {@link stall} route. Any other request throws, so a test never passes on a
 * request it did not expect. Undo with `vi.unstubAllGlobals()`.
 *
 * `onRequest` is called with each routed request's key once the stub has taken
 * it up — a stall route is then in flight — so a test can act at that moment,
 * such as aborting the caller's signal.
 */
export function stubHnApi(
  routes: Record<string, unknown>,
  options: { onRequest?: (route: string) => void } = {},
) {
  const answer = (route: unknown, signal: AbortSignal | null | undefined) => {
    if (isStallRoute(route)) {
      return new Promise<Response>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = Number.isFinite(route.ms)
          ? setTimeout(() => resolve(Response.json(route.body)), route.ms)
          : undefined;
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
    return isStatusRoute(route)
      ? new Response('upstream error', {
          status: route.status,
          ...(route.headers && { headers: route.headers }),
        })
      : Response.json(route);
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = routeOf(input);
    if (!Object.hasOwn(routes, path)) throw new Error(`Unrouted HN API request: ${path}`);
    const response = answer(routes[path], init?.signal);
    options.onRequest?.(path);
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    /** Route keys requested so far, in call order, one entry per attempt. */
    requested: (): string[] => fetchMock.mock.calls.map(([input]) => routeOf(input)),
  };
}
