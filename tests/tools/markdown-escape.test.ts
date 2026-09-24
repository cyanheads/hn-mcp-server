/**
 * @fileoverview Tests for the Markdown boundary helpers `format()` applies to upstream text.
 * @module tests/tools/markdown-escape.test
 */

import { describe, expect, it } from 'vitest';
import {
  escapeHighlight,
  escapeInline,
  escapeQuoted,
  quoteBody,
} from '@/mcp-server/tools/markdown-escape.js';
import { stripHtml } from '@/services/hn/hn-service.js';

describe('escapeInline', () => {
  it.each([
    ['a backslash', 'a \\', 'a \\\\'],
    ['an asterisk', 'a** b', 'a\\*\\* b'],
    ['a backtick', 'run `ls`', 'run \\`ls\\`'],
    ['the ] of ](', '[x](https://y.test)', '[x\\](https://y.test)'],
    ['an image', '![x](y)', '![x\\](y)'],
    ['< before a letter', 'The <Dialog> Element', 'The \\<Dialog> Element'],
    ['< before /', 'a </em> b', 'a \\</em> b'],
    ['< before !', '<!-- c -->', '\\<!-- c -->'],
    ['< before ?', '<?php', '\\<?php'],
  ])('escapes %s', (_label, input, expected) => {
    expect(escapeInline(input)).toBe(expected);
  });

  it.each([
    'a < b',
    '[pdf]',
    'snake_case',
    'x] (y)',
    'a<1',
    'AT&T',
    'Say "hi"',
    '# not a heading',
    'a | b',
    '',
  ])('leaves %j unchanged', (input) => {
    expect(escapeInline(input)).toBe(input);
  });

  it('keeps a title from closing the **…** wrapper it sits in', () => {
    expect(`**${escapeInline('a** — id:9 | 9999 pts')}**`).toBe('**a\\*\\* — id:9 | 9999 pts**');
  });

  it('maps each line break to one space, so a single-line field cannot start a line', () => {
    expect(escapeInline('a\n\n# b\rc\r\nd')).toBe('a  # b c d');
    expect(escapeQuoted('x"\n### y')).toBe('x\\" ### y');
    expect(escapeHighlight('<em>a</em>\n- b')).toBe('<em>a</em> - b');
  });
});

describe('escapeQuoted', () => {
  it('also escapes " so the field cannot end the quote around it', () => {
    expect(escapeQuoted('x" (story id:999)')).toBe('x\\" (story id:999)');
    expect(escapeQuoted('Say "hi" to *all*')).toBe('Say \\"hi\\" to \\*all\\*');
  });
});

describe('escapeHighlight', () => {
  it('escapes the text between markers and leaves the markers as markup', () => {
    expect(escapeHighlight('<dialog>: The <em>Dialog</em> <em>Element</em>')).toBe(
      '\\<dialog>: The <em>Dialog</em> <em>Element</em>',
    );
  });

  it('keeps the #1 footer title unchanged', () => {
    expect(escapeHighlight('<em>Rust</em> is great')).toBe('<em>Rust</em> is great');
  });

  it('escapes inside a marked span', () => {
    expect(escapeHighlight('<em>a*b</em>')).toBe('<em>a\\*b</em>');
  });

  it('escapes | inside and outside marked spans, where only escapeHighlight does', () => {
    expect(escapeHighlight('<em>a|b</em> | terms: x')).toBe('<em>a\\|b</em> \\| terms: x');
    expect(escapeInline('a | terms: x')).toBe('a | terms: x');
    expect(escapeQuoted('a | terms: x')).toBe('a | terms: x');
  });
});

