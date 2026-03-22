/**
 * @fileoverview Tests for server configuration parsing and caching.
 * @module config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getServerConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.HN_CONCURRENCY_LIMIT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadConfig() {
    const { getServerConfig } = await import('@/config/server-config.js');
    return getServerConfig;
  }

  it('returns default concurrencyLimit of 10 when env var is unset', async () => {
    const getServerConfig = await loadConfig();
    const config = getServerConfig();
    expect(config.concurrencyLimit).toBe(10);
  });

  it('parses HN_CONCURRENCY_LIMIT from env var', async () => {
    process.env.HN_CONCURRENCY_LIMIT = '25';
    const getServerConfig = await loadConfig();
    const config = getServerConfig();
    expect(config.concurrencyLimit).toBe(25);
  });

  it('caches config on repeated calls', async () => {
    const getServerConfig = await loadConfig();
    const first = getServerConfig();
    const second = getServerConfig();
    expect(first).toBe(second);
  });

  it('rejects concurrencyLimit below 1', async () => {
    process.env.HN_CONCURRENCY_LIMIT = '0';
    const getServerConfig = await loadConfig();
    expect(() => getServerConfig()).toThrow();
  });

  it('rejects concurrencyLimit above 50', async () => {
    process.env.HN_CONCURRENCY_LIMIT = '51';
    const getServerConfig = await loadConfig();
    expect(() => getServerConfig()).toThrow();
  });

  it('rejects non-numeric strings', async () => {
    process.env.HN_CONCURRENCY_LIMIT = 'not-a-number';
    const getServerConfig = await loadConfig();
    expect(() => getServerConfig()).toThrow();
  });
});
