#!/usr/bin/env node
/**
 * @fileoverview hn-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getStories } from '@/mcp-server/tools/definitions/get-stories.tool.js';
import { getThread } from '@/mcp-server/tools/definitions/get-thread.tool.js';
import { getUser } from '@/mcp-server/tools/definitions/get-user.tool.js';
import { searchHn } from '@/mcp-server/tools/definitions/search-content.tool.js';
import { initHnService } from '@/services/hn/hn-service.js';

await createApp({
  tools: [getStories, getThread, getUser, searchHn],
  instructions:
    'Use the hn_* tools to access Hacker News via the Firebase API and Algolia search: ranked feeds, full-text search with type/author/date/score filters, user profiles, and items with their comment trees. Items are addressed by integer ID, reused across tools and item types (story, comment, job, poll, pollopt); passing a comment id to hn_get_thread drills into that subtree. Usernames are case-sensitive; HN sparsely populates fields, so treat absent values as unknown.',
  setup() {
    initHnService();
  },
});
