/**
 * @fileoverview Stubbed HN Firebase API for tool tests that run the real
 * `HnService` — routes each request by path to a JSON body or an HTTP status.
 * @module tests/helpers/hn-api-stub
 */

import { vi } from 'vitest';

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

function pathOf(input: string | URL | Request): string {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  return url.pathname.replace(/^\/v0/, '');
}

/**
 * Install a fetch stub for the HN Firebase API. Keys are paths below `/v0`
 * (`/topstories.json`, `/item/101.json`, `/user/pg.json`); a value is the
 * JSON body to serve — `null` being Firebase's answer for a missing record —
 * or an {@link httpStatus} route. An unrouted path throws, so a test never
 * passes on a request it did not expect. Undo with `vi.unstubAllGlobals()`.
 */
export function stubHnApi(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const path = pathOf(input);
    if (!Object.hasOwn(routes, path)) throw new Error(`Unrouted HN API request: ${path}`);
    const route = routes[path];
    return isStatusRoute(route)
      ? new Response('upstream error', {
          status: route.status,
          ...(route.headers && { headers: route.headers }),
        })
      : Response.json(route);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    /** Paths requested so far, in call order, one entry per attempt. */
    requested: (): string[] => fetchMock.mock.calls.map(([input]) => pathOf(input)),
  };
}
