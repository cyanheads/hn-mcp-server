/**
 * @fileoverview Input schema for an HN account name. `hn_get_user`'s `username`
 * and `hn_search_content`'s `author` both read a name the same way: trimmed,
 * one leading `@` dropped, then refused when it is blank or still holds
 * whitespace, which no HN username does.
 * @module mcp-server/tools/username-input
 */

import { z } from '@cyanheads/mcp-ts-core';

/** The rejection for a name that holds whitespace after the trim and the `@` strip — a display name, not an account name. */
export const USERNAME_WHITESPACE_MESSAGE =
  'contains whitespace — HN usernames have none; pass the account name from a by or author field, not a display name.';

/**
 * An HN account name as a caller writes it. The parsed value is the name to
 * look up: `@pg` and ` pg ` both read as `pg`. Only the first `@` is dropped,
 * since `@@pg` has no single reading.
 *
 * `blankRecovery` completes the blank message with what the field's caller
 * should do instead. The strip and the whitespace check run in the handler's
 * parse and are absent from the advertised JSON Schema, which stays
 * `{ type: 'string', minLength: 1 }`: a client validating against a pattern
 * would see the raw value and refuse the padded and `@` forms accepted here.
 */
export function usernameInput(blankRecovery: string) {
  return z
    .string()
    .trim()
    .overwrite((name) => name.replace(/^@/, ''))
    .min(1, `blank after trimming whitespace and a leading @ — ${blankRecovery}`)
    .refine((name) => !/\s/.test(name), USERNAME_WHITESPACE_MESSAGE);
}
