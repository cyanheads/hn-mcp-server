/**
 * @fileoverview Upstream text at the `format()` boundary. Every tool runs the
 * real `HnService`, `stripHtml`, and `format()` against stubbed HN and Algolia
 * APIs, so the stripping, link-collapse, escaping, and quoting paths all execute.
 * @module tests/tools/upstream-text-rendering.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { getStories } from '@/mcp-server/tools/definitions/get-stories.tool.js';
import { getThread } from '@/mcp-server/tools/definitions/get-thread.tool.js';
import { getUser } from '@/mcp-server/tools/definitions/get-user.tool.js';
import { searchHn } from '@/mcp-server/tools/definitions/search-content.tool.js';
import { initHnService } from '@/services/hn/hn-service.js';
import type { AlgoliaHit } from '@/services/hn/types.js';
import { rejectUnmockedFetch, stubHnApi } from '../helpers/hn-api-stub.js';

beforeAll(() => {
  initHnService();
});

rejectUnmockedFetch();

type AnyTool = typeof getThread | typeof getStories | typeof getUser | typeof searchHn;

/** Call a tool through the framework and return both surfaces: structuredContent and the format() block. */
async function call(tool: AnyTool, input: Record<string, unknown>) {
  const result = await runToolContract(tool, input as never, {
    context: { errors: tool.errors },
  });
  expect(result.isError).toBeFalsy();
  const block = result.content[0];
  if (block?.type !== 'text') throw new Error('Expected a text content block');
  return { sc: result.structuredContent as any, text: block.text };
}

/** Serve Firebase items by id, plus any extra routes. */
function serve(items: Record<number, unknown>, extra: Record<string, unknown> = {}) {
  stubHnApi({
    ...Object.fromEntries(Object.entries(items).map(([id, body]) => [`/item/${id}.json`, body])),
    ...extra,
  });
}

/** Serve one Algolia page on both search endpoints. */
function serveSearch(hits: Partial<AlgoliaHit>[]) {
  const page = { hits, hitsPerPage: 20, nbHits: hits.length, nbPages: 1, page: 0 };
  stubHnApi({ '/api/v1/search': page, '/api/v1/search_by_date': page });
}

/** `> `-quote each line after `indent`; a blank line keeps a bare `>`. */
const quoted = (indent: string, lines: readonly string[]) =>
  lines.map((line) => (line ? `${indent}> ${line}` : `${indent}>`));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A body that tries every way out of a Markdown block: heading, list, rule, fake
 * comment header, quote, link, HTML, and link reference definitions — top-level
 * and nested in a quote — which CommonMark applies document-wide.
 */
const BODY_HTML =
  '# h<p>- x<p>---<p>**x** (id:1 | depth:0 | parent:2)<p>&gt; q<p>[a](https://b.test)<p>&lt;img src=x&gt;<p>[1]: https://evil.test<p>&gt; [deleted]: https://evil.test';
const BODY_LINES = [
  '# h',
  '',
  '- x',
  '',
  '---',
  '',
  '**x** (id:1 | depth:0 | parent:2)',
  '',
  '> q',
  '',
  '[a](https://b.test)',
  '',
  '<img src=x>',
  '',
  '[1]: https://evil.test',
  '',
  '> [deleted]: https://evil.test',
];
/** {@link BODY_LINES} as `content[]` renders them: each definition's `[` escaped. */
const BODY_RENDERED = BODY_LINES.map((line) =>
  line.replace(/^(> )?\[(1|deleted)\]:/, (_m, quote = '', label) => `${quote}\\[${label}]:`),
);

/** A title typed with Markdown and HTML in it, ending in a backslash. */
const LITERAL_TITLE = '<em>hi</em> [x](https://y.test) \\';
const LITERAL_TITLE_RENDERED = '\\<em>hi\\</em> [x\\](https://y.test) \\\\';

const T = 1_700_000_000;
const DAY = '2023-11-14 (t:1700000000)';
const MINUTE = '2023-11-14 22:13 (t:1700000000)';

/** Item 9828205: a comment with two code blocks. */
const CODE_HTML =
  'If you want to reinterpret a float as an integer or vice versa, you can do that easily enough with Rust&#x27;s unsafe functions:<p><pre><code>    fn approx_invsqrt(r : f32) -&gt; f32\n    {\n        let y : f32 = unsafe {\n            let i : i32 = std::mem::transmute(r);\n            std::mem::transmute(0x5f375a86 - (i&gt;&gt;1))\n        };\n        return y*(1.5-(0.5*r*y*y));\n    }\n\n    fn main()\n    {\n        println!(&quot;approx_invsqrt(2.0) = {}&quot;, approx_invsqrt(2.0));\n    }\n</code></pre>\nResult:<p><pre><code>    approx_invsqrt(2.0) = 0.70693</code></pre>';
