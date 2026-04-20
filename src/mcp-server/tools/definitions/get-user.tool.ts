/**
 * @fileoverview Fetch an HN user profile with optional submission resolution.
 * @module mcp-server/tools/definitions/get-user.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  filterLiveItems,
  getHnService,
  normalizeUrl,
  stripHtml,
} from '@/services/hn/hn-service.js';

export const getUser = tool('hn_get_user', {
  description:
    'Get an HN user profile with karma, about, and optionally their most recent submissions resolved into full items.',
  annotations: { readOnlyHint: true },
  input: z.object({
    username: z.string().min(1).describe('HN username. Case-sensitive.'),
    includeSubmissions: z
      .boolean()
      .default(false)
      .describe(
        "Resolve the user's most recent submissions into full items. Without this, only the submission count is available.",
      ),
    submissionCount: z
      .number()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Number of recent submissions to resolve. Only used when includeSubmissions is true.',
      ),
  }),
  output: z.object({
    user: z
      .object({
        id: z.string().describe('Username.'),
        karma: z.number().describe('Karma score.'),
        created: z.number().describe('Account creation time (Unix timestamp).'),
        about: z.string().optional().describe('Self-description (HTML stripped).'),
        totalSubmissions: z.number().describe('Total number of submissions.'),
      })
      .describe('User profile.'),
    submissions: z
      .array(
        z.object({
          id: z.number().describe('Item ID — use with hn_get_thread to read comments.'),
          type: z.string().describe('Item type (story, comment, job, poll).'),
          title: z.string().optional().describe('Title (stories/jobs/polls).'),
          url: z.string().optional().describe('External link URL.'),
          text: z.string().optional().describe('Body text (HTML stripped).'),
          score: z.number().optional().describe('Score/upvotes.'),
          time: z.number().optional().describe('Unix timestamp.'),
          descendants: z.number().optional().describe('Comment count (stories/polls).'),
        }),
      )
      .optional()
      .describe(
        'Recent submissions, most recent first. Only present when includeSubmissions is true.',
      ),
  }),

  async handler(input, ctx) {
    const hn = getHnService();
    const user = await hn.fetchUser(input.username, ctx);
    if (!user) throw notFound(`User ${input.username} not found`, { username: input.username });

    const profile = {
      id: user.id,
      karma: user.karma,
      created: user.created,
      about: user.about ? stripHtml(user.about) : undefined,
      totalSubmissions: user.submitted?.length ?? 0,
    };

    const submissions =
      input.includeSubmissions && user.submitted?.length
        ? filterLiveItems(
            await hn.fetchItems(user.submitted.slice(0, input.submissionCount), ctx),
          ).map((item) => ({
            id: item.id,
            type: item.type,
            title: item.title ? stripHtml(item.title) : undefined,
            url: normalizeUrl(item.url),
            text: item.text ? stripHtml(item.text) : undefined,
            score: item.score,
            time: item.time,
            descendants: item.descendants,
          }))
        : undefined;

    ctx.log.info('Fetched user', { username: input.username, submissions: submissions?.length });

    return { user: profile, submissions };
  },

  format: (result) => {
    const { user } = result;
    const joined = new Date(user.created * 1000).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
    const lines: string[] = [
      `## ${user.id}`,
      `**Karma:** ${user.karma} | **Joined:** ${joined} | **Total submissions:** ${user.totalSubmissions}`,
    ];

    if (user.about) lines.push(`\n${user.about}`);

    if (result.submissions?.length) {
      lines.push('\n### Recent submissions');
      for (const s of result.submissions) {
        const title = s.title ?? `[${s.type}]`;
        const date = s.time ? new Date(s.time * 1000).toISOString().slice(0, 10) : '';
        const meta = [
          `id:${s.id}`,
          s.type,
          s.score != null ? `${s.score} pts` : null,
          s.descendants != null ? `${s.descendants} comments` : null,
          date,
        ]
          .filter(Boolean)
          .join(' | ');
        lines.push(`- **${title}** — ${meta}`);
        if (s.url) lines.push(`  ${s.url}`);
        if (s.text) lines.push(`  ${s.text}`);
      }
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
