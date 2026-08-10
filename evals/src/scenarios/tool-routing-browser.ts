import type { MockService } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import type { MockMcpToolArgumentSchemas } from '../mock/mock-server.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { provisionScenarioGezel } from './helpers.ts';

/**
 * Focused browser-tool routing probe.
 *
 * This is deliberately not a browser craftbook and deliberately does not
 * claim to exercise Chromium. A hermetic HTTP MCP stands in for
 * `@playwright/mcp`, while the normal catalog/system-toolset discovery,
 * session bridge, model tool calls, and History append path remain real. The
 * service route tests own the complementary real-Chromium assertion.
 */

const PROJECT_NAME = 'Browser Tool Probe';
const WORKER_NAME = 'Mira';
const MOCK_ID = 'playwright';

export const BROWSER_TARGET_URL = 'https://browser-probe.invalid/signup';
export const BROWSER_SCREENSHOT_PATH = 'evidence/browser-tool-probe.png';

export const REQUIRED_BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_console_messages',
  'browser_take_screenshot',
] as const;

export const BROWSER_MCP_TOOL_ARGUMENT_SCHEMAS: MockMcpToolArgumentSchemas = {
  [MOCK_ID]: {
    browser_navigate: {
      url: { description: 'Full URL to navigate to.' },
    },
    browser_click: {
      ref: { description: 'Exact element ref from the latest browser snapshot.' },
    },
    browser_type: {
      ref: { description: 'Exact textbox ref from the latest browser snapshot.' },
      text: { description: 'Text to enter into the textbox.' },
    },
  },
};

export const BROWSER_TOOL_MOCK_SERVICES: MockService[] = [
  {
    kind: 'mcp',
    id: MOCK_ID,
    toolsetId: '@playwright/mcp',
    description:
      'Hermetic browser simulator for a short tool-routing probe. It records real MCP calls while returning deterministic page state.',
    tools: [
      {
        name: 'browser_navigate',
        description: `Navigate to a URL. For this probe use ${BROWSER_TARGET_URL} as the url argument.`,
        resultTemplate: {
          url: BROWSER_TARGET_URL,
          title: 'Browser Tool Probe',
          status: 'loaded',
        },
      },
      {
        name: 'browser_snapshot',
        description: 'Read the current page accessibility snapshot and interactive element refs.',
        resultTemplate: {
          heading: 'Browser Tool Probe',
          controls: [
            { role: 'button', name: 'Menu', ref: 'e1' },
            { role: 'textbox', name: 'Email', ref: 'e2' },
          ],
        },
      },
      {
        name: 'browser_click',
        description: 'Click a page element by its snapshot ref. Click the Menu button at ref e1.',
        resultTemplate: { clicked: 'e1', menu: 'open' },
      },
      {
        name: 'browser_type',
        description:
          'Type text into a page element by its snapshot ref. Enter crew@example.com in Email at ref e2.',
        resultTemplate: { typed: 'crew@example.com', target: 'e2' },
      },
      {
        name: 'browser_console_messages',
        description: 'Read console messages emitted by the current page.',
        resultTemplate: { messages: ['info: browser-tool-probe-ready'] },
      },
      {
        name: 'browser_take_screenshot',
        description: `Capture a screenshot. Pass filename: "${BROWSER_SCREENSHOT_PATH}".`,
        resultTemplate: { saved: true, filename: BROWSER_SCREENSHOT_PATH },
        writeFixture: {
          surface: 'workspace',
          pathArgument: 'filename',
          fixture: 'minimal-png',
        },
      },
    ],
  },
];

export const BROWSER_TOOL_KICKOFF = [
  'Run one short browser-tool smoke journey. Do not create a task, delegate, inspect source, use fetch_url, or write a report.',
  `Call \`browser_navigate\` once with url \`${BROWSER_TARGET_URL}\`.`,
  'Then call `browser_snapshot` once.',
  'From the returned refs, call `browser_click` once on the Menu button and `browser_type` once to enter `crew@example.com` in Email.',
  'Call `browser_console_messages` once.',
  `Finally call \`browser_take_screenshot\` once with filename \`${BROWSER_SCREENSHOT_PATH}\`.`,
  'After those six real tool calls, reply briefly in chat. Tool-call markup or a prose claim does not count.',
].join(' ');

interface BrowserHistoryEvidence {
  name: string;
  researchTarget?: string;
}

