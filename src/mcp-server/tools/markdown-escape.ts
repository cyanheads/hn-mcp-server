/**
 * @fileoverview Markdown boundaries for upstream text that `format()` interpolates
 * into `content[]`. A single-line field (title, highlight title, poll-option text)
 * is escaped just enough that it cannot end the server's own markup around it. A
 * body is quoted line by line and otherwise left verbatim, so code stays intact.
 * Usernames, URLs, IDs, and server tokens are interpolated as they are.
 * @module mcp-server/tools/markdown-escape
 */

/** `\`, `*`, backtick, the `]` of `](`, and `<` before a letter, `/`, `!`, or `?`. */
const INLINE_SPECIAL = /[\\*`]|\](?=\()|<(?=[A-Za-z/!?])/g;

/** {@link INLINE_SPECIAL} plus `"`, for a field that sits inside `"…"`. */
const QUOTED_INLINE_SPECIAL = /[\\*`"]|\](?=\()|<(?=[A-Za-z/!?])/g;

/** {@link INLINE_SPECIAL} plus `|`, for the title segment of the `match — … | …` footer. */
const FOOTER_INLINE_SPECIAL = /[\\*`|]|\](?=\()|<(?=[A-Za-z/!?])/g;

/** A highlight marker, captured so `split` keeps it. */
const HIGHLIGHT_MARKER = /(<\/?em>)/;

/** Every line ending CommonMark recognizes. */
const LINE_BREAK = /\r\n|\r|\n/;
const LINE_BREAKS = /\r\n|\r|\n/g;

/**
 * The line-leading `[` that could open a link reference definition: after any
 * spaces, tabs, and quote or list markers, a `[` whose label closes into `]:`
 * on the same line, or one with no `]` after it at all, whose label may close
 * on a later line. CommonMark applies a definition to the whole document, even
 * from inside a block quote, so one left live in a body would turn `[1]` or
 * `[deleted]` in server text into a link. Indentation is no exemption: a line
 * indented four or more spaces is code at the top level but continuation text
 * after a list item, so an indented code line shaped `[x]: y` takes the escape
 * too.
 */
const REFERENCE_DEFINITION = /^([ \t]*(?:(?:>|[-+*]|\d{1,9}[.)])[ \t]*)*)\[(?=[^\]]+\]:|[^\]]*$)/;

/**
 * Escape a single-line upstream field so it cannot close or open the server's
 * markup around it — a `**…**` wrapper, a code span, a link, an HTML tag, or a
 * new line (each line break becomes a space) — and so it reads as typed in raw
 * text. This is not a full Markdown escape: `_under_` can still render as
 * emphasis, and a typed `&copy;` as ©. `a < b`, `[pdf]`, and `snake_case` are
 * left unchanged.
 */
export function escapeInline(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(INLINE_SPECIAL, '\\$&');
}

/** {@link escapeInline} for a field quoted in `"…"`, where a `"` would end the quote. */
export function escapeQuoted(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(QUOTED_INLINE_SPECIAL, '\\$&');
}

/**
 * Escape an Algolia title highlight for the search footer, leaving its `<em>`
 * and `</em>` markers as markup. `|` is escaped too, since the footer separates
 * its segments with ` | ` and a title reading `x | terms: y` would otherwise
 * imitate one. A literal `<em>` typed into the title is indistinguishable from
 * a marker and passes through the same way.
 */
export function escapeHighlight(text: string): string {
  return text
    .replace(LINE_BREAKS, ' ')
    .split(HIGHLIGHT_MARKER)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(FOOTER_INLINE_SPECIAL, '\\$&')))
    .join('');
}

/**
 * Quote an upstream body: every line gets `> ` after `indent`, and an empty line
 * a bare `>`, so no line of the body can start a server-authored line. The only
 * escape inside the body is the `[` of a link reference definition, which would
 * otherwise reach past the quote; everything else, code included, stays
 * verbatim. A quote absorbs the next non-blank line through lazy continuation,
 * so the caller follows the body with a blank line whenever server text comes
 * after it.
 */
export function quoteBody(text: string, indent = ''): string {
  return text
    .split(LINE_BREAK)
    .map((line) =>
      line ? `${indent}> ${line.replace(REFERENCE_DEFINITION, '$1\\[')}` : `${indent}>`,
    )
    .join('\n');
}
