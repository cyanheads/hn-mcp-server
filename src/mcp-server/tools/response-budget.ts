/**
 * @fileoverview The fixed byte budget a page-returning tool holds each response
 * surface to, and the arithmetic that keeps a page within it: measure both
 * surfaces as the caller receives them — whole, or as a page plus the
 * enrichment the framework adds — then either cut the longest bodies to the
 * largest byte limit they can share, on a code-point boundary, or serve the
 * longest prefix of the page that fits. The tool decides what is cuttable or
 * droppable and how the cut is disclosed.
 * @module mcp-server/tools/response-budget
 */

/** Bytes each surface may carry: all `content[]` text, the enrichment trailer included, and the `structuredContent` JSON. */
export const RESPONSE_BUDGET_BYTES = 64_000;

/** {@link RESPONSE_BUDGET_BYTES} as the descriptions and notices write it. */
export const RESPONSE_BUDGET_TEXT = RESPONSE_BUDGET_BYTES.toLocaleString('en-US');

/** The line `content[]` puts after a body cut to the budget, outside its quote. */
export const cutPointer = (id: number) =>
  `Text cut short to fit the response budget — hn_get_thread with itemId ${id} returns it whole.`;

const utf8 = new TextEncoder();

/** UTF-8 length of `text`. */
export function byteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

/**
 * The longest prefix of `text` within `maxBytes` UTF-8 bytes. It ends on a
 * code-point boundary: a character that would straddle the limit, a surrogate
 * pair included, is left out whole.
 */
export function cutToBytes(text: string, maxBytes: number): string {
  /** `encodeInto` stops before the first code point that does not fit; `read` counts the UTF-16 units it consumed. */
  const { read } = utf8.encodeInto(text, new Uint8Array(maxBytes));
  return text.slice(0, read);
}

/** A response as the handler is about to return it. */
export interface ResponseDraft {
  /** The blocks the definition's `format()` renders for `result`. */
  content: readonly { type: string; text?: string }[];
  /** Every enrichment field the call writes, `notice` included, as the framework will hold them. */
  enrichment: Readonly<Record<string, unknown>>;
  /** The handler's return value. */
  result: Readonly<Record<string, unknown>>;
  /** The definition's `enrichmentTrailer`. */
  trailer?:
    | Readonly<Record<string, { label?: string; render?: (value: never) => string } | undefined>>
    | undefined;
}

/** A response's size on each surface. */
export interface ResponseBytes {
  contentBytes: number;
  structuredBytes: number;
}

/**
 * The bytes the framework's `content[]` trailer takes for `enrichment`, at
 * most one byte per field over. The trailer is rendered after `format()`, out
 * of the handler's sight, so each field is sized as the framework renders it —
 * the definition's `render`, the `notice` as a block quote, any other value as
 * `**key:** value` — plus two bytes: the trailer opens with a blank line and
 * joins its fields with one line break, or two after a block quote.
 *
 * @throws TypeError for a string or object field with no `render`, which the
 * framework renders as a code literal this does not size.
 */
function trailerBytes(enrichment: ResponseDraft['enrichment'], trailer: ResponseDraft['trailer']) {
  let bytes = 0;
  for (const [key, value] of Object.entries(enrichment)) {
    const field = trailer?.[key];
    let line: string;
    if (field?.render) {
      line = field.render(value as never);
    } else if (key === 'notice') {
      line = String(value)
        .split(/\r\n|\r|\n/)
        .map((part) => (part === '' ? '>' : `> ${part}`))
        .join('\n');
    } else if (value == null || typeof value === 'number' || typeof value === 'boolean') {
      line = `**${field?.label ?? key}:** ${String(value)}`;
    } else {
      throw new TypeError(
        `Cannot size enrichment field "${key}" (${typeof value}) for the response budget: give it an enrichmentTrailer render.`,
      );
    }
    bytes += 2 + byteLength(line);
  }
  return bytes;
}

/**
 * The bytes the framework adds to each surface for `enrichment`: its
 * `content[]` trailer, and the `"key":value` members it merges into the
 * `structuredContent` object, each with the comma before it. Exact for a
 * result that serializes with at least one member and shares no key with the
 * enrichment. A tool that sizes its page as it builds it adds this to the
 * page's own bytes; {@link measureResponse} does the same for a whole draft.
 *
 * @throws TypeError for a string or object field with no `render`, as
 * {@link measureResponse} does.
 */
export function enrichmentBytes(
  enrichment: ResponseDraft['enrichment'],
  trailer?: ResponseDraft['trailer'],
): ResponseBytes {
  let structuredBytes = 0;
  for (const [key, value] of Object.entries(enrichment)) {
    /** `undefined` is what JSON.stringify returns for a value it leaves out of an object. */
    const json = JSON.stringify(value) as string | undefined;
    if (json !== undefined)
      structuredBytes += 2 + byteLength(JSON.stringify(key)) + byteLength(json);
  }
  return { contentBytes: trailerBytes(enrichment, trailer), structuredBytes };
}

/**
 * Size a response on both surfaces as the caller receives it: every `content[]`
 * text block plus the enrichment trailer the framework appends, and the
 * `structuredContent` JSON — the handler's return merged with its enrichment,
 * which shares none of the return's keys.
 */
export function measureResponse(draft: ResponseDraft): ResponseBytes {
  const added = enrichmentBytes(draft.enrichment, draft.trailer);
  let contentBytes = added.contentBytes;
  for (const block of draft.content) {
    if (block.type === 'text' && block.text != null) contentBytes += byteLength(block.text);
  }
  const result = JSON.stringify(draft.result);
  /** Merged into an object with no members, the first field takes no comma. */
  const noComma = result === '{}' && added.structuredBytes > 0 ? 1 : 0;
  return { contentBytes, structuredBytes: byteLength(result) + added.structuredBytes - noComma };
}

