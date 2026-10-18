/**
 * @fileoverview Notice wording for a numeric input served at its per-call cap.
 * A paged read accepts values up to a hard ceiling, serves anything above its
 * per-call cap at the cap, and says so in its `notice` beside the paging lever
 * that reaches the rest.
 * @module mcp-server/tools/served-at-cap
 */

/**
 * The notice sentence for a call whose `param` exceeded the per-call cap and
 * was served at the cap instead of rejected. The tool follows it with the
 * concrete next value (offset, page, cursor) that fetches the rest.
 */
export function servedAtCap(param: string, requested: number, cap: number): string {
  return `${param} ${requested} is above the per-call cap of ${cap}, so this call served ${param}: ${cap}.`;
}
