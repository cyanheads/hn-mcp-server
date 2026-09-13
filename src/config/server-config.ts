/**
 * @fileoverview Server-specific configuration parsed from environment variables.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  concurrencyLimit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Max concurrent HTTP requests for batch item fetches.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    concurrencyLimit: 'HN_CONCURRENCY_LIMIT',
  });
  return _config;
}
