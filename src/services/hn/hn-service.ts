/**
 * @fileoverview HN API service — Firebase and Algolia HTTP clients with HTML stripping utilities.
 * @module services/hn/hn-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import type { AlgoliaResponse, HnFeedType, HnItem, HnUser } from './types.js';

const HN_API = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA_API = 'https://hn.algolia.com/api/v1';
const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// HTML utilities
// ---------------------------------------------------------------------------

/** The named entities HN emits. A `Map`, so a name like `constructor` finds nothing inherited. */
const HTML_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

/**
 * A numeric reference's character. NUL, surrogates, and values past U+10FFFF
 * decode to U+FFFD, as in HTML, and so does U+0001 — so decoding never yields
 * either character the strip masks are built on, and an out-of-range value
 * never throws.
 */
function fromCodePoint(codePoint: number): string {
  const replaced =
    codePoint <= 1 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff);
  return String.fromCodePoint(replaced ? 0xfffd : codePoint);
}

/** Decode numeric and named HTML entities. An undeclared name stays as typed. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(\w+));/g, (match, hex, dec, named) => {
    if (hex) return fromCodePoint(parseInt(hex, 16));
    if (dec) return fromCodePoint(parseInt(dec, 10));
    return HTML_ENTITIES.get(named) ?? match;
  });
}

/**
 * Masks that hold a code block's place, or a highlight marker's, while the rest
 * of the HTML is rewritten. Each opens with U+0000 and closes with U+0001, so
 * text between two adjacent masks cannot borrow the close of one and the open
 * of the next to spell a third. The strip removes both characters from its
 * input before masking, and {@link decodeHtmlEntities} never produces either,
 * so no upstream text can spell a mask.
 */
const MASK_OPEN = '\u0000';
const MASK_CLOSE = '\u0001';
const EM_OPEN = `${MASK_OPEN}EM_OPEN${MASK_CLOSE}`;
const EM_CLOSE = `${MASK_OPEN}EM_CLOSE${MASK_CLOSE}`;
const EM_MASK = new RegExp(`${EM_OPEN}|${EM_CLOSE}`, 'g');
const CODE_MASK = new RegExp(`${MASK_OPEN}CODE_(\\d+)${MASK_CLOSE}`, 'g');
const MASK_CHARACTERS = new RegExp(`[${MASK_OPEN}${MASK_CLOSE}]`, 'g');

const CODE_OPEN = /<pre><code>/gi;
const CODE_CLOSE = /<\/code><\/pre>/gi;
const LINK_OPEN = /<a\s+href="([^"]*)"[^>]*>/gi;
const LINK_CLOSE = /<\/a>/gi;

/** A trailing entity a truncation cut short, such as the `&#3` left of `&#38;`. */
const PARTIAL_ENTITY = /&#?[0-9A-Za-z]*$/;

/**
 * Replace each `open … close` span, leftmost opener first and the nearest closer
 * after it, with `render(opener, inner)`. An opener with no closer after it ends
 * the scan — no later opener can find one either — so every search runs forward
 * once and a pass stays linear, where a lazy `open([\s\S]*?)close` regex rescans
 * to the end for each unclosed opener.
 */
function replaceSpans(
  text: string,
  open: RegExp,
  close: RegExp,
  render: (opener: RegExpExecArray, inner: string) => string,
): string {
  let out = '';
  let last = 0;
  open.lastIndex = 0;
  for (let opener = open.exec(text); opener; opener = open.exec(text)) {
    close.lastIndex = open.lastIndex;
    const closer = close.exec(text);
    if (!closer) break;
    out +=
      text.slice(last, opener.index) + render(opener, text.slice(open.lastIndex, closer.index));
    last = open.lastIndex = close.lastIndex;
  }
  return out + text.slice(last);
}

/**
 * Apply `rewrite` to the text up to its last `>`. No tag can close past that
 * point, and leaving it out keeps a regex from rescanning to the end of the
 * string for every unmatched `<` there.
 */
function throughLastTag(text: string, rewrite: (head: string) => string): string {
  const end = text.lastIndexOf('>') + 1;
  return rewrite(text.slice(0, end)) + text.slice(end);
}

/**
 * Remove every tag. One pass is complete: a `<` the pass leaves is followed
 * directly by `>` or by no `>` at all, and removing a tag changes neither.
 */
