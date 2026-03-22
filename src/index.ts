#!/usr/bin/env node
/**
 * @fileoverview hn-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getStories } from '@/mcp-server/tools/definitions/get-stories.tool.js';
import { getThread } from '@/mcp-server/tools/definitions/get-thread.tool.js';
import { getUser } from '@/mcp-server/tools/definitions/get-user.tool.js';
import { searchHn } from '@/mcp-server/tools/definitions/search-hn.tool.js';
import { initHnService } from '@/services/hn/hn-service.js';

await createApp({
  tools: [getStories, getThread, getUser, searchHn],
  setup() {
    initHnService();
  },
});
