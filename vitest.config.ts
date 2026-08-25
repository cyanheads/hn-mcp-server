/**
 * @fileoverview Vitest config for hn-mcp-server. Uses Vitest 4 projects so
 * suites can be split by execution profile as the test surface grows.
 *
 * @module vitest.config
 */

import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';
import { defineConfig, mergeConfig } from 'vitest/config';

const alias = { '@/': new URL('./src/', import.meta.url).pathname };

export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: { alias },
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
            exclude: ['tests/smoke/**', 'tests/integration/**', 'tests/fuzz/**'],
          },
        },
        {
          extends: true,
          test: { name: 'smoke', include: ['tests/smoke/**/*.test.ts'] },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['tests/integration/**/*.test.ts'],
            maxWorkers: 1,
            testTimeout: 30_000,
          },
        },
        {
          extends: true,
          test: {
            name: 'fuzz',
            include: ['tests/fuzz/**/*.test.ts'],
            testTimeout: 15_000,
          },
        },
      ],
    },
  }),
);