function stripTags(text: string): string {
  return throughLastTag(text, (head) => head.replace(/<[^>]+>/g, ''));
}

/**
 * Render one link. HN cuts long link text to a prefix ending in `...`, and older
 * items encode `/` in the text but not the href, so the two are compared
 * decoded, with highlight markers set aside. When the text is the href, or a
 * `...`-cut prefix of it (less any entity the cut left partial), the href
 * renders alone, carrying the text's markers on the same characters. Any other
 * link renders as `text (href)`.
 *
 * The collapsed href goes back re-encoded (`&`, `<`, `>`), so the strip's one
 * decoding pass restores it exactly and its tag strip never reads it as markup.
 */
function renderLink(rawHref: string, rawText: string): string {
  const href = decodeHtmlEntities(rawHref);
  const markers: { at: number; marker: string }[] = [];
  let text = '';
  let from = 0;
  for (const match of rawText.matchAll(EM_MASK)) {
    text += decodeHtmlEntities(stripTags(rawText.slice(from, match.index)));
    markers.push({ at: text.length, marker: match[0] });
    from = match.index + match[0].length;
  }
  text += decodeHtmlEntities(stripTags(rawText.slice(from)));

  const prefix =
    text === href
      ? href
      : text.endsWith('...')
        ? text.slice(0, -3).replace(PARTIAL_ENTITY, '')
        : undefined;
  if (prefix === undefined || !href.startsWith(prefix)) return `${rawText} (${rawHref})`;

  let rendered = '';
  let cut = 0;
  for (const { at, marker } of markers) {
    const position = Math.min(at, prefix.length);
    rendered += href.slice(cut, position) + marker;
    cut = position;
  }
  rendered += href.slice(cut);
  return rendered.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** The strip both public entry points share; `keepEm` carries Algolia's highlight markers through. */
function toPlainText(html: string, keepEm: boolean): string {
  if (!html) return '';

  let text = html.replace(MASK_CHARACTERS, '');
  if (keepEm) text = text.replaceAll('<em>', EM_OPEN).replaceAll('</em>', EM_CLOSE);

  const codeBlocks: string[] = [];
  text = replaceSpans(text, CODE_OPEN, CODE_CLOSE, (_opener, code) => {
    codeBlocks.push(code);
    return `${MASK_OPEN}CODE_${codeBlocks.length - 1}${MASK_CLOSE}`;
  });

  text = text.replace(/<p>/gi, '\n\n');
  text = throughLastTag(text, (head) =>
    replaceSpans(head, LINK_OPEN, LINK_CLOSE, (opener, inner) =>
      renderLink(opener[1] ?? '', inner),
    ),
  );
  text = stripTags(text);
  text = text.replace(CODE_MASK, (_, i: string) => codeBlocks[Number(i)] ?? '');
  text = decodeHtmlEntities(text).trim();

  return keepEm ? text.replaceAll(EM_OPEN, '<em>').replaceAll(EM_CLOSE, '</em>') : text;
}

/**
 * Strip an HN HTML body (`text`, `about`, and Algolia's `comment_text` /
 * `story_text`) to plain text: `<p>` becomes a blank line, code blocks are kept
 * verbatim, each link renders once as its full URL — or as `text (url)` when
 * the text is something else — other tags are removed, and entities are
 * decoded exactly once. Titles are not HTML, though some arrive entity-encoded:
 * they take {@link decodeHtmlEntities} alone and never pass through here.
 */
export function stripHtml(html: string): string {
  return toPlainText(html, false);
}

/**
 * {@link stripHtml} for an Algolia highlight snippet, which is the field's HTML
 * with `<em>` inserted around matched terms: the `<em>…</em>` markers survive,
 * including inside a link collapsed to its href.
 */
export function stripHtmlPreservingEm(html: string): string {
  return toPlainText(html, true);
}

/** Normalize empty URL strings to undefined. */
export function normalizeUrl(url?: string | null): string | undefined {
  return url?.trim() || undefined;
}

/**
 * Extract the bare hostname (lowercased, leading `www.` stripped) from a URL.
 * Returns undefined for missing or unparseable URLs.
 */
export function extractDomain(url: string | undefined): string | undefined {
  if (!url) return;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return;
  }
}

