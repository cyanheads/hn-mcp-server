/**
 * @fileoverview Server-specific configuration parsed from environment variables.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

const ServerConfigSchema = z.object({
  concurrencyLimit: z.coerce
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe('Max concurrent HTTP requests for batch item fetches.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig() {
  _config ??= ServerConfigSchema.parse({
    concurrencyLimit: process.env.HN_CONCURRENCY_LIMIT,
  });
  return _config;
}
