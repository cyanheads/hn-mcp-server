/**
 * @fileoverview HN API service — Firebase and Algolia HTTP clients with HTML stripping utilities.
 * @module services/hn/hn-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import type { AlgoliaResponse, HnFeedType, HnItem, HnUser } from './types.js';

const HN_API = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA_API = 'https://hn.algolia.com/api/v1';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Project a handler Context down to a RequestContext shape for framework
 * utilities. Runtime-safe — the framework only reads log-binding fields —
 * but needed to reconcile exactOptionalPropertyTypes differences between
 * Context.auth (`AuthContext | undefined`) and RequestContext.auth (`AuthContext`).
 */
function toRequestContext(ctx: Context): RequestContext {
  const base: RequestContext = {
    requestId: ctx.requestId,
    timestamp: ctx.timestamp,
  };
  if (ctx.tenantId !== undefined) base.tenantId = ctx.tenantId;
  if (ctx.traceId !== undefined) base.traceId = ctx.traceId;
  if (ctx.spanId !== undefined) base.spanId = ctx.spanId;
  if (ctx.auth !== undefined) base.auth = ctx.auth;
  return base;
}

// ---------------------------------------------------------------------------
// HTML utilities
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode numeric and named HTML entities. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(\w+));/g, (match, hex, dec, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    return HTML_ENTITIES[named] ?? match;
  });
}

/** Strip HN HTML to plain text. Preserves code blocks and link URLs. */
export function stripHtml(html: string): string {
  if (!html) return '';

  // Preserve code blocks
  const codeBlocks: string[] = [];
  let text = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, (_, code: string) => {
    codeBlocks.push(code);
    return `@@CODE_${codeBlocks.length - 1}@@`;
  });

  // Paragraphs → double newline
  text = text.replace(/<p>/gi, '\n\n');

  // Links → text (URL)
  text = text.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, linkText) =>
    linkText === url ? url : `${linkText} (${url})`,
  );

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Restore code blocks
  text = text.replace(/@@CODE_(\d+)@@/g, (_, i: string) => codeBlocks[Number(i)] ?? '');

  return decodeHtmlEntities(text).trim();
}

/** Normalize empty URL strings to undefined. */
export function normalizeUrl(url?: string | null): string | undefined {
  return url?.trim() || undefined;
}

/** Filter out dead, deleted, and null items. */
export function filterLiveItems(items: (HnItem | null)[]): HnItem[] {
  return items.filter((item): item is HnItem => item != null && !item.deleted && !item.dead);
}