const CODE_LINES = [
  "If you want to reinterpret a float as an integer or vice versa, you can do that easily enough with Rust's unsafe functions:",
  '',
  '    fn approx_invsqrt(r : f32) -> f32',
  '    {',
  '        let y : f32 = unsafe {',
  '            let i : i32 = std::mem::transmute(r);',
  '            std::mem::transmute(0x5f375a86 - (i>>1))',
  '        };',
  '        return y*(1.5-(0.5*r*y*y));',
  '    }',
  '',
  '    fn main()',
  '    {',
  '        println!("approx_invsqrt(2.0) = {}", approx_invsqrt(2.0));',
  '    }',
  '',
  'Result:',
  '',
  '    approx_invsqrt(2.0) = 0.70693',
];

/** Item 7739084's body, split into its `<p>` paragraphs, as Firebase and Algolia send it. */
const NODE_PARAGRAPHS = [
  'It&#x27;s a little tiring to see some of the same old fallacies about Node repeated ad infinitum in this thread. I suspect a lot of the complaints stem from poor development practices or not understanding norms in JS.',
  'JS isn&#x27;t without its flaws, but can we at least put a few fallacies to rest:',
  '&gt; callback hell',
  'There&#x27;s no reason to be in callback hell if you use an asynchronous control flow library and stick to the standard style of function signatures. I love @caolan&#x27;s async [1]. In particular, there&#x27;s a control flow pattern called `auto` that really (IMO) demonstrates some of the power of async programming: it&#x27;s a full dependency graph resolver [2].',
  '&gt; single-threaded',
  'There&#x27;s the cluster module, but nevermind that -- you can always just use the child_process library [3] to access spawn() and fork(). Remember those? Processes are a more nautral match for distributed computing than threads anyway.',
  '&gt; lack of strict typing',
  'Strict typing won&#x27;t make you a better developer, and you can enforce some degree of type correctness with Closure compiler annotations.',
];
const NODE_LINKS_RAW =
  '[1] <a href="https://github.com/caolan/async" rel="nofollow">https:&#x2F;&#x2F;github.com&#x2F;caolan&#x2F;async</a>\n[2] <a href="https://github.com/caolan/async#auto" rel="nofollow">https:&#x2F;&#x2F;github.com&#x2F;caolan&#x2F;async#auto</a>\n[3] <a href="http://nodejs.org/api/child_process.html" rel="nofollow">http:&#x2F;&#x2F;nodejs.org&#x2F;api&#x2F;child_process.html</a>';
/** Algolia's `caolan async` highlight of the same body: `'` decoded, `>` still encoded, markers in link text only. */
const NODE_HIGHLIGHT = [
  ...NODE_PARAGRAPHS.map((p) =>
    p
      .replaceAll('&#x27;', "'")
      .replace('an asynchronous', 'an <em>async</em>hronous')
      .replace("@caolan's async [1]", "@<em>caolan</em>'s <em>async</em> [1]")
      .replace('power of async programming', 'power of <em>async</em> programming'),
  ),
  '[1] <a href="https://github.com/caolan/async" rel="nofollow">https://github.com/<em>caolan</em>/<em>async</em></a>\n[2] <a href="https://github.com/caolan/async#auto" rel="nofollow">https://github.com/<em>caolan</em>/<em>async</em>#auto</a>\n[3] <a href="http://nodejs.org/api/child_process.html" rel="nofollow">http://nodejs.org/api/child_process.html</a>',
].join('<p>');

const NODE_TEXT_LINES = [
  "It's a little tiring to see some of the same old fallacies about Node repeated ad infinitum in this thread. I suspect a lot of the complaints stem from poor development practices or not understanding norms in JS.",
  '',
  "JS isn't without its flaws, but can we at least put a few fallacies to rest:",
  '',
  '> callback hell',
  '',
  "There's no reason to be in callback hell if you use an asynchronous control flow library and stick to the standard style of function signatures. I love @caolan's async [1]. In particular, there's a control flow pattern called `auto` that really (IMO) demonstrates some of the power of async programming: it's a full dependency graph resolver [2].",
  '',
  '> single-threaded',
  '',
  "There's the cluster module, but nevermind that -- you can always just use the child_process library [3] to access spawn() and fork(). Remember those? Processes are a more nautral match for distributed computing than threads anyway.",
  '',
  '> lack of strict typing',
  '',
  "Strict typing won't make you a better developer, and you can enforce some degree of type correctness with Closure compiler annotations.",
  '',
  '[1] https://github.com/caolan/async',
  '[2] https://github.com/caolan/async#auto',
  '[3] http://nodejs.org/api/child_process.html',
];
const NODE_HIGHLIGHT_LINES = NODE_TEXT_LINES.map((line) =>
  line
    .replace('an asynchronous', 'an <em>async</em>hronous')
    .replace("@caolan's async [1]", "@<em>caolan</em>'s <em>async</em> [1]")
    .replace('power of async programming', 'power of <em>async</em> programming')
    .replace(
      /^(\[[12]\]) https:\/\/github\.com\/caolan\/async/,
      '$1 https://github.com/<em>caolan</em>/<em>async</em>',
    ),
);

