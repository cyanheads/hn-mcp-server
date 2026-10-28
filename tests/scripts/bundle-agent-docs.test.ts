/**
 * @fileoverview Tests the agent-doc selector shared by the bundle cleaner and the packaging
 * linter: package-root agent trees are stripped, runtime modules that share their names are kept.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEANER_ENTRY,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';

/**
 * `scripts/lint-packaging.ts` ends in a repo-only `import('../src/mcp-server/skills.js')`
 * fallback, so a static import would pull it into the `tsc` program and fail the typecheck
 * (cyanheads/mcp-ts-core#797). Loading it by URL at run time keeps it out of the program.
 */
const lintPackagingUrl = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
const { AGENT_DOC_ENTRY: LINTER_ENTRY } = (await import(lintPackagingUrl)) as {
  AGENT_DOC_ENTRY: RegExp;
};

const stripped = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/dotenv/skills/dotenvx/README.md',
  'node_modules/thread-stream/.claude/settings.local.json',
  'node_modules/some-pkg/.agents/skills/x/notes.md',
  'node_modules/@scope/pkg/skills/guide/references/a.md',
  'node_modules/outer/node_modules/inner/skills/a/b.md',
  'node_modules/@a/outer/node_modules/@b/inner/.claude/x.json',
  'node_modules/any/deep/dir/SKILL.md',
];

const kept = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.mts',
  'node_modules/outer/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@scope/skills/index.js',
  'node_modules/skills/index.js',
  'node_modules/@cyanheads/mcp-ts-core/dist/mcp-server/skills.js',
  'node_modules/pkg/lib/.claude/not-root.json',
  'skills/published-skill/SKILL.md',
  'dist/index.js',
];

describe.each([
  ['scripts/clean-mcpb.ts', CLEANER_ENTRY],
  ['scripts/lint-packaging.ts', LINTER_ENTRY],
])('AGENT_DOC_ENTRY in %s', (_file, selector) => {
  it.each(stripped)('selects %s', (entry) => {
    expect(selector.test(entry)).toBe(true);
  });

  it.each(kept)('keeps %s', (entry) => {
    expect(selector.test(entry)).toBe(false);
  });
});

describe('filterAgentDocEntries', () => {
  it('returns exactly the package-root agent docs from a mixed listing', () => {
    expect(filterAgentDocEntries([...kept, ...stripped])).toEqual(stripped);
  });
});

describe('cleaner and linter selectors', () => {
  it('are the same pattern', () => {
    expect(LINTER_ENTRY.source).toBe(CLEANER_ENTRY.source);
    expect(LINTER_ENTRY.flags).toBe(CLEANER_ENTRY.flags);
  });
});
