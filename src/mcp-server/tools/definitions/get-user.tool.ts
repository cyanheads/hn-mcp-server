/**
 * @fileoverview Fetch an HN user profile with optional submission resolution.
 * @module mcp-server/tools/definitions/get-user.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  errors: [
    {
      reason: 'user_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'HN reports no user account exists for the given username.',
      recovery: 'Verify the username spelling — HN usernames are case-sensitive.',
      severity: 'notice',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The HN API answered with a 4xx status other than 429 — it rejected the request as built, which a username outside HN’s charset can cause.',
      recovery: 'Check the input values against this schema; the same input fails identically.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The HN API answered with HTTP 429.',
      recovery: 'Wait several seconds before retrying, and call this tool less often.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The HN API answered with a 5xx status.',
      recovery: 'Retry after a short delay; no input change helps while the upstream is down.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_html',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The HN API served an HTML error page with a 200 status, which it does under rate limiting or maintenance.',
      recovery: 'Retry after a brief delay; the upstream is throttling or in maintenance.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_malformed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The HN API answered with a 200 status and a body that is not JSON.',
      recovery: 'Retry after a brief delay; no input change helps while the upstream serves this.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  input: z.object({
    username: z
      .string()
      .trim()
      .min(1)
      .describe(
        'HN username. Case-sensitive. Trimmed; blank or whitespace-only input is rejected.',
      ),
    includeSubmissions: z
      .boolean()
      .default(false)
      .describe(
        "Resolve the user's most recent submissions into full items. Without this, only the submission count is available.",
      ),
    submissionCount: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Page size — how many submissions to resolve per call. Only used when includeSubmissions is true.',
      ),
    submissionOffset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'How many submissions to skip before resolving, counting back from the most recent. Use with submissionCount to page through a long history: request offset 0, then offset submissionCount, and so on. The enrichment block echoes submissionOffset and, when more remain, the offset to send next. Only used when includeSubmissions is true.',
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
        z
          .object({
            id: z.number().describe('Item ID — use with hn_get_thread to read comments.'),
            type: z.string().describe('Item type (story, comment, job, poll).'),
            title: z.string().optional().describe('Title (stories/jobs/polls).'),
            url: z.string().optional().describe('External link URL.'),
            text: z.string().optional().describe('Body text (HTML stripped).'),
            score: z.number().optional().describe('Score/upvotes.'),
            time: z.number().optional().describe('Unix timestamp.'),
            descendants: z.number().optional().describe('Comment count (stories/polls).'),
          })
          .describe('A single submission by the user (story, comment, job, or poll).'),
      )
      .optional()
      .describe(
        'One page of submissions, most recent first, starting at submissionOffset. Absent when includeSubmissions is false or the user has never submitted. Empty when the page holds no live items — either the offset is past the end, or every item in the window was deleted or flagged.',
      ),
  }),

  enrichment: {
    submissionOffset: z
      .number()
      .optional()
      .describe(
        'The offset this page started at. Absent when includeSubmissions is false or the user has never submitted.',
      ),
    truncated: z.boolean().optional().describe('True when submissions remain beyond this page.'),
    shown: z.number().optional().describe('Number of submissions returned.'),
    cap: z.number().optional().describe('The submissionCount cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Pagination context — which window of the history this page covers and the submissionOffset to send next, or a warning that the offset is past the end. Absent when the page reaches the end of the history, or when no submissions were resolved.',
      ),
  },

  async handler(input, ctx) {
    const hn = getHnService();
    const user = await hn.fetchUser(input.username, ctx);
    if (!user) {
      throw ctx.fail('user_not_found', `User ${input.username} not found`, {
        username: input.username,
        ...ctx.recoveryFor('user_not_found'),
      });
    }

    const profile = {
      id: user.id,
      karma: user.karma,
      created: user.created,
      about: user.about ? stripHtml(user.about) : undefined,
      totalSubmissions: user.submitted?.length ?? 0,
    };

    const offset = input.submissionOffset;
    const pageEnd = offset + input.submissionCount;

    const submissions =
      input.includeSubmissions && user.submitted?.length
        ? filterLiveItems(await hn.fetchItems(user.submitted.slice(offset, pageEnd), ctx)).map(
            (item) => ({
              id: item.id,
              type: item.type,
              title: item.title ? stripHtml(item.title) : undefined,
              url: normalizeUrl(item.url),
              text: item.text ? stripHtml(item.text) : undefined,
              score: item.score,
              time: item.time,
              descendants: item.descendants,
            }),
          )
        : undefined;

    ctx.log.info('Fetched user', {
      username: input.username,
      offset,
      submissions: submissions?.length,
    });

    if (submissions) {
      const total = profile.totalSubmissions;
      ctx.enrich({ submissionOffset: offset });

      if (offset >= total) {
        ctx.enrich.notice(
          `submissionOffset ${offset} is past the end of ${total.toLocaleString()} submissions. Valid offsets are 0 to ${total - 1}.`,
        );
      } else if (pageEnd < total) {
        ctx.enrich.truncated({ shown: submissions.length, cap: input.submissionCount });
        ctx.enrich.notice(
          `Showing ${submissions.length} live item${submissions.length === 1 ? '' : 's'} from positions ${(offset + 1).toLocaleString()}–${pageEnd.toLocaleString()} of ${total.toLocaleString()} submissions. Set submissionOffset to ${pageEnd} for the next page.`,
        );
      }
    }

    return { user: profile, submissions };
  },

  format: (result) => {
    const { user } = result;
    const joined = `${new Date(user.created * 1000).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    })} (t:${user.created})`;
    const lines: string[] = [
      `## ${user.id}`,
      `**Karma:** ${user.karma} | **Joined:** ${joined} | **Total submissions:** ${user.totalSubmissions}`,
    ];

    if (user.about) lines.push(`\n${user.about}`);

    if (result.submissions?.length) {
      lines.push('\n### Submissions');
      for (const s of result.submissions) {
        const title = s.title || `[${s.type}]`;
        const date = s.time
          ? `${new Date(s.time * 1000).toISOString().slice(0, 10)} (t:${s.time})`
          : '';
        const meta = [
          `id:${s.id}`,
          s.title ? s.type : null,
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
