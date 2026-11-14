/**
 * @fileoverview Tests for the HN account-name input schema `hn_get_user` and `hn_search_content` share.
 * @module tests/tools/username-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { USERNAME_WHITESPACE_MESSAGE, usernameInput } from '@/mcp-server/tools/username-input.js';
import { expectLinearCpu } from '../helpers/cpu-time.js';

const schema = usernameInput('pass an HN username.');

/** The messages a rejected `input` carries. */
function messagesFor(input: string): string[] {
  const parsed = schema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe('usernameInput', () => {
  it.each([
    ['a bare name', 'pg', 'pg'],
    ['a handle', '@pg', 'pg'],
    ['a handle inside whitespace', ' @pg ', 'pg'],
    ['a tab and a newline around the name', '\tpg\n', 'pg'],
    ['a no-break space around the name', '\u{00A0}pg\u{00A0}', 'pg'],
    ['dashes and underscores', 'a-b_c', 'a-b_c'],
    ['only the first of two leading @', '@@pg', '@pg'],
    ['a trailing @', 'pg@', 'pg@'],
  ])('reads %s', (_label, input, expected) => {
    expect(schema.parse(input)).toBe(expected);
  });

  it.each([
    ['a space', 'Paul Graham'],
    ['a tab', 'paul\tgraham'],
    ['a newline', 'paul\ngraham'],
    ['a no-break space', 'paul\u{00A0}graham'],
    ['a space after the @', '@ pg'],
  ])('rejects a name holding %s', (_label, input) => {
    expect(messagesFor(input)).toEqual([USERNAME_WHITESPACE_MESSAGE]);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace alone', ' \t\n'],
    ['an @ alone', '@'],
    ['an @ inside whitespace', ' @ '],
  ])('rejects %s as blank, naming both steps that emptied it', (_label, input) => {
    expect(messagesFor(input)).toEqual([
      'blank after trimming whitespace and a leading @ — pass an HN username.',
    ]);
  });

  it('completes the blank message with the recovery it is given', () => {
    const parsed = usernameInput('omit author to search all authors.').safeParse('@');
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      'blank after trimming whitespace and a leading @ — omit author to search all authors.',
    ]);
  });

  it('advertises a string with minLength 1 and no pattern', () => {
    const { type, minLength, pattern } = z.toJSONSchema(schema) as Record<string, unknown>;
    expect({ type, minLength, pattern }).toEqual({
      type: 'string',
      minLength: 1,
      pattern: undefined,
    });
  });

  it.each([
    ['a long run of spaces inside a name', (chars: number) => `a${' '.repeat(chars)}b`],
    ['a long run of @', (chars: number) => '@'.repeat(chars)],
    ['a long name with no whitespace', (chars: number) => 'a'.repeat(chars)],
    ['breaks throughout', (chars: number) => 'a \r\n'.repeat(Math.ceil(chars / 4))],
  ])(
    'stays linear on %s',
    (_label, make) => {
      expectLinearCpu({ make, run: (input) => void schema.safeParse(input) });
    },
    120_000,
  );
});
