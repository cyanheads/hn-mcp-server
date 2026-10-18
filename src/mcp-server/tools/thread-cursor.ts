/**
 * @fileoverview The hn_get_thread cursor: the unvisited frontier packed as
 * base64url over a varint payload, and a decoder that also reads the JSON
 * format earlier releases issued, accepting every string they accepted.
 * Anything else decodes to `undefined`.
 * @module mcp-server/tools/thread-cursor
 */

import { z } from '@cyanheads/mcp-ts-core';

/** One unvisited comment: its ID, the item it replies to, and its depth below the root. */
export interface FrontierEntry {
  id: number;
  level: number;
  parentId: number;
}

/** The story (or poll) a comment root belongs to, and its author when HN names one. */
export interface CursorStory {
  by?: string | undefined;
  id: number;
}

/** The state a cursor carries between calls. The server keeps none of its own. */
export interface ThreadCursor {
  depth: number;
  /** A depth cut on an earlier page, reported once the cursor runs out. */
  depthCut: boolean;
  frontier: FrontierEntry[];
  itemId: number;
  /** Comments returned by earlier pages. */
  offset: number;
  /** The story a comment root resolved to. Absent when none was resolved. */
  story?: CursorStory;
}

/**
 * Longest cursor accepted, in characters: over four times the longest a real
 * thread issues in either format. A longer one is rejected unread.
 */
export const MAX_CURSOR_LENGTH = 150_000;

/** First payload byte of a packed cursor. Any other payload is read as the JSON format. */
const PACKED_FORMAT = 0x01;

/** Seven value bits per varint byte, so eight bytes cover every safe integer. */
const MAX_VARINT_BYTES = 8;

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Shared by both formats. Each frontier group is `[level, parentId, ...ids]`. */
const CursorStateSchema = z.object({
  offset: z.number().int().min(0),
  itemId: z.number().int(),
  depth: z.number().int().min(1),
  frontier: z.array(z.array(z.number().int().min(0)).min(3)).min(1),
  depthCut: z.literal(true).optional(),
  story: z.object({ id: z.number().int().min(1), by: z.string().min(1).optional() }).optional(),
});

type CursorState = z.infer<typeof CursorStateSchema>;

/** The JSON format also carries `limit`, which nothing reads, and never a story. */
const JsonCursorSchema = CursorStateSchema.omit({ story: true }).extend({
  limit: z.number().int().min(1),
});

const zigzag = (n: number) => (n < 0 ? -2 * n - 1 : 2 * n);
const unzigzag = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

/**
 * Pack a cursor:
 *
 * ```text
 * 0x01                                      format version
 * varint itemId, depth, offset, depthCut (0|1), groupCount
 * per (level, parentId) group:
 *   varint level, zigzag(parentId - itemId), idCount
 *   zigzag varint per ID: delta from the previous ID, the first from parentId
 * varint storyId (0 = none or unresolved)
 *   if non-zero: varint author byte length, then the author as UTF-8
 * ```
 *
 * A run of frontier entries sharing a level and parent forms one group, so
 * siblings share a header; entries keep their traversal order.
 */
export function encodeThreadCursor(state: ThreadCursor): string {
  const out: number[] = [PACKED_FORMAT];
  const varint = (n: number) => {
    let rest = n;
    while (rest >= 0x80) {
      out.push((rest % 0x80) + 0x80);
      rest = Math.floor(rest / 0x80);
    }
    out.push(rest);
  };

  const groups: Array<{ ids: number[]; level: number; parentId: number }> = [];
  for (const { id, level, parentId } of state.frontier) {
    const last = groups.at(-1);
    if (last?.level === level && last.parentId === parentId) last.ids.push(id);
    else groups.push({ ids: [id], level, parentId });
  }

  varint(state.itemId);
  varint(state.depth);
  varint(state.offset);
  varint(state.depthCut ? 1 : 0);
  varint(groups.length);
  for (const { ids, level, parentId } of groups) {
    varint(level);
    varint(zigzag(parentId - state.itemId));
    varint(ids.length);
    let previous = parentId;
    for (const id of ids) {
      varint(zigzag(id - previous));
      previous = id;
    }
  }
  varint(state.story?.id ?? 0);
  if (state.story) {
    const author = utf8.encode(state.story.by ?? '');
    varint(author.length);
    for (const byte of author) out.push(byte);
  }
  return Buffer.from(out).toString('base64url');
}