export interface BrowserMockToolCallEvidence {
  name: string;
  args?: Record<string, unknown>;
}

export interface BrowserToolEvidenceCheck {
  ok: boolean;
  score: number;
  scoreMax: number;
  signals: string[];
  failReason?: string;
}

function hasPngSignature(bytes: Uint8Array | null): boolean {
  if (!bytes || bytes.byteLength < 8) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Pure evidence gate used by the live success check and focused unit tests. */
export function checkBrowserToolEvidence(input: {
  history: readonly BrowserHistoryEvidence[];
  mockToolCalls: readonly BrowserMockToolCallEvidence[];
  screenshotBytes: Uint8Array | null;
}): BrowserToolEvidenceCheck {
  const historyNames = new Set(input.history.map((entry) => entry.name));
  const mockNames = new Set(input.mockToolCalls.map((entry) => entry.name));
  const signals: string[] = [];

  for (const tool of REQUIRED_BROWSER_TOOL_NAMES) {
    if (historyNames.has(tool)) signals.push(`history:${tool}`);
  }
  for (const tool of REQUIRED_BROWSER_TOOL_NAMES) {
    if (mockNames.has(tool)) signals.push(`mock:${tool}`);
  }

  const exactNavigation = input.history.some(
    (entry) => entry.name === 'browser_navigate' && entry.researchTarget === BROWSER_TARGET_URL,
  );
  if (exactNavigation) signals.push('exact-navigation-target');

  const mockCallMatches = (name: string, predicate: (args: Record<string, unknown>) => boolean) =>
    input.mockToolCalls.some(
      (entry) => entry.name === name && entry.args !== undefined && predicate(entry.args),
    );
  const mockArgumentFailure = !mockCallMatches(
    'browser_navigate',
    (args) => args.url === BROWSER_TARGET_URL,
  )
    ? `browser_navigate did not receive url ${BROWSER_TARGET_URL}`
    : !mockCallMatches('browser_click', (args) => args.ref === 'e1')
      ? 'browser_click did not use Menu ref e1'
      : !mockCallMatches(
            'browser_type',
            (args) => args.ref === 'e2' && args.text === 'crew@example.com',
          )
        ? 'browser_type did not enter crew@example.com at Email ref e2'
        : !mockCallMatches(
              'browser_take_screenshot',
              (args) => args.filename === BROWSER_SCREENSHOT_PATH,
            )
          ? `browser_take_screenshot did not use filename ${BROWSER_SCREENSHOT_PATH}`
          : undefined;
  if (!mockArgumentFailure) signals.push('meaningful-browser-arguments');

  const screenshotIsPng =
    input.screenshotBytes !== null &&
    input.screenshotBytes.byteLength >= 1_024 &&
    hasPngSignature(input.screenshotBytes);
  if (screenshotIsPng) signals.push('real-png-screenshot');

  const missingHistory = REQUIRED_BROWSER_TOOL_NAMES.find((tool) => !historyNames.has(tool));
  const missingMock = REQUIRED_BROWSER_TOOL_NAMES.find((tool) => !mockNames.has(tool));
  const failReason = missingHistory
    ? `no successful ${missingHistory} tool.called History event`
    : missingMock
      ? `mock MCP did not observe ${missingMock}`
      : !exactNavigation
        ? `browser_navigate History did not target ${BROWSER_TARGET_URL}`
        : (mockArgumentFailure ??
          (!screenshotIsPng
            ? `${BROWSER_SCREENSHOT_PATH} is missing or is not a real PNG`
            : undefined));

  return {
    ok: failReason === undefined,
    score: signals.length,
    scoreMax: REQUIRED_BROWSER_TOOL_NAMES.length * 2 + 3,
    signals,
    ...(failReason ? { failReason } : {}),
  };
}

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((project) => project.name === PROJECT_NAME)?.id ?? null;
}