/**
 * Convert a validated ISO 8601 date bound to its exact instant in Unix
 * milliseconds. A date-time without a `Z` or `±hh:mm` offset is read as UTC —
 * the same as a date-only value, and unlike JS's own parsing, which reads it in
 * the host's local time zone.
 */
export function dateBoundToEpochMs(bound: string): number {
  const offsetless = bound.includes('T') && !/(?:Z|[+-]\d{2}:\d{2})$/.test(bound);
  return Date.parse(offsetless ? `${bound}Z` : bound);
}

/**
 * Convert a validated ISO 8601 date bound to Unix seconds, read as
 * {@link dateBoundToEpochMs} reads it.
 *
 * A fractional second rounds down by default, which suits an exclusive start.
 * An exclusive end over whole-second timestamps passes `'ceil'`: an end at
 * `10:00:00.5` must still admit an item created at `10:00:00`.
 */
export function dateBoundToEpochSeconds(
  bound: string,
  rounding: 'floor' | 'ceil' = 'floor',
): number {
  return Math[rounding](dateBoundToEpochMs(bound) / 1000);
}

/**
 * One slot of a {@link HnService.fetchItems} batch, in input order.
 *
 * - `item` — HN returned the item. It may be dead or deleted; callers filter.
 * - `absent` — HN answered `null`: no item exists under this ID.
 * - `failed` — the fetch failed after retries, or never started because an
 *   earlier slot was rate-limited. `error` is the classified failure. A later
 *   call may succeed, so a caller reports the ID rather than dropping it.
 */
export type ItemSlot =
  | { kind: 'item'; id: number; item: HnItem }
  | { kind: 'absent'; id: number }
  | { kind: 'failed'; id: number; error: unknown };

/**
 * Settle one page of a batch for the paged tools: the live items in input
 * order, and the IDs whose fetch failed. Dead, deleted, and absent slots drop
 * out of both. When every slot failed, throws the first failure's classified
 * error, since an empty success would read as a page with nothing on it.
 */
export function settlePage(slots: readonly ItemSlot[]): { items: HnItem[]; failedIds: number[] } {
  const items: HnItem[] = [];
  const failedIds: number[] = [];
  let firstFailure: { error: unknown } | undefined;
  for (const slot of slots) {
    if (slot.kind === 'failed') {
      failedIds.push(slot.id);
      firstFailure ??= slot;
    } else if (slot.kind === 'item' && !slot.item.deleted && !slot.item.dead) {
      items.push(slot.item);
    }
  }
  if (firstFailure && failedIds.length === slots.length) throw firstFailure.error;
  return { items, failedIds };
}

/** True for the classified 429 `getJson` throws once retries are spent or the wait outlasts them. */
export function isRateLimited(err: unknown): err is McpError {
  return err instanceof McpError && err.data?.reason === 'upstream_rate_limited';
}