const nodeHit = (highlight: string, matchedWords: string[]): Partial<AlgoliaHit> => ({
  objectID: '7739084',
  author: 'yid',
  created_at: '2014-05-13T16:44:20Z',
  created_at_i: 1399999460,
  comment_text: [...NODE_PARAGRAPHS, NODE_LINKS_RAW].join('<p>'),
  story_id: 7738594,
  story_title: 'Why Node.js is becoming the go-to technology in the Enterprise',
  _highlightResult: {
    author: { matchLevel: 'none', matchedWords: [], value: 'yid' },
    comment_text: { matchLevel: 'full', matchedWords, value: highlight },
  },
});

// ---------------------------------------------------------------------------
// hn_get_thread
// ---------------------------------------------------------------------------

describe('hn_get_thread — upstream text in content[]', () => {
  it('keeps a title that looks like HTML on both surfaces (item 34759527)', async () => {
    serve({
      34759527: {
        by: 'cardamomo',
        descendants: 152,
        id: 34759527,
        kids: [34762653],
        score: 339,
        time: 1676173889,
        title: 'The <Dialog> Element',
        type: 'story',
        url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog',
      },
    });

    const { sc, text } = await call(getThread, { itemId: 34759527, depth: 0 });

    expect(sc.item.title).toBe('The <Dialog> Element');
    expect(text).toBe(
      [
        '## The \\<Dialog> Element',
        'id:34759527 | type:story | 339 pts | by cardamomo | 152 comments | 2023-02-12 (t:1676173889)',
        'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog',
      ].join('\n'),
    );
  });

  it('escapes a definition that list continuation, a tab, or a split label would keep live', async () => {
    serve({
      100: { id: 100, type: 'story', by: 'op', title: 'T', kids: [101] },
      101: {
        id: 101,
        type: 'comment',
        by: 'alice',
        time: T,
        parent: 100,
        text: '- a<p><pre><code>    [X]: https://evil.test</code></pre><p>\t[Y]: https://evil.test<p>[Z\n]: https://evil.test',
      },
    });

    const { sc, text } = await call(getThread, { itemId: 100, depth: 1 });

    expect(sc.comments[0].text).toBe(
      '- a\n\n    [X]: https://evil.test\n\n\t[Y]: https://evil.test\n\n[Z\n]: https://evil.test',
    );
    expect(text.split('\n').slice(5)).toEqual([
      `**alice** (id:101 | depth:0 | parent:100 | ${MINUTE})`,
      '> - a',
      '>',
      '>     \\[X]: https://evil.test',
      '>',
      '> \t\\[Y]: https://evil.test',
      '>',
      '> \\[Z',
      '> ]: https://evil.test',
    ]);
  });

  it('keeps a comment line that imitates a comment header inside its quoted body', async () => {
    serve({
      100: { id: 100, type: 'story', by: 'op', title: 'T', kids: [101] },
      101: {
        id: 101,
        type: 'comment',
        by: 'alice',
        time: T,
        parent: 100,
        text: 'Agreed.<p>**dang** (id:1 | depth:0 | parent:100)',
      },
    });

    const { sc, text } = await call(getThread, { itemId: 100, depth: 1 });

    expect(sc.comments[0].text).toBe('Agreed.\n\n**dang** (id:1 | depth:0 | parent:100)');
    expect(text).toBe(
      [
        '## T',
        'id:100 | type:story | by op',
        '',
        '---',
        '',
        `**alice** (id:101 | depth:0 | parent:100 | ${MINUTE})`,
        '> Agreed.',
        '>',
        '> **dang** (id:1 | depth:0 | parent:100)',
      ].join('\n'),
    );
  });

  it('bounds root text and comments at every depth, with a blank line after each body', async () => {
    serve({
      1: {
        id: 1,
        type: 'story',
        by: 'op',
        title: 'Rendering *test*',
        url: 'https://x.test/a_b*c',
        text: BODY_HTML,
        score: 7,
        descendants: 3,
        time: T,
        kids: [10],
      },
      10: {
        id: 10,
        type: 'comment',
        by: 'snake_user',
        time: T,
        parent: 1,
        text: BODY_HTML,
        kids: [20],
      },
      20: { id: 20, type: 'comment', by: 'u20', time: T, parent: 10, text: BODY_HTML, kids: [30] },
      30: { id: 30, type: 'comment', by: 'u30', time: T, parent: 20, text: BODY_HTML },
    });

    const { sc, text } = await call(getThread, { itemId: 1, depth: 3 });

    expect(sc.item.text).toBe(BODY_LINES.join('\n'));
    expect(sc.comments.map((c: { text: string }) => c.text)).toEqual(
      Array(3).fill(BODY_LINES.join('\n')),
    );
    expect(text).toBe(
      [
        '## Rendering \\*test\\*',
        `id:1 | type:story | 7 pts | by op | 3 comments | ${DAY}`,
        'https://x.test/a_b*c',
        ...quoted('', BODY_RENDERED),
        '',
        '---',
        '',
        `**snake_user** (id:10 | depth:0 | parent:1 | 1 replies | ${MINUTE})`,
        ...quoted('', BODY_RENDERED),
        '',
        `  **u20** (id:20 | depth:1 | parent:10 | 1 replies | ${MINUTE})`,
        ...quoted('  ', BODY_RENDERED),
        '',
        `    **u30** (id:30 | depth:2 | parent:20 | ${MINUTE})`,
        ...quoted('    ', BODY_RENDERED),
      ].join('\n'),
    );
  });

  it('renders code lines verbatim inside the quote, with no escapes', async () => {
    serve({
      1: { id: 1, type: 'story', by: 'op', title: 'S', kids: [9828205] },
      9828205: {
        by: 'JoshTriplett',
        id: 9828205,
        parent: 1,
        text: CODE_HTML,
        time: 1435961542,
        type: 'comment',
      },
    });

    const { text } = await call(getThread, { itemId: 1, depth: 1 });

    expect(text.split('\n').slice(5)).toEqual([
      '**JoshTriplett** (id:9828205 | depth:0 | parent:1 | 2015-07-03 22:12 (t:1435961542))',
      ...quoted('', CODE_LINES),
    ]);
  });

  it('escapes a poll title and its option text, and separates the quoted body from the options', async () => {
    serve({
      5: {
        id: 5,
        type: 'poll',
        by: 'pg',
        title: 'Best *lang* \\',
        text: 'Vote.',
        parts: [6],
      },
      6: {
        id: 6,
        type: 'pollopt',
        by: 'pg',
        poll: 5,
        score: 3,
        text: 'a** &lt;script&gt; `x` [y](https://z.test)',
      },
    });

    const { sc, text } = await call(getThread, { itemId: 5, depth: 0 });

    expect(sc.item.title).toBe('Best *lang* \\');
    expect(sc.item.options).toEqual([
      { id: 6, text: 'a** <script> `x` [y](https://z.test)', score: 3 },
    ]);
    expect(text).toBe(
      [
        '## Best \\*lang\\* \\\\',
        'id:5 | type:poll | parts:6 | by pg',
        '> Vote.',
        '',
        '**Options:**',
        '- id:6 | 3 pts: a\\*\\* \\<script> \\`x\\` [y\\](https://z.test)',
      ].join('\n'),
    );
  });

  it('leaves | in a title heading unescaped', async () => {
    serve({ 1: { id: 1, type: 'story', by: 'op', title: 'a | b' } });

    const { text } = await call(getThread, { itemId: 1, depth: 0 });

    expect(text.split('\n')[0]).toBe('## a | b');
  });

  it('renders a literal title as typed, and server tokens verbatim', async () => {
    serve({ 1: { id: 1, type: 'job', by: 'snake_user', title: LITERAL_TITLE } });

    const { sc, text } = await call(getThread, { itemId: 1, depth: 0 });

    expect(sc.item.title).toBe(LITERAL_TITLE);
    expect(text.split('\n')[0]).toBe(`## ${LITERAL_TITLE_RENDERED}`);
    expect(text.split('\n')[1]).toBe('id:1 | type:job | by snake_user');
  });

  it('heads an untitled comment root with its author verbatim and quotes its text', async () => {
    serve({ 7: { id: 7, type: 'comment', by: 'snake_user', parent: 3, text: 'a_b *c*' } });

    const { text } = await call(getThread, { itemId: 7, depth: 0 });

    expect(text).toBe(
      [
        '## Comment by snake_user',
        'id:7 | type:comment | parent:3 | by snake_user',
        '> a_b *c*',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// hn_get_user
// ---------------------------------------------------------------------------

describe('hn_get_user — upstream text in content[]', () => {
  it('quotes about and submission text, and escapes a submission title inside its bold wrapper', async () => {
    serve(
      {
        8: {
          id: 8,
          type: 'comment',
          by: 'snake_user',
          parent: 7,
          text: BODY_HTML,
          time: 1600000000,
        },
        7: {
          id: 7,
          type: 'story',
          by: 'snake_user',
          title: 'The <Dialog> a** — id:9 | 9999 pts',
          url: 'https://x.test/a_b*c',
          score: 1,
          descendants: 0,
          time: 1600000000,
        },
      },
      {
        '/user/snake_user.json': {
          id: 'snake_user',
          karma: 5,
          created: 1600000000,
          about: BODY_HTML,
          submitted: [8, 7],
        },
      },
    );

    const { sc, text } = await call(getUser, { username: 'snake_user', includeSubmissions: true });

    expect(sc.user.about).toBe(BODY_LINES.join('\n'));
    expect(sc.submissions.map((s: { title?: string }) => s.title)).toEqual([
      undefined,
      'The <Dialog> a** — id:9 | 9999 pts',
    ]);
    expect(text).toBe(
      [
        '## snake_user',
        '**Karma:** 5 | **Joined:** Sep 2020 (t:1600000000) | **Total submissions:** 2',
        '',
        ...quoted('', BODY_RENDERED),
        '',
        '### Submissions',
        '- **[comment]** — id:8 | parent:7 | 2020-09-13 (t:1600000000)',
        ...quoted('  ', BODY_RENDERED),
        '',
        '- **The \\<Dialog> a\\*\\* — id:9 | 9999 pts** — id:7 | story | 1 pts | 0 comments | 2020-09-13 (t:1600000000)',
        '  https://x.test/a_b*c',
      ].join('\n'),
    );
  });

  it('renders a literal submission title as typed', async () => {
    serve(
      { 7: { id: 7, type: 'story', by: 'u', title: LITERAL_TITLE, time: 1600000000 } },
      { '/user/u.json': { id: 'u', karma: 1, created: 1600000000, submitted: [7] } },
    );

    const { text } = await call(getUser, { username: 'u', includeSubmissions: true });

    expect(text.split('\n').at(-1)).toBe(
      `- **${LITERAL_TITLE_RENDERED}** — id:7 | story | 2020-09-13 (t:1600000000)`,
    );
  });
});

// ---------------------------------------------------------------------------
// hn_get_stories
// ---------------------------------------------------------------------------

describe('hn_get_stories — upstream text in content[]', () => {
  it('keeps titles on both surfaces, escapes only what can break the line, and quotes text', async () => {
    serve(
      {
        11: {
          id: 11,
          type: 'story',
          by: 'cardamomo',
          title: 'The <Dialog> Element',
          url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog',
          score: 339,
          descendants: 152,
          time: 1676173889,
        },
        12: {
          id: 12,
          type: 'story',
          by: 'snake_user',
          title: 'a < b [pdf] snake_case',
          text: BODY_HTML,
          score: 5,
          descendants: 0,
          time: T,
        },
        13: { id: 13, type: 'job', title: LITERAL_TITLE, time: T },
      },
      { '/topstories.json': [11, 12, 13] },
    );

    const { sc, text } = await call(getStories, { feed: 'top', count: 3 });

    expect(sc.stories.map((s: { title: string }) => s.title)).toEqual([
      'The <Dialog> Element',
      'a < b [pdf] snake_case',
      LITERAL_TITLE,
    ]);
    expect(sc.stories[1].text).toBe(BODY_LINES.join('\n'));
    expect(text).toBe(
      [
        '## top stories',
        '',
        '[1] The \\<Dialog> Element (developer.mozilla.org)',
        'id:11 | story | 339 pts | by cardamomo | 152 comments | 2023-02-12 (t:1676173889)',
        'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog',
        '',
        '[2] a < b [pdf] snake_case',
        `id:12 | story | 5 pts | by snake_user | 0 comments | ${DAY}`,
        ...quoted('', BODY_RENDERED),
        '',
        `[3] ${LITERAL_TITLE_RENDERED}`,
        `id:13 | job | ${DAY}`,
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// hn_search_content
// ---------------------------------------------------------------------------

describe('hn_search_content — upstream text in content[]', () => {
  it('keeps a title and its highlight on both surfaces (hit 42343089)', async () => {
    serveSearch([
      {
        objectID: '42343089',
        author: 'htunnicliff',
        created_at: '2024-12-06T19:09:07Z',
        created_at_i: 1733512147,
        num_comments: 153,
        points: 329,
        story_id: 42343089,
        title: '<dialog>: The Dialog Element',
        url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog',
        _highlightResult: {
          author: { matchLevel: 'none', matchedWords: [], value: 'htunnicliff' },
          title: {
            matchLevel: 'full',
            matchedWords: ['dialog', 'element'],
            value: '<dialog>: The <em>Dialog</em> <em>Element</em>',
          },
          url: {
            matchLevel: 'full',
            matchedWords: ['dialog', 'element'],
            value:
              'https://developer.mozilla.org/en-US/docs/Web/HTML/<em>Element</em>/<em>dialog</em>',
          },
        },
      },
    ]);

    const { sc, text } = await call(searchHn, { query: 'dialog element', tags: 'story', count: 3 });

    expect(sc.hits[0].title).toBe('<dialog>: The Dialog Element');
    expect(sc.hits[0].highlights.title).toBe('<dialog>: The <em>Dialog</em> <em>Element</em>');
    expect(text).toBe(
      [
        '## "dialog element" — search results',
        '',
        '### \\<dialog>: The Dialog Element (developer.mozilla.org)',
        'id:42343089 | htunnicliff | 329 pts | 153 comments | 2024-12-06T19:09:07Z',
        'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog',
        '',
        '> match — title: \\<dialog>: The <em>Dialog</em> <em>Element</em> | terms: dialog, element',
      ].join('\n'),
    );
  });

  it('keeps AT&T in a title highlight', async () => {
    serveSearch([
      {
        objectID: '43347662',
        author: 'leotravis10',
        created_at: '2025-03-13T00:00:00Z',
        title: 'Mark Klein, AT&T whistleblower who revealed NSA mass spying, has died',
        _highlightResult: {
          title: {
            matchLevel: 'full',
            matchedWords: ['klein', 'whistleblower'],
            value:
              'Mark <em>Klein</em>, AT&T <em>whistleblower</em> who revealed NSA mass spying, has died',
          },
        },
      },
    ]);

    const { sc } = await call(searchHn, { query: 'klein whistleblower' });

    expect(sc.hits[0].highlights.title).toBe(
      'Mark <em>Klein</em>, AT&T <em>whistleblower</em> who revealed NSA mass spying, has died',
    );
  });

  it('still renders a one-line match as the #1 footer', async () => {
    serveSearch([
      {
        objectID: '1',
        title: 'Rust is great',
        author: 'alice',
        points: 50,
        num_comments: 5,
        created_at: '2024-01-01T00:00:00Z',
        _highlightResult: {
          title: { matchLevel: 'full', matchedWords: ['rust'], value: '<em>Rust</em> is great' },
        },
      },
    ]);

    const { text } = await call(searchHn, { query: 'rust' });

    expect(text.split('\n').slice(2)).toEqual([
      '### Rust is great',
      'id:1 | alice | 50 pts | 5 comments | 2024-01-01T00:00:00Z',
      '',
      '> match — title: <em>Rust</em> is great | terms: rust',
    ]);
  });

  it('escapes | in the footer title so a title cannot imitate the terms segment, and nowhere else', async () => {
    serveSearch([
      {
        objectID: '1',
        title: 'Rust | terms: fake',
        author: 'alice',
        created_at: '2024-01-01T00:00:00Z',
        story_id: 1,
        _highlightResult: {
          title: {
            matchLevel: 'full',
            matchedWords: ['rust'],
            value: '<em>Rust</em> | terms: fake',
          },
        },
      },
    ]);

    const { sc, text } = await call(searchHn, { query: 'rust' });

    expect(sc.hits[0].highlights.title).toBe('<em>Rust</em> | terms: fake');
    expect(text.split('\n').slice(2)).toEqual([
      '### Rust | terms: fake',
      'id:1 | alice | 2024-01-01T00:00:00Z',
      '',
      '> match — title: <em>Rust</em> \\| terms: fake | terms: rust',
    ]);
  });

  it('quotes every line of a multi-line hit body and highlight body, with each link once (hit 7739084)', async () => {
    serveSearch([nodeHit(NODE_HIGHLIGHT, ['caolan', 'async'])]);

    const { sc, text } = await call(searchHn, {
      query: 'caolan async',
      tags: 'comment',
      storyId: 7738594,
    });

    expect(sc.hits[0].text).toBe(NODE_TEXT_LINES.join('\n'));
    expect(sc.hits[0].highlights.text).toBe(NODE_HIGHLIGHT_LINES.join('\n'));
    const [first, ...rest] = NODE_HIGHLIGHT_LINES;
    expect(text).toBe(
      [
        '## "caolan async" — search results',
        '',
        '### Comment on "Why Node.js is becoming the go-to technology in the Enterprise" (story id:7738594)',
        'id:7739084 | yid | 2014-05-13T16:44:20Z',
        ...quoted('', NODE_TEXT_LINES),
        '',
        `> match — terms: caolan, async | body: ${first}`,
        ...quoted('', rest),
      ].join('\n'),
    );
  });

  it('keeps the whole callback-hell highlight body inside the footer', async () => {
    const highlight = NODE_HIGHLIGHT.replace(/<\/?em>/g, '').replaceAll(
      'callback hell',
      '<em>callback</em> <em>hell</em>',
    );
    serveSearch([nodeHit(highlight, ['callback', 'hell'])]);

    const { text } = await call(searchHn, {
      query: 'callback hell',
      tags: 'comment',
      storyId: 7738594,
    });

    const lines = text.split('\n');
    const footer = lines.findIndex((line) => line.startsWith('> match — '));
    expect(lines[footer - 1]).toBe('');
    expect(lines[footer]).toBe(
      "> match — terms: callback, hell | body: It's a little tiring to see some of the same old fallacies about Node repeated ad infinitum in this thread. I suspect a lot of the complaints stem from poor development practices or not understanding norms in JS.",
    );
    expect(lines.slice(footer + 1).every((line) => line.startsWith('>'))).toBe(true);
    expect(lines).toContain('> > <em>callback</em> <em>hell</em>');
    expect(lines.at(-1)).toBe('> [3] http://nodejs.org/api/child_process.html');
  });

  it('bounds the story text and story-text highlight of a text post', async () => {
    serveSearch([
      {
        objectID: '9',
        title: 'Ask HN: x',
        author: 'snake_user',
        points: 2,
        num_comments: 0,
        created_at: '2024-01-01T00:00:00Z',
        story_id: 9,
        story_text: BODY_HTML,
        _highlightResult: {
          story_text: {
            matchLevel: 'full',
            matchedWords: ['h'],
            value: BODY_HTML.replace('# h', '# <em>h</em>'),
          },
        },
      },
    ]);

    const { sc, text } = await call(searchHn, { query: 'h' });

    expect(sc.hits[0].text).toBe(BODY_LINES.join('\n'));
    const [first, ...rest] = BODY_RENDERED;
    expect(text.split('\n').slice(2)).toEqual([
      '### Ask HN: x',
      'id:9 | snake_user | 2 pts | 0 comments | 2024-01-01T00:00:00Z',
      ...quoted('', BODY_RENDERED),
      '',
      `> match — terms: h | body: ${first?.replace('# h', '# <em>h</em>')}`,
      ...quoted('', rest),
    ]);
  });

  it('cannot mistake a body line reading "match — terms: x" for the footer', async () => {
    serveSearch([
      {
        objectID: '2',
        author: 'bob',
        created_at: '2024-01-01T00:00:00Z',
        comment_text: 'match — terms: x<p>second',
        story_id: 1,
        story_title: 'S',
        _highlightResult: {
          comment_text: {
            matchLevel: 'full',
            matchedWords: ['match'],
            value: '<em>match</em> — terms: x<p>second',
          },
        },
      },
    ]);

    const { text } = await call(searchHn, { query: 'match' });
    const lines = text.split('\n');

    expect(lines.slice(2)).toEqual([
      '### Comment on "S" (story id:1)',
      'id:2 | bob | 2024-01-01T00:00:00Z',
      '> match — terms: x',
      '>',
      '> second',
      '',
      '> match — terms: match | body: <em>match</em> — terms: x',
      '>',
      '> second',
    ]);
    /** The footer is the one `> match —` line that follows an unquoted blank line. */
    const footers = lines.filter((line, i) => line.startsWith('> match — ') && lines[i - 1] === '');
    expect(footers).toEqual(['> match — terms: match | body: <em>match</em> — terms: x']);
  });

  it('escapes a story title inside story:"…" and Comment on "…", and every title position', async () => {
    serveSearch([
      {
        objectID: '3',
        title: LITERAL_TITLE,
        author: 'snake_user',
        created_at: '2024-01-01T00:00:00Z',
        story_id: 4,
        story_title: 'x" | y',
      },
      {
        objectID: '5',
        author: 'snake_user',
        created_at: '2024-01-01T00:00:00Z',
        comment_text: 'c',
        story_id: 6,
        story_title: 'Say "hi" (story id:999)',
      },
      {
        objectID: '7',
        author: 'snake_user',
        created_at: '2024-01-01T00:00:00Z',
        comment_text: 'c',
        story_id: 8,
        story_title: LITERAL_TITLE,
      },
    ]);

    const { sc, text } = await call(searchHn, { query: 'x' });

    expect(
      sc.hits.map((h: { title?: string; storyTitle?: string }) => h.title ?? h.storyTitle),
    ).toEqual([LITERAL_TITLE, 'Say "hi" (story id:999)', LITERAL_TITLE]);
    expect(text.split('\n').slice(2)).toEqual([
      `### ${LITERAL_TITLE_RENDERED}`,
      'id:3 | snake_user | 2024-01-01T00:00:00Z | story:"x\\" | y"#4',
      '',
      '### Comment on "Say \\"hi\\" (story id:999)" (story id:6)',
      'id:5 | snake_user | 2024-01-01T00:00:00Z',
      '> c',
      '',
      `### Comment on "${LITERAL_TITLE_RENDERED}" (story id:8)`,
      'id:7 | snake_user | 2024-01-01T00:00:00Z',
      '> c',
    ]);
  });

  it('renders code lines in a hit body verbatim', async () => {
    serveSearch([
      {
        objectID: '9828205',
        author: 'JoshTriplett',
        created_at: '2015-07-03T22:12:22Z',
        comment_text: CODE_HTML,
        story_id: 9827051,
        story_title: 'Things Rust shipped without',
      },
    ]);

    const { text } = await call(searchHn, { query: 'fn main println', tags: 'comment' });

    expect(text.split('\n').slice(4)).toEqual(quoted('', CODE_LINES));
  });
});

// ---------------------------------------------------------------------------
// Titles are not HTML, though some arrive entity-encoded
// ---------------------------------------------------------------------------

describe('entity-encoded titles', () => {
  it('decodes a Firebase title on hn_get_thread (item 1031)', async () => {
    serve({
      1031: {
        id: 1031,
        type: 'story',
        by: 'x',
        title: '&#34;Remember Me&#34; Feature Would Be Nice',
      },
    });

    const { sc, text } = await call(getThread, { itemId: 1031, depth: 0 });

    expect(sc.item.title).toBe('"Remember Me" Feature Would Be Nice');
    expect(text.split('\n')[0]).toBe('## "Remember Me" Feature Would Be Nice');
  });

  it('decodes titles on hn_get_stories and hn_get_user, and keeps a raw title raw', async () => {
    serve(
      {
        3409539: {
          id: 3409539,
          type: 'story',
          by: 'u',
          title: 'Samsung steals girl from Apple&#8217;s ad for its own.',
          time: T,
        },
        26915706: {
          id: 26915706,
          type: 'story',
          by: 'u',
          title: 'Using <details> for menus and dialogs (2019)',
          time: T,
        },
      },
      {
        '/topstories.json': [3409539],
        '/user/u.json': { id: 'u', karma: 1, created: T, submitted: [3409539, 26915706] },
      },
    );

    const stories = await call(getStories, { feed: 'top', count: 1 });
    expect(stories.sc.stories[0].title).toBe('Samsung steals girl from Apple’s ad for its own.');
    expect(stories.text.split('\n')[2]).toBe(
      '[1] Samsung steals girl from Apple’s ad for its own.',
    );

    const user = await call(getUser, { username: 'u', includeSubmissions: true });
    expect(user.sc.submissions.map((s: { title: string }) => s.title)).toEqual([
      'Samsung steals girl from Apple’s ad for its own.',
      'Using <details> for menus and dialogs (2019)',
    ]);
    expect(user.text.split('\n').slice(-2)).toEqual([
      `- **Samsung steals girl from Apple’s ad for its own.** — id:3409539 | story | ${DAY}`,
      `- **Using \\<details> for menus and dialogs (2019)** — id:26915706 | story | ${DAY}`,
    ]);
  });

  it('decodes a search title, story title, and title highlight between its markers (hit 26915706)', async () => {
    serveSearch([
      {
        objectID: '26915706',
        title: 'Using &lt;details&gt; for menus and dialogs (2019)',
        author: 'u',
        created_at: '2021-04-24T00:00:00Z',
        story_id: 26915706,
        _highlightResult: {
          title: {
            matchLevel: 'full',
            matchedWords: ['details', 'menus'],
            value: 'Using &lt;<em>details</em>&gt; for <em>menus</em> and dialogs (2019)',
          },
        },
      },
      {
        objectID: '1032',
        author: 'u',
        created_at: '2007-02-20T00:00:00Z',
        comment_text: 'c',
        story_id: 1031,
        story_title: '&#34;Remember Me&#34; Feature Would Be Nice',
      },
    ]);

    const { sc, text } = await call(searchHn, { query: 'details menus' });

    expect(sc.hits[0].title).toBe('Using <details> for menus and dialogs (2019)');
    expect(sc.hits[0].highlights.title).toBe(
      'Using <<em>details</em>> for <em>menus</em> and dialogs (2019)',
    );
    expect(sc.hits[1].storyTitle).toBe('"Remember Me" Feature Would Be Nice');
    expect(text.split('\n').slice(2)).toEqual([
      '### Using \\<details> for menus and dialogs (2019)',
      'id:26915706 | u | 2021-04-24T00:00:00Z',
      '',
      '> match — title: Using <<em>details</em>> for <em>menus</em> and dialogs (2019) | terms: details, menus',
      '',
      '### Comment on "\\"Remember Me\\" Feature Would Be Nice" (story id:1031)',
      'id:1032 | u | 2007-02-20T00:00:00Z',
      '> c',
    ]);
  });

  it('keeps a title with no entities unchanged, including a literal <em> and a bare &', async () => {
    serve({ 1: { id: 1, type: 'story', by: 'u', title: '<em>x</em> AT&T <Dialog>' } });

    const { sc } = await call(getThread, { itemId: 1, depth: 0 });

    expect(sc.item.title).toBe('<em>x</em> AT&T <Dialog>');
  });
});
