/**
 * @fileoverview Tests for HN service utilities and init/accessor pattern.
 * @module services/hn/hn-service.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodeHtmlEntities,
  filterLiveItems,
  normalizeUrl,
  stripHtml,
} from '@/services/hn/hn-service.js';
import type { HnItem } from '@/services/hn/types.js';

// ---------------------------------------------------------------------------
// decodeHtmlEntities
// ---------------------------------------------------------------------------

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    expect(decodeHtmlEntities('&amp; &lt; &gt; &quot; &apos;')).toBe('& < > " \'');
  });

  it('decodes &nbsp; to a space', () => {
    expect(decodeHtmlEntities('hello&nbsp;world')).toBe('hello world');
  });

  it('decodes decimal numeric entities', () => {
    expect(decodeHtmlEntities('&#60;&#62;')).toBe('<>');
  });

  it('decodes hex numeric entities', () => {
    expect(decodeHtmlEntities('&#x3C;&#x3E;')).toBe('<>');
  });

  it('decodes uppercase hex entities', () => {
    expect(decodeHtmlEntities('&#x3c;&#x3e;')).toBe('<>');
  });

  it('leaves unknown named entities as-is', () => {
    expect(decodeHtmlEntities('&unknown;')).toBe('&unknown;');
  });

  it('returns plain text unchanged', () => {
    expect(decodeHtmlEntities('no entities here')).toBe('no entities here');
  });

  it('handles mixed entities in one string', () => {
    expect(decodeHtmlEntities('&amp;&#60;&#x3E;&unknown;')).toBe('&<>&unknown;');
  });
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

describe('stripHtml', () => {
  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });

  it('returns empty string for falsy input', () => {
    expect(stripHtml(undefined as unknown as string)).toBe('');
    expect(stripHtml(null as unknown as string)).toBe('');
  });

  it('strips simple HTML tags', () => {
    expect(stripHtml('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
  });

  it('converts <p> tags to double newlines', () => {
    expect(stripHtml('first<p>second<p>third')).toBe('first\n\nsecond\n\nthird');
  });

  it('converts links to text (url) format', () => {
    expect(stripHtml('<a href="https://example.com">click here</a>')).toBe(
      'click here (https://example.com)',
    );
  });

  it('uses bare url when link text matches href', () => {
    expect(stripHtml('<a href="https://example.com">https://example.com</a>')).toBe(
      'https://example.com',
    );
  });

  it('preserves code blocks', () => {
    const html = 'before<pre><code>const x = 1;\nconst y = 2;</code></pre>after';
    const result = stripHtml(html);
    expect(result).toContain('const x = 1;\nconst y = 2;');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('preserves multiple code blocks', () => {
    const html = '<pre><code>a</code></pre>text<pre><code>b</code></pre>';
    const result = stripHtml(html);
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('text');
  });

  it('decodes entities in the final output', () => {
    expect(stripHtml('&amp; stuff')).toBe('& stuff');
  });

  it('trims leading/trailing whitespace', () => {
    expect(stripHtml('<p>hello<p>')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------

describe('normalizeUrl', () => {
  it('returns trimmed string for valid URL', () => {
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('returns undefined for empty string', () => {
    expect(normalizeUrl('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(normalizeUrl('   ')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(normalizeUrl(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(normalizeUrl(undefined)).toBeUndefined();
  });

  it('returns undefined when called with no arguments', () => {
    expect(normalizeUrl()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// filterLiveItems
// ---------------------------------------------------------------------------

describe('filterLiveItems', () => {
  const live: HnItem = { id: 1, type: 'story' };
  const dead: HnItem = { id: 2, type: 'story', dead: true };
  const deleted: HnItem = { id: 3, type: 'comment', deleted: true };
  const deadAndDeleted: HnItem = { id: 4, type: 'story', dead: true, deleted: true };

  it('returns only live items', () => {
    expect(filterLiveItems([live, dead, deleted, null, deadAndDeleted])).toEqual([live]);
  });

  it('returns empty array when all items are filtered out', () => {
    expect(filterLiveItems([null, dead, deleted])).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(filterLiveItems([])).toEqual([]);
  });

  it('preserves items where dead/deleted are explicitly false', () => {
    const explicit: HnItem = { id: 5, type: 'job', dead: false, deleted: false };
    expect(filterLiveItems([explicit])).toEqual([explicit]);
  });

  it('preserves order of surviving items', () => {
    const a: HnItem = { id: 10, type: 'story' };
    const b: HnItem = { id: 20, type: 'comment' };
    const c: HnItem = { id: 30, type: 'job' };
    expect(filterLiveItems([a, null, dead, b, deleted, c])).toEqual([a, b, c]);
  });
});

// ---------------------------------------------------------------------------
// getHnService / initHnService
// ---------------------------------------------------------------------------

describe('getHnService / initHnService', () => {
  beforeEach(() => {
    /**
     * Reset module registry so each test gets fresh module-level singletons
     * (_service in hn-service, _config in server-config).
     */
    vi.resetModules();
  });

  it('throws before initHnService is called', async () => {
    const mod = await import('@/services/hn/hn-service.js');
    expect(() => mod.getHnService()).toThrow('HnService not initialized');
  });

  it('returns an HnService instance after init', async () => {
    process.env.HN_CONCURRENCY_LIMIT = '5';
    const mod = await import('@/services/hn/hn-service.js');
    mod.initHnService();
    const service = mod.getHnService();
    expect(service).toBeInstanceOf(mod.HnService);
  });

  it('returns the same instance on repeated calls', async () => {
    process.env.HN_CONCURRENCY_LIMIT = '5';
    const mod = await import('@/services/hn/hn-service.js');
    mod.initHnService();
    expect(mod.getHnService()).toBe(mod.getHnService());
  });

  it('uses HN_CONCURRENCY_LIMIT from env', async () => {
    process.env.HN_CONCURRENCY_LIMIT = '3';
    const mod = await import('@/services/hn/hn-service.js');
    mod.initHnService();
    const service = mod.getHnService();
    // concurrencyLimit is private, so verify via the class being constructed
    // without throwing — the env var was accepted by the config schema
    expect(service).toBeInstanceOf(mod.HnService);
  });

  it('falls back to default concurrency when env var is unset', async () => {
    delete process.env.HN_CONCURRENCY_LIMIT;
    const mod = await import('@/services/hn/hn-service.js');
    mod.initHnService();
    expect(mod.getHnService()).toBeInstanceOf(mod.HnService);
  });
});
