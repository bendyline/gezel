import { join } from 'node:path';
import {
  HARNESS_PROMPTS,
  HARNESS_PROMPT_NAMES,
  HARNESS_TOOL_DESCRIPTIONS,
  ISSUE_VERDICT_KINDS,
  type IssueHandoffRequest,
  MAX_APP_ISSUE_VERDICTS_PER_CALL,
  harnessPromptCount,
  renderHarnessIssuePrompt,
  renderIssueBatch,
} from '@bendyline/gezel';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { absoluteFromApp, relativeInside, whereFilesMayBe } from './paths.js';
import { type HarnessBinding, type HarnessSession, boundProjectId } from './session.js';
import { failure, guarded, text } from './tools.js';

const UPDATE_GEZEL =
  'This version of Gezel cannot hand issues to other apps. Update Gezel to use this tool.';
const NO_PROJECT =
  "This app isn't working in a folder Gezel knows, so there are no issues to check. Start the app in a folder Gezel has added.";

/** Why this binding cannot work on issues, or null when it can. */
function issuesBlocked(binding: HarnessBinding, need: 'read' | 'triage'): string | null {
  const mode = binding.info?.issues;
  if (mode === undefined) return UPDATE_GEZEL;
  if (mode === 'off')
    return "Gezel's issues are turned off for other apps (Settings → Integrations).";
  if (need === 'triage' && mode !== 'triage') {
    return 'Reporting verdicts is turned off for other apps in Gezel (Settings → Integrations); you can still list issues.';
  }
  return boundProjectId(binding) ? null : NO_PROJECT;
}

async function fetchBatch(
  session: HarnessSession,
  binding: HarnessBinding,
  req: IssueHandoffRequest,
): Promise<string> {
  const id = boundProjectId(binding) as string;
  const queue = await session.run(binding, (api) => api.issueTriage.handoffQueue(id, req));
  const workingDir = binding.info?.project?.workingDir;
  return renderIssueBatch(queue, (rel) => (workingDir ? join(workingDir, rel) : rel));
}

/** `list_issues` and `report_issue_verdicts`: the night shift's BW issues, for an outside app to judge. */
export function registerHarnessIssueTools(server: McpServer, session: HarnessSession): void {
  server.registerTool(
    'list_issues',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.list_issues,
      inputSchema: {
        limit: z.number().int().positive().max(50).optional().describe('Default 20.'),
        severity: z.enum(['major', 'minor', 'info']).optional(),
        pathPrefix: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Only issues under this folder: an absolute path, or one relative to this folder.',
          ),
        includeInfo: z.boolean().optional().describe('Include info-level leads. Default false.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(async () => {
        const binding = await session.bind(args.pathPrefix);
        const blocked = issuesBlocked(binding, 'read');
        if (blocked) return failure(blocked);
        let pathPrefix: string | undefined;
        if (args.pathPrefix) {
          const workingDir = binding.info?.project?.workingDir;
          const rel = workingDir
            ? relativeInside(workingDir, absoluteFromApp(binding, args.pathPrefix))
            : null;
          if (rel === null)
            return failure(`pathPrefix must be inside ${whereFilesMayBe(binding)}.`);
          if (rel) pathPrefix = rel;
        }
        return text(
          await fetchBatch(session, binding, {
            ...(args.limit ? { limit: args.limit } : {}),
            ...(args.severity ? { severity: args.severity } : {}),
            ...(pathPrefix ? { pathPrefix } : {}),
            ...(args.includeInfo ? { includeInfo: true } : {}),
          }),
        );
      }),
  );

  server.registerTool(
    'report_issue_verdicts',
    {
      description: HARNESS_TOOL_DESCRIPTIONS.report_issue_verdicts,
      inputSchema: {
        verdicts: z
          .array(
            z.object({
              ref: z
                .string()
                .regex(/^BW-[1-9]\d*$/)
                .describe('The issue code, e.g. BW-17.'),
              verdict: z.enum(ISSUE_VERDICT_KINDS),
              reason: z
                .enum(['incorrect', 'handled_elsewhere', 'intended'])
                .optional()
                .describe('Only for not_a_bug.'),
              note: z
                .string()
                .min(3)
                .max(2000)
                .describe(
                  'Your evidence in a sentence: a file:line, a test, the caller that handles it.',
                ),
              duplicateOf: z
                .string()
                .regex(/^BW-[1-9]\d*$/)
                .optional()
                .describe('Only for duplicate: the issue this one repeats.'),
            }),
          )
          .min(1)
          .max(MAX_APP_ISSUE_VERDICTS_PER_CALL),
      },
    },
    async (args) =>
      guarded(async () => {
        const binding = await session.bind();
        const blocked = issuesBlocked(binding, 'triage');
        if (blocked) return failure(blocked);
        const id = boundProjectId(binding) as string;
        const res = await session.run(binding, (api) =>
          api.issueTriage.applyVerdicts(id, {
            verdicts: args.verdicts.map((v) => ({
              ref: v.ref,
              kind: v.verdict,
              ...(v.verdict === 'not_a_bug' && v.reason ? { reason: v.reason } : {}),
              note: v.note,
              ...(v.duplicateOf ? { duplicateOf: v.duplicateOf } : {}),
            })),
          }),
        );
        const lines = [
          `Gezel recorded ${res.applied} verdict${res.applied === 1 ? '' : 's'}${res.refused ? `; ${res.refused} refused` : ''}.`,
          ...res.results
            .filter((r) => r.outcome === 'refused')
            .map((r) => `- ${r.ref}: ${r.message}`),
          ...res.results
            .filter((r) => r.outcome === 'applied' && /can't confirm/.test(r.message))
            .map((r) => `- ${r.message}`),
        ];
        return text(lines.join('\n'));
      }),
  );
}

/**
 * The prompts a person runs in their app (`/mcp__gezel__triage_issues` in
 * Claude Code). Each fetches a batch when it is requested and embeds it, so
 * the model starts with the list rather than having to ask for it.
 */
export function registerHarnessPrompts(server: McpServer, session: HarnessSession): void {
  for (const name of HARNESS_PROMPT_NAMES) {
    const prompt = HARNESS_PROMPTS[name];
    server.registerPrompt(
      name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: {
          count: z
            .string()
            .optional()
            .describe(`How many issues to take on (default ${prompt.defaultCount}, at most 50).`),
        },
      },
      async (args) => {
        let body: string;
        try {
          const binding = await session.bind();
          const blocked = issuesBlocked(binding, name === 'fix_issues' ? 'triage' : 'read');
          body = blocked
            ? blocked
            : renderHarnessIssuePrompt(
                name,
                await fetchBatch(session, binding, {
                  limit: harnessPromptCount(name, args.count),
                  ...(name === 'fix_issues' ? { mode: 'fix' as const } : {}),
                }),
              );
        } catch (err) {
          body = err instanceof Error ? err.message : String(err);
        }
        return {
          messages: [{ role: 'user' as const, content: { type: 'text' as const, text: body } }],
        };
      },
    );
  }
}