/** Detect HTML error bodies returned by upstream APIs under rate limiting or maintenance. */
function isHtmlErrorBody(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/**
 * Parse an HN/Algolia JSON body, throwing a classified error for HTML responses
 * served as 200 OK (common during upstream rate limiting).
 */
function parseJsonBody<T>(text: string, upstream: string): T {
  if (isHtmlErrorBody(text)) {
    throw serviceUnavailable(`${upstream} returned HTML instead of JSON — likely rate-limited.`);
  }
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HnService {
  private readonly concurrencyLimit: number;

  constructor(concurrencyLimit: number) {
    this.concurrencyLimit = concurrencyLimit;
  }

  /** Fetch a single item by ID. Returns null when HN reports the item is missing. */
  fetchItem(id: number, ctx: Context): Promise<HnItem | null> {
    const rc = toRequestContext(ctx);
    return withRetry(
      async () => {
        const res = await fetchWithTimeout(`${HN_API}/item/${id}.json`, REQUEST_TIMEOUT_MS, rc, {
          signal: ctx.signal,
        });
        return parseJsonBody<HnItem | null>(await res.text(), 'HN API');
      },
      { operation: 'hn.fetchItem', context: rc, signal: ctx.signal },
    );
  }

  /** Fetch a user profile by username. Returns null when the user does not exist. */
  fetchUser(username: string, ctx: Context): Promise<HnUser | null> {
    const rc = toRequestContext(ctx);
    return withRetry(
      async () => {
        const res = await fetchWithTimeout(
          `${HN_API}/user/${username}.json`,
          REQUEST_TIMEOUT_MS,
          rc,
          { signal: ctx.signal },
        );
        return parseJsonBody<HnUser | null>(await res.text(), 'HN API');
      },
      { operation: 'hn.fetchUser', context: rc, signal: ctx.signal },
    );
  }

  /** Fetch a feed's ID array. Throws on upstream failure after retries. */
  fetchFeed(type: HnFeedType, ctx: Context): Promise<number[]> {
    const endpoint = type === 'jobs' ? 'jobstories' : `${type}stories`;
    const rc = toRequestContext(ctx);
    return withRetry(
      async () => {
        const res = await fetchWithTimeout(`${HN_API}/${endpoint}.json`, REQUEST_TIMEOUT_MS, rc, {
          signal: ctx.signal,
        });
        return parseJsonBody<number[]>(await res.text(), 'HN API');
      },
      { operation: 'hn.fetchFeed', context: rc, signal: ctx.signal },
    );
  }

  /**
   * Batch-fetch items with concurrency limiting. Preserves input order.
   * Per-item failures after exhausted retries are logged and yield `null`
   * so a single bad item does not fail the whole batch.
   */
  async fetchItems(ids: number[], ctx: Context): Promise<(HnItem | null)[]> {
    if (ids.length === 0) return [];

    const results = new Array<HnItem | null>(ids.length).fill(null);
    let next = 0;

    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        const id = ids[i];
        if (id == null) continue;
        try {
          results[i] = await this.fetchItem(id, ctx);
        } catch (err) {
          ctx.log.warning('Batch item fetch failed after retries', {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    const workerCount = Math.min(this.concurrencyLimit, ids.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }

  /** Search HN via Algolia. Throws on upstream failure after retries. */
  search(
    params: {
      query: string;
      tags?: string | undefined;
      author?: string | undefined;
      sort: 'relevance' | 'date';
      dateRange?: { start?: string | undefined; end?: string | undefined } | undefined;
      minPoints?: number | undefined;
      count: number;
      page: number;
    },
    ctx: Context,
  ): Promise<AlgoliaResponse> {
    const endpoint = params.sort === 'date' ? 'search_by_date' : 'search';
    const url = new URL(`${ALGOLIA_API}/${endpoint}`);

    url.searchParams.set('query', params.query);
    url.searchParams.set('hitsPerPage', String(params.count));
    url.searchParams.set('page', String(params.page));

    const tagParts: string[] = [];
    if (params.tags) tagParts.push(params.tags);
    if (params.author) tagParts.push(`author_${params.author}`);
    if (tagParts.length) url.searchParams.set('tags', tagParts.join(','));

    const numericFilters: string[] = [];
    if (params.minPoints != null) numericFilters.push(`points>=${params.minPoints}`);
    if (params.dateRange?.start) {
      numericFilters.push(
        `created_at_i>${Math.floor(new Date(params.dateRange.start).getTime() / 1000)}`,
      );
    }
    if (params.dateRange?.end) {
      numericFilters.push(
        `created_at_i<${Math.floor(new Date(params.dateRange.end).getTime() / 1000)}`,
      );
    }
    if (numericFilters.length) url.searchParams.set('numericFilters', numericFilters.join(','));

    const rc = toRequestContext(ctx);
    return withRetry(
      async () => {
        const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, rc, {
          signal: ctx.signal,
        });
        return parseJsonBody<AlgoliaResponse>(await res.text(), 'Algolia');
      },
      { operation: 'hn.search', context: rc, signal: ctx.signal },
    );
  }
}

// ---------------------------------------------------------------------------
// Init / accessor
// ---------------------------------------------------------------------------

let _service: HnService | undefined;

export function initHnService(): void {
  const { concurrencyLimit } = getServerConfig();
  _service = new HnService(concurrencyLimit);
}

export function getHnService(): HnService {
  if (!_service) throw new Error('HnService not initialized — call initHnService() in setup()');
  return _service;
}
