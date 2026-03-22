/**
 * @fileoverview HN API service — Firebase and Algolia HTTP clients with HTML stripping utilities.
 * @module services/hn/hn-service
 */

import { getServerConfig } from '@/config/server-config.js';
import type { AlgoliaResponse, HnFeedType, HnItem, HnUser } from './types.js';

const HN_API = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA_API = 'https://hn.algolia.com/api/v1';

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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HnService {
  private readonly concurrencyLimit: number;

  constructor(concurrencyLimit: number) {
    this.concurrencyLimit = concurrencyLimit;
  }

  /** Fetch a single item by ID. Returns null if missing or on error. */
  async fetchItem(id: number): Promise<HnItem | null> {
    try {
      const res = await fetch(`${HN_API}/item/${id}.json`);
      if (!res.ok) return null;
      return (await res.json()) as HnItem | null;
    } catch {
      return null;
    }
  }

  /** Fetch a user profile by username. Returns null if missing or on error. */
  async fetchUser(username: string): Promise<HnUser | null> {
    try {
      const res = await fetch(`${HN_API}/user/${username}.json`);
      if (!res.ok) return null;
      return (await res.json()) as HnUser | null;
    } catch {
      return null;
    }
  }

  /** Fetch a feed's ID array. Throws on failure. */
  async fetchFeed(type: HnFeedType): Promise<number[]> {
    const endpoint = type === 'jobs' ? 'jobstories' : `${type}stories`;
    const res = await fetch(`${HN_API}/${endpoint}.json`);
    if (!res.ok) throw new Error(`Failed to fetch ${type} feed: HTTP ${res.status}`);
    return (await res.json()) as number[];
  }

  /** Batch-fetch items with concurrency limiting. Preserves input order. */
  async fetchItems(ids: number[]): Promise<(HnItem | null)[]> {
    if (ids.length === 0) return [];

    const results = new Array<HnItem | null>(ids.length).fill(null);
    let next = 0;

    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        const id = ids[i];
        if (id != null) results[i] = await this.fetchItem(id);
      }
    };

    const workerCount = Math.min(this.concurrencyLimit, ids.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }

  /** Search HN via Algolia. Throws on failure. */
  async search(params: {
    query: string;
    tags?: string | undefined;
    author?: string | undefined;
    sort: 'relevance' | 'date';
    dateRange?: { start?: string | undefined; end?: string | undefined } | undefined;
    minPoints?: number | undefined;
    count: number;
    page: number;
  }): Promise<AlgoliaResponse> {
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

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Algolia search failed: HTTP ${res.status}`);
    return (await res.json()) as AlgoliaResponse;
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