async function successfulBrowserHistory(
  client: GezelClient,
  projectId: string,
): Promise<BrowserHistoryEvidence[]> {
  try {
    const { entries } = await client.listHistory({
      projectId,
      kind: 'tool.called',
      limit: 200,
    });
    return entries.flatMap((entry) => {
      if (entry.entryType !== 'event' || entry.kind !== 'tool.called') return [];
      const details = entry.details as Record<string, unknown> | undefined;
      if (details?.success !== true || typeof details.name !== 'string') return [];
      return [
        {
          name: details.name,
          ...(typeof details.researchTarget === 'string'
            ? { researchTarget: details.researchTarget }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

async function screenshotBytes(client: GezelClient, projectId: string): Promise<Uint8Array | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, BROWSER_SCREENSHOT_PATH);
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

async function setup(ctx: EvalContext): Promise<void> {
  if (!ctx.mocks) throw new Error('tool-routing-browser setup: browser mock runtime did not start');

  let projectId = await findProjectId(ctx.client);
  if (!projectId) {
    const project = await ctx.client.createProject({
      name: PROJECT_NAME,
      mode: 'solo',
      about:
        'A hermetic browser-tool smoke probe. The browser dependency is simulated; routing, MCP calls, and History are real.',
      missionObjectives:
        'Complete one six-call browser journey and leave a screenshot through the configured browser tool.',
    });
    projectId = project.id;
    ctx.log(`[scenario:setup] created browser probe project id=${projectId}`);
  }

  ctx.mocks.bindProject(projectId);

  const worker = await provisionScenarioGezel(ctx, {
    preferredName: WORKER_NAME,
    role: 'Web Developer',
    label: 'browser probe worker',
  });
  await ctx.client.addGezelToProject(projectId, worker.id);

  // Installing one builtin group replaces the broad role-default builtin
  // roster. The system-scoped @playwright/mcp tools remain available, giving
  // this worker a deliberately small surface for a routing probe.
  await ctx.client.installToolset('builtin.interaction', {
    scope: { kind: 'gezel', gezelId: worker.id },
  });

  await ctx.client.sendChatMessage(worker.id, {
    message: BROWSER_TOOL_KICKOFF,
    projectId,
  });
  ctx.log(`[scenario:setup] sent direct six-call browser kickoff to ${worker.name}`);
}

export const toolRoutingBrowserScenario: EvalScenario = {
  id: 'tool-routing-browser',
  description:
    'Runs a six-call browser primitive journey through a hermetic @playwright/mcp simulator and requires matching successful History events plus a real PNG screenshot.',
  prompt: `${WORKER_NAME} is running the focused browser-tool probe in the "${PROJECT_NAME}" project. No Meester action is needed.`,
  evidenceTexts: [BROWSER_TOOL_KICKOFF],
  mockServices: BROWSER_TOOL_MOCK_SERVICES,
  mockMcpToolArgumentSchemas: BROWSER_MCP_TOOL_ARGUMENT_SCHEMAS,
  timeoutMs: 15 * 60_000,
  progressTimeoutMs: 5 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const projectId = await findProjectId(ctx.client);
    if (!projectId) {
      ctx.logChanged('browser-tool-probe', '[scenario] browser tool probe project not present yet');
      return { done: false };
    }
    const service = ctx.mocks?.services.get(MOCK_ID);
    if (!service) {
      ctx.requestTerminalFailure?.({
        reason: 'browser mock service missing — scenario cannot be graded',
        failureMode: 'spawn-error',
      });
      return { done: false };
    }

    const [history, png] = await Promise.all([
      successfulBrowserHistory(ctx.client, projectId),
      screenshotBytes(ctx.client, projectId),
    ]);
    const mockToolCalls = service.requests
      .filter((entry) => entry.authorized && entry.status === 200)
      .flatMap((entry) =>
        entry.path.startsWith('tools/call:')
          ? [
              {
                name: entry.path.slice('tools/call:'.length),
                ...(entry.toolArgs ? { args: entry.toolArgs } : {}),
              },
            ]
          : [],
      );
    const check = checkBrowserToolEvidence({
      history,
      mockToolCalls,
      screenshotBytes: png,
    });

    ctx.logChanged(
      'browser-tool-probe',
      `[scenario] browser-tool score=${check.score}/${check.scoreMax} history=${history.length} mockCalls=${mockToolCalls.length} screenshotBytes=${png?.byteLength ?? 0}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    ctx.recordSniff?.({
      key: 'tool-routing-browser',
      score: check.score,
      bytes: png?.byteLength ?? 0,
      ...(check.failReason ? { failReason: check.failReason } : {}),
    });

    if (!check.ok) return { done: false };
    return {
      done: true,
      success: true,
      reason: `all six browser primitives crossed the mock MCP bridge, were recorded as successful History events, and produced ${BROWSER_SCREENSHOT_PATH}`,
    };
  },
};