/** Detect HTML error bodies returned by upstream APIs under rate limiting or maintenance. */
function isHtmlErrorBody(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/**
 * Parse an HN/Algolia JSON body. Both ways a 200 response can still be unusable
 * — an HTML error page (common during upstream rate limiting) and a body that
 * is not JSON at all — throw a classified error rather than a raw `SyntaxError`,
 * whose message quotes the offending body back at the client.
 */
function parseJsonBody<T>(text: string, upstream: string): T {
  if (isHtmlErrorBody(text)) {
    throw serviceUnavailable(`${upstream} returned HTML instead of JSON — likely rate-limited.`, {
      upstream,
      reason: 'upstream_html',
      recovery: {
        hint: `${upstream} appears to be rate-limited or in maintenance. Retry after a brief delay.`,
      },
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw serviceUnavailable(
      `${upstream} returned a body that is not JSON.`,
      {
        upstream,
        reason: 'upstream_malformed',
        recovery: {
          hint: `${upstream} answered 200 with a body that is not its API response. Retry after a brief delay; no input change helps while the upstream is serving something else.`,
        },
      },
      { cause: err },
    );
  }
}

/**
 * Map an upstream HTTP status onto a contract reason, its JSON-RPC code, and
 * the agent's next move. Three buckets: 429 is a pacing problem, 5xx is an
 * upstream outage, and every other 4xx means the request itself was rejected
 * and will be rejected again unchanged.
 *
 * The code travels with the reason rather than being taken from the framework's
 * finer-grained status ladder, so each reason surfaces exactly the code its
 * tools declare in `errors[]`. That ladder would otherwise split one reason
 * across several codes — HN answers an unknown path with 401, and a 504 would
 * arrive as `Timeout`, blurring "this server's own fetch timed out" with an
 * upstream that is merely down. The exact status stays on `data.status`.
 *
 * A 429's raw `Retry-After` header (delta-seconds or an HTTP-date), which
 * `fetchWithTimeout` leaves on the cause, is copied to `data.retryAfter`
 * unchanged and named in the hint, so the caller can wait exactly the interval
 * the upstream asked for.
 */
function upstreamFailureFor(upstream: string, status: number, cause: McpError): McpError {
  if (status === 429) {
    const header = cause.data?.retryAfter;
    const retryAfter = typeof header === 'string' && header.trim() !== '' ? header : undefined;
    const wait = retryAfter && (/^\d+$/.test(retryAfter) ? `${retryAfter} seconds` : retryAfter);
    return rateLimited(
      `${upstream} returned HTTP ${status}.`,
      {
        upstream,
        status,
        reason: 'upstream_rate_limited',
        ...(retryAfter && { retryAfter }),
        recovery: {
          hint: wait
            ? `${upstream} is rate-limiting this server and asked it to retry after ${wait}. Wait that long before retrying the same call, and reduce how often it is called.`
            : `${upstream} is rate-limiting this server. Wait several seconds before retrying the same call, and reduce how often it is called.`,
        },
      },
      { cause },
    );
  }
  if (status >= 500) {
    return serviceUnavailable(
      `${upstream} returned HTTP ${status}.`,
      {
        upstream,
        status,
        reason: 'upstream_unavailable',
        recovery: {
          hint: `${upstream} is failing or in maintenance. Retry after a short delay — no input change helps while the upstream is down.`,
        },
      },
      { cause },
    );
  }
  return invalidParams(
    `${upstream} returned HTTP ${status}.`,
    {
      upstream,
      status,
      reason: 'upstream_rejected',
      recovery: {
        hint: `${upstream} rejected the request as malformed. Check the tool input values against the schema; retrying the same input fails identically.`,
      },
    },
    { cause },
  );
}

/**
 * Translate `fetchWithTimeout`'s raw non-2xx throw into a classified error
 * carrying `reason` and `recovery.hint`, matching the shape `parseJsonBody`
 * already produces for HTML error bodies.
 *
 * Wraps *outside* `withRetry` so the framework's own classification is left
 * untouched: retry eligibility, `Retry-After` honoring, timeouts, and caller
 * aborts all resolve against the original error, and only HTTP-status failures
 * (`errorSource: 'FetchHttpError'`) are rewritten. The message drops the
 * upstream URL and the verbatim response body, which stay on the `cause` chain
 * for server-side logs.
 */
async function withUpstreamHttpErrors<T>(upstream: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof McpError) || err.data?.errorSource !== 'FetchHttpError') throw err;
    const status = err.data.status;
    if (typeof status !== 'number') throw err;

    throw upstreamFailureFor(upstream, status, err);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HnService {
  private readonly concurrencyLimit: number;

  constructor(concurrencyLimit: number) {
    this.concurrencyLimit = concurrencyLimit;
  }

  /**
   * GET a JSON document from an upstream, with retries around the full
   * fetch-and-parse pipeline and both failure shapes — non-2xx status and
   * HTML-instead-of-JSON — classified onto a contract reason.
   */
  private getJson<T>(
    upstream: string,
    operation: string,
    url: string | URL,
    ctx: Context,
  ): Promise<T> {
    return withUpstreamHttpErrors(upstream, () =>
      withRetry(
        async () => {
          const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, ctx, {
            signal: ctx.signal,
          });
          return parseJsonBody<T>(await res.text(), upstream);
        },
        { operation, context: ctx, signal: ctx.signal },
      ),
    );
  }

  /** Fetch a single item by ID. Returns null when HN reports the item is missing. */
  fetchItem(id: number, ctx: Context): Promise<HnItem | null> {
    return this.getJson('HN API', 'hn.fetchItem', `${HN_API}/item/${id}.json`, ctx);
  }

  /**
   * Fetch a user profile by username. Returns null when the user does not exist.
   * The username is percent-encoded as a single path segment — an unencoded
   * value containing `/` or dot-segments would otherwise escape the `/user/`
   * route and resolve to a different Firebase resource.
   */
  fetchUser(username: string, ctx: Context): Promise<HnUser | null> {
    return this.getJson(
      'HN API',
      'hn.fetchUser',
      `${HN_API}/user/${encodeURIComponent(username)}.json`,
      ctx,
    );
  }

  /** Fetch a feed's ID array. Throws on upstream failure after retries. */
  fetchFeed(type: HnFeedType, ctx: Context): Promise<number[]> {
    const endpoint = type === 'jobs' ? 'jobstories' : `${type}stories`;
    return this.getJson('HN API', 'hn.fetchFeed', `${HN_API}/${endpoint}.json`, ctx);
  }

  /**
   * Batch-fetch items with concurrency limiting: one {@link ItemSlot} per ID,
   * in input order. A per-item failure after exhausted retries fills a
   * `failed` slot, so one bad item does not fail the batch. Two failures are
   * not per-item:
   *
   * - A caller abort rethrows, ending the batch instead of spending the rest of
   *   the ID list on fetches nobody is waiting for.
   * - An `upstream_rate_limited` failure stops the batch. Fetches already in
   *   flight settle, and every slot not yet started is reported `failed` with
   *   that error, rather than each running its own retry ladder against a
   *   throttled upstream.
   */
  async fetchItems(ids: readonly number[], ctx: Context): Promise<ItemSlot[]> {
    const slots = new Array<ItemSlot | undefined>(ids.length);
    let rateLimit: McpError | undefined;
    let next = 0;

    const worker = async () => {
      while (!rateLimit && next < ids.length) {
        const i = next++;
        const id = ids[i];
        if (id == null) continue;
        try {
          const item = await this.fetchItem(id, ctx);
          slots[i] = item ? { kind: 'item', id, item } : { kind: 'absent', id };
        } catch (error) {
          if (error instanceof McpError && error.code === JsonRpcErrorCode.RequestCancelled) {
            throw error;
          }
          slots[i] = { kind: 'failed', id, error };
          if (isRateLimited(error)) rateLimit ??= error;
          ctx.log.warning('Batch item fetch failed after retries', {
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    const workerCount = Math.min(this.concurrencyLimit, ids.length);
    await Promise.all(Array.from({ length: workerCount }, worker));

    const skipped = ids.length - next;
    if (rateLimit && skipped > 0) {
      ctx.log.warning('Batch stopped: upstream rate-limited, remaining items not fetched', {
        skipped,
      });
    }
    return ids.map((id, i) => slots[i] ?? { kind: 'failed', id, error: rateLimit });
  }

  /**
   * Search HN via Algolia. Throws on upstream failure after retries. An omitted
   * `query` sends no `query` param, making a filter-only search; the tags are
   * comma-joined, which Algolia ANDs. Both date bounds are exclusive.
   */
  search(
    params: {
      query?: string | undefined;
      tags?: string | undefined;
      author?: string | undefined;
      storyId?: number | undefined;
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

    if (params.query != null) url.searchParams.set('query', params.query);
    url.searchParams.set('hitsPerPage', String(params.count));
    url.searchParams.set('page', String(params.page));

    const tagParts: string[] = [];
    if (params.tags) tagParts.push(params.tags);
    if (params.author) tagParts.push(`author_${params.author}`);
    if (params.storyId != null) tagParts.push(`story_${params.storyId}`);
    if (tagParts.length) url.searchParams.set('tags', tagParts.join(','));

    const numericFilters: string[] = [];
    if (params.minPoints != null) numericFilters.push(`points>=${params.minPoints}`);
    if (params.dateRange?.start) {
      numericFilters.push(`created_at_i>${dateBoundToEpochSeconds(params.dateRange.start)}`);
    }
    if (params.dateRange?.end) {
      numericFilters.push(`created_at_i<${dateBoundToEpochSeconds(params.dateRange.end, 'ceil')}`);
    }
    if (numericFilters.length) url.searchParams.set('numericFilters', numericFilters.join(','));

    return this.getJson('Algolia', 'hn.search', url, ctx);
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