/**
 * Read a packed payload into the shape {@link CursorStateSchema} validates,
 * throwing on one the layout cannot hold. Every loop step consumes at least one
 * byte or throws, so a count the payload claims never drives more work — or a
 * larger allocation — than the payload's own length.
 */
function unpack(bytes: Uint8Array): unknown {
  let at = 1;
  const varint = (): number => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < MAX_VARINT_BYTES; i++) {
      const byte = bytes[at++];
      if (byte === undefined) throw new Error('truncated');
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (value > Number.MAX_SAFE_INTEGER) throw new Error('unsafe integer');
        return value;
      }
      scale *= 0x80;
    }
    throw new Error('varint too long');
  };

  const itemId = varint();
  const depth = varint();
  const offset = varint();
  const depthCut = varint();
  if (depthCut > 1) throw new Error('depth-cut flag');

  const frontier: number[][] = [];
  const groupCount = varint();
  for (let g = 0; g < groupCount; g++) {
    const level = varint();
    const parentId = itemId + unzigzag(varint());
    const group = [level, parentId];
    const idCount = varint();
    let previous = parentId;
    for (let k = 0; k < idCount; k++) {
      previous += unzigzag(varint());
      group.push(previous);
    }
    frontier.push(group);
  }

  const storyId = varint();
  let story: CursorStory | undefined;
  if (storyId > 0) {
    const length = varint();
    if (length > bytes.length - at) throw new Error('author past the payload');
    const by = strictUtf8.decode(bytes.subarray(at, at + length));
    at += length;
    story = { id: storyId, ...(by.length > 0 && { by }) };
  }
  if (at !== bytes.length) throw new Error('trailing bytes');

  return {
    offset,
    itemId,
    depth,
    frontier,
    ...(depthCut === 1 && { depthCut: true }),
    ...(story && { story }),
  };
}

/**
 * Decode a cursor in either format; `undefined` for anything that is not a
 * state hn_get_thread can resume — a cursor longer than
 * {@link MAX_CURSOR_LENGTH}, a payload in neither format, a truncated or
 * overlong one, or a state that fails validation (a depth past `maxDepth`, a
 * frontier level at or past its depth). Linear in the cursor's length.
 *
 * Both formats are read as earlier releases read the JSON one, so every string
 * they accepted still decodes to the same state: either base64 alphabet,
 * padding or none, characters outside the alphabet (whitespace among them)
 * skipped, and nothing read past the first `=`. A JSON payload is decoded as
 * UTF-8 with invalid bytes replaced, then parsed, so whitespace around its
 * tokens and keys it does not use are ignored.
 */
export function decodeThreadCursor(cursor: string, maxDepth: number): ThreadCursor | undefined {
  if (cursor.length > MAX_CURSOR_LENGTH) return;
  const bytes = Buffer.from(cursor.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const packed = bytes[0] === PACKED_FORMAT;

  let decoded: unknown;
  try {
    decoded = packed ? unpack(bytes) : JSON.parse(bytes.toString('utf8'));
  } catch {
    return;
  }

  const parsed = (packed ? CursorStateSchema : JsonCursorSchema).safeParse(decoded);
  if (!parsed.success) return;
  const { offset, itemId, depth, frontier, depthCut, story }: CursorState = parsed.data;
  if (depth > maxDepth || frontier.some(([level = depth]) => level >= depth)) return;

  return {
    offset,
    itemId,
    depth,
    depthCut: depthCut === true,
    frontier: frontier.flatMap(([level = 0, parentId = 0, ...ids]) =>
      ids.map((id) => ({ id, level, parentId })),
    ),
    ...(story && { story }),
  };
}