/** True when both surfaces are within {@link RESPONSE_BUDGET_BYTES}. */
export function fitsBudget(bytes: ResponseBytes): boolean {
  return (
    bytes.contentBytes <= RESPONSE_BUDGET_BYTES && bytes.structuredBytes <= RESPONSE_BUDGET_BYTES
  );
}

/**
 * The largest byte limit at which the page fits the budget when every body
 * longer than the limit is cut to it and every other body stays whole.
 *
 * Every body reaches each surface at least once, whole or cut, so a page cut
 * at a limit carries at least the bodies' bytes at that limit on each surface.
 * No limit whose body bytes alone exceed the budget can fit, and none is
 * measured: every page `measure` renders is within the budget in body bytes,
 * however long the bodies are.
 *
 * A page's size is not monotone in the limit: raising it to a body's length
 * returns that body whole, which drops its cut disclosure, so a page can fit at
 * a body's length and not one byte below. The limits are therefore searched as
 * cut sets — the longest body alone, then the two longest — each tried at its
 * lowest limit, where it cuts its bodies furthest. The answer is the first set
 * that fits there, bisected within, where the size does grow with the limit.
 * The first set the body bytes allow is measured, then the last; between them
 * the sets are bisected, on the assumption that once one set fits every larger
 * one does — where an earlier set also fits, a smaller limit is served. That is
 * at most two measurements plus a bisection over the sets and one within.
 *
 * @param bodyBytes UTF-8 length of each cuttable body; 0 for an item without
 *   one. Each body must reach both surfaces, at least once, cut or whole.
 * @param measure Both surfaces with every body longer than `limitBytes` cut to
 *   it. With the same bodies cut, a larger limit must never measure smaller.
 * @returns 0 when even cutting every body to nothing leaves the page over
 *   budget — the smallest page cutting can make.
 */
export function largestFittingLimit(
  bodyBytes: readonly number[],
  measure: (limitBytes: number) => ResponseBytes,
): number {
  const lengths = [...new Set(bodyBytes)].filter((n) => n > 0).sort((a, b) => b - a);
  const longest = lengths[0];
  if (longest === undefined) return 0;

  /** The body bytes a page cut at `limit` carries on each surface, at least. */
  const bodiesAt = (limit: number) =>
    bodyBytes.reduce((sum, bytes) => sum + Math.min(bytes, limit), 0);
  /** The highest limit whose body bytes fit; nothing above it can. */
  let ceiling = 0;
  for (let high = longest; ceiling < high; ) {
    const mid = Math.ceil((ceiling + high) / 2);
    if (bodiesAt(mid) <= RESPONSE_BUDGET_BYTES) ceiling = mid;
    else high = mid - 1;
  }

  /** Cut set `i` takes limits from its lowest, `lowestOf(i)`, up to one below its own length. */
  const lowestOf = (i: number) => lengths[i + 1] ?? 0;
  const fitsAtLowest = (i: number) => fitsBudget(measure(lowestOf(i)));
  const last = lengths.length - 1;
  let set = lengths.findIndex((_, i) => lowestOf(i) <= ceiling);
  if (!fitsAtLowest(set)) {
    if (set === last || !fitsAtLowest(last)) return 0;
    /** `set` overflows at its lowest limit and `fitting` fits at its own. */
    let fitting = last;
    while (fitting - set > 1) {
      const mid = Math.floor((set + fitting) / 2);
      if (fitsAtLowest(mid)) fitting = mid;
      else set = mid;
    }
    set = fitting;
  }

  let lowest = lowestOf(set);
  let highest = Math.min((lengths[set] as number) - 1, ceiling);
  while (lowest < highest) {
    const mid = Math.ceil((lowest + highest) / 2);
    if (fitsBudget(measure(mid))) lowest = mid;
    else highest = mid - 1;
  }
  return lowest;
}

/**
 * Which of a page's prefixes to serve: the longest found to fit the budget, or
 * the first — the shortest the caller allows, served even over budget — when
 * none does.
 *
 * Prefixes are tried from the longest. One that overflows rules out each
 * shorter prefix whose page, plus the bytes that measurement spent beyond its
 * page, would still overflow, so the next prefix tried is the longest left.
 * That skip holds while those other bytes — the enrichment — do not grow as
 * the page shortens; where they shrink, a skipped prefix might have fit and a
 * shorter one is served. Each prefix is measured at most once, the first never.
 *
 * @param pageBytes Each prefix's page alone, without what `measure` adds, in
 *   prefix order; none smaller than the one before it.
 * @param measure The whole response serving prefix `index`.
 * @returns The index of the prefix to serve.
 */
export function longestFittingPrefix(
  pageBytes: readonly ResponseBytes[],
  measure: (index: number) => ResponseBytes,
): number {
  let index = pageBytes.length - 1;
  while (index > 0) {
    const bytes = measure(index);
    if (fitsBudget(bytes)) return index;
    const page = pageBytes[index] as ResponseBytes;
    const extraContent = bytes.contentBytes - page.contentBytes;
    const extraStructured = bytes.structuredBytes - page.structuredBytes;
    const fitsWithExtra = ({ contentBytes, structuredBytes }: ResponseBytes) =>
      fitsBudget({
        contentBytes: contentBytes + extraContent,
        structuredBytes: structuredBytes + extraStructured,
      });
    do index--;
    while (index > 0 && !fitsWithExtra(pageBytes[index] as ResponseBytes));
  }
  return 0;
}