describe('quoteBody', () => {
  it('prefixes every line and keeps a blank line as a bare >', () => {
    expect(quoteBody('a\n\n# h\n> q')).toBe('> a\n>\n> # h\n> > q');
  });

  it('places the prefix after the indent', () => {
    expect(quoteBody('a\nb', '    ')).toBe('    > a\n    > b');
  });

  it('treats CR and CRLF as line breaks, as CommonMark does', () => {
    expect(quoteBody('a\rb\r\nc')).toBe('> a\n> b\n> c');
  });

  it('leaves the body itself unescaped, so code stays verbatim', () => {
    expect(quoteBody('    return y*(1.5-(0.5*r*y*y));\n    Vec<T> \\n')).toBe(
      '>     return y*(1.5-(0.5*r*y*y));\n>     Vec<T> \\n',
    );
  });

  it('escapes the [ of a line shaped like a link reference definition', () => {
    expect(quoteBody('[1]: https://evil.test\n   [pdf]: x\n[deleted]: y', '  ')).toBe(
      '  > \\[1]: https://evil.test\n  >    \\[pdf]: x\n  > \\[deleted]: y',
    );
  });

  it('escapes a definition nested in a quote or a list item inside the body', () => {
    expect(quoteBody('> [1]: x\n>> [2]: y\n>    [3]: z\n- [4]: w\n1. [5]: v')).toBe(
      '> > \\[1]: x\n> >> \\[2]: y\n> >    \\[3]: z\n> - \\[4]: w\n> 1. \\[5]: v',
    );
  });

  it('escapes a definition at any indent, since list continuation can make an indented line live', () => {
    expect(quoteBody('    [1]: code\n>     [1]: quoted code')).toBe(
      '>     \\[1]: code\n> >     \\[1]: quoted code',
    );
  });

  it('leaves lines that are not definitions unchanged', () => {
    expect(
      quoteBody('[1] see\n[a](b): c\nx [1]: y\n[1] https://github.com/caolan/async\n  [2] x ]: y'),
    ).toBe(
      '> [1] see\n> [a](b): c\n> x [1]: y\n> [1] https://github.com/caolan/async\n>   [2] x ]: y',
    );
  });

  it('escapes a definition continuing a list item after a four-space line', () => {
    expect(quoteBody(stripHtml('- a<p><pre><code>    [X]: https://evil.test</code></pre>'))).toBe(
      '> - a\n>\n>     \\[X]: https://evil.test',
    );
  });

  it('escapes a definition continuing an ordered item after a five-space line', () => {
    expect(quoteBody('1. a\n\n     [X]: https://evil.test')).toBe(
      '> 1. a\n>\n>      \\[X]: https://evil.test',
    );
  });

  it('escapes a definition continuing a nested list item after a six-space line', () => {
    expect(quoteBody('- a\n  - b\n\n      [X]: https://evil.test')).toBe(
      '> - a\n>   - b\n>\n>       \\[X]: https://evil.test',
    );
  });

  it('escapes a definition after tabs: in a list item, in a quote, and leading the line', () => {
    expect(quoteBody('-\t[X]: https://evil.test')).toBe('> -\t\\[X]: https://evil.test');
    expect(quoteBody(stripHtml('&gt;\t[X]: https://evil.test'))).toBe(
      '> >\t\\[X]: https://evil.test',
    );
    expect(quoteBody(stripHtml('intro<p>\t[X]: https://evil.test'))).toBe(
      '> intro\n>\n> \t\\[X]: https://evil.test',
    );
  });

  it('escapes a line-leading [ whose label closes on a later line', () => {
    expect(quoteBody('[X\n]: https://evil.test')).toBe('> \\[X\n> ]: https://evil.test');
    expect(quoteBody('- [X\n]: https://evil.test')).toBe('> - \\[X\n> ]: https://evil.test');
  });
});

describe('markdown-escape — worst-case timing', () => {
  /** Best of three wall-clock readings, in ms. */
  function best(fn: () => void): number {
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      fn();
      min = Math.min(min, performance.now() - start);
    }
    return min;
  }

  const repeat = (unit: string) => (n: number) =>
    unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

  it.each([
    ['a run of "\\"', repeat('\\')],
    ['a run of "*"', repeat('*')],
    ['a run of "<"', repeat('<')],
    ['repeated "](" ', repeat(']](')],
    ['repeated "<em>" with no closer', repeat('<em>')],
    ['a run of line breaks', repeat('\r\n\n\r')],
    ['a run of "&#"', repeat('&#')],
    ['a run of "> " with no "["', repeat('> ')],
    ['a run of "[" with no "]"', repeat('[')],
    ['nested list and quote markers', repeat('>- 1. ')],
    ['nested markers separated by tabs', repeat('-\t>\t1)\t')],
    ['a run of tabs and spaces', repeat(' \t')],
    ['a leading "[" then a long line with no "]"', (n: number) => `[${'x'.repeat(n - 1)}`],
  ])('stays linear on %s', (_label, make) => {
    const run = (input: string) => {
      escapeInline(input);
      escapeQuoted(input);
      escapeHighlight(input);
      quoteBody(input, '  ');
    };
    const inputs = [5_000, 20_000, 80_000].map(make);
    for (const input of inputs) run(input);
    const [t5k, , t80k] = inputs.map((input) => best(() => run(input))) as [number, number, number];
    expect(t80k / Math.max(t5k, 0.05)).toBeLessThan(64);
    expect(t80k).toBeLessThan(250);
  });
});
