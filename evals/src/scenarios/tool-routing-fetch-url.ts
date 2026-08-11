import type { MockService } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { provisionScenarioGezel } from './helpers.ts';

/**
 * Focused end-to-end probe for Gezel's curl-equivalent `fetch_url` tool.
 *
 * This is intentionally not a fake MCP tool named `fetch_url`. The model
 * calls the first-party MCP wrapper, which crosses the client/service HTTP
 * boundary and performs a real HTTPS request to the per-trial fixture. The
 * runner grants only this fixture's exact ephemeral origin behind the
 * two-key eval marker; all ordinary policy, secret-screening, redirect, and
 * response handling remains on the production path.
 */

const PROJECT_NAME = 'Fetch URL Tool Probe';
const WORKER_NAME = 'Mara';
const MOCK_ID = 'fetch-receiver';
const RECEIVER_PATH = '/ingest/fetch-url';
export const FETCH_URL_RECEIPT_PATH = 'fetch-url-receipt.md';
export const FETCH_URL_PROBE_ID = 'GEZEL-FETCH-URL-E2E-v1';
export const FETCH_URL_PROBE_BODY = JSON.stringify({ probe: FETCH_URL_PROBE_ID });

export const FETCH_URL_MOCK_SERVICES: MockService[] = [
  {
    kind: 'webhook',
    id: MOCK_ID,
    description:
      'Hermetic HTTPS receiver for the fetch_url end-to-end probe. It accepts one POST and returns {"ok":true}.',
    path: RECEIVER_PATH,
  },
];

export const FETCH_URL_KICKOFF = [
  'Exercise Gezel’s curl-equivalent tool against the local eval receiver.',
  'First call `fetch_url` (not a browser tool, script, shell command, or fake XML markup)',
  'with method POST, header `content-type: application/json`, and body',
  `${FETCH_URL_PROBE_BODY}.`,
  `Send it to {{mock:${MOCK_ID}.baseUrl}}${RECEIVER_PATH}.`,
  `After the call returns, write \`${FETCH_URL_RECEIPT_PATH}\` at the workspace root.`,
  'Record the exact URL, POST method, HTTP status, response body, and probe id.',
  'Do not claim success from the instructions alone: the request and receipt are both graded.',
].join(' ');

export interface FetchUrlReceiptCheck {
  ok: boolean;
  score: number;
  scoreMax: number;
  signals: string[];
  failReason?: string;
}

/** Content-only half of the gate; request + History provenance are separate. */
export function checkFetchUrlReceipt(markdown: string): FetchUrlReceiptCheck {
  const signals: string[] = [];
  const missing: string[] = [];
  const requireSignal = (name: string, pattern: RegExp, why: string) => {
    if (pattern.test(markdown)) signals.push(name);
    else missing.push(why);
  };

  requireSignal('post-method', /\bPOST\b/i, 'receipt does not record the POST method');
  requireSignal(
    'http-200',
    /(?:HTTP\s*)?(?:status\s*[:=]?\s*)?200\b/i,
    'receipt does not record HTTP status 200',
  );
  requireSignal(
    'ok-response',
    /["']?ok["']?\s*:\s*true/i,
    'receipt does not record the {"ok":true} response',
  );
  requireSignal(
    'probe-id',
    new RegExp(FETCH_URL_PROBE_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `receipt does not record probe id ${FETCH_URL_PROBE_ID}`,
  );

  return {
    ok: missing.length === 0,
    score: signals.length,
    scoreMax: 4,
    signals,
    ...(missing[0] ? { failReason: missing[0] } : {}),
  };
}

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((project) => project.name === PROJECT_NAME)?.id ?? null;
}

async function readReceipt(client: GezelClient, projectId: string): Promise<string | null> {
  try {
    return await (await client.fetchProjectWorkspaceBlob(projectId, FETCH_URL_RECEIPT_PATH)).text();
  } catch {
    return null;
  }
}

async function hasSuccessfulFetchHistory(
  client: GezelClient,
  projectId: string,
  exactUrl: string,
): Promise<boolean> {
  try {
    const { entries } = await client.listHistory({
      projectId,
      kind: 'tool.called',
      limit: 200,
    });
    return entries.some((entry) => {
      if (entry.entryType !== 'event' || entry.kind !== 'tool.called') return false;
      const details = entry.details as Record<string, unknown> | undefined;
      return (
        details?.name === 'fetch_url' &&
        details.success === true &&
        details.researchTarget === exactUrl
      );
    });
  } catch {
    return false;
  }
}

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log, mocks } = ctx;
  if (!mocks) throw new Error('tool-routing-fetch-url setup: HTTPS mock runtime did not start');

  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A hermetic tool-routing probe. The only external-looking endpoint is the per-trial HTTPS receiver.',
      missionObjectives:
        'Call the real built-in fetch_url tool, observe its response, and leave an auditable receipt.',
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  }

  mocks.bindProject(projectId);
  await client.writeProjectWorkspaceFile(projectId, {
    path: 'mocks/services.md',
    content: mocks.servicesMarkdown(),
  });

  const worker = await provisionScenarioGezel(ctx, {
    preferredName: WORKER_NAME,
    role: 'Researcher',
    label: 'fetch-url probe worker',
  });
  await client.addGezelToProject(projectId, worker.id);
  // Installing any builtin group replaces the role defaults. Keep the
  // resulting surface deliberately small: `web` supplies fetch_url and the
  // workspace groups supply only the receipt read/write path.
  for (const toolsetId of [
    'builtin.web',
    'builtin.workspace-fs-read',
    'builtin.workspace-fs-write',
  ]) {
    await client.installToolset(toolsetId, { scope: { kind: 'gezel', gezelId: worker.id } });
  }

  await client.sendChatMessage(worker.id, {
    message: mocks.substitute(FETCH_URL_KICKOFF),
    projectId,
  });
  log(`[scenario:setup] sent direct fetch_url kickoff to ${worker.name}`);
}

export const toolRoutingFetchUrlScenario: EvalScenario = {
  id: 'tool-routing-fetch-url',
  description:
    'Calls the real built-in fetch_url tool against a hermetic HTTPS receiver and requires both an actual request-log entry and a successful tool.called History event before accepting the receipt.',
  prompt: `${WORKER_NAME} is running a focused fetch_url probe in the "${PROJECT_NAME}" project. No Meester action is needed.`,
  evidenceTexts: [FETCH_URL_KICKOFF],
  mockServices: FETCH_URL_MOCK_SERVICES,
  allowFetchUrlMockServiceIds: [MOCK_ID],
  timeoutMs: 20 * 60_000,
  progressTimeoutMs: 8 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const projectId = await findProjectId(ctx.client);
    if (!projectId) {
      ctx.logChanged('project', '[scenario] fetch_url probe project not present yet');
      return { done: false };
    }
    if (!ctx.mocks) {
      ctx.requestTerminalFailure?.({
        reason: 'fetch_url HTTPS mock runtime missing — scenario cannot be graded',
        failureMode: 'spawn-error',
      });
      return { done: false };
    }
    const service = ctx.mocks.services.get(MOCK_ID);
    if (!service) {
      ctx.requestTerminalFailure?.({
        reason: `fetch_url mock service ${MOCK_ID} missing — scenario cannot be graded`,
        failureMode: 'spawn-error',
      });
      return { done: false };
    }

    const exactUrl = `${service.baseUrl}${RECEIVER_PATH}`;
    const markdown = await readReceipt(ctx.client, projectId);
    const receipt = checkFetchUrlReceipt(markdown ?? '');
    const mockRequests = service.requests.filter(
      (entry) =>
        entry.authorized &&
        entry.method === 'POST' &&
        entry.path === RECEIVER_PATH &&
        entry.status === 200,
    );
    const mockRequestSeen = mockRequests.length > 0;
    const contentTypeSeen = mockRequests.some((entry) => entry.contentType === 'application/json');
    const requestBodySeen = mockRequests.some(
      (entry) => entry.requestBodyTruncated !== true && entry.requestBody === FETCH_URL_PROBE_BODY,
    );
    const validMockRequestSeen = mockRequests.some(
      (entry) =>
        entry.contentType === 'application/json' &&
        entry.requestBodyTruncated !== true &&
        entry.requestBody === FETCH_URL_PROBE_BODY,
    );
    const diagnosticRequest = mockRequests.at(-1);
    const historySeen = await hasSuccessfulFetchHistory(ctx.client, projectId, exactUrl);
    const score =
      receipt.score +
      Number(mockRequestSeen) +
      Number(contentTypeSeen) +
      Number(requestBodySeen) +
      Number(historySeen);
    const scoreMax = receipt.scoreMax + 4;
    const failReason =
      receipt.failReason ??
      (!mockRequestSeen
        ? `no successful POST reached ${RECEIVER_PATH}`
        : !contentTypeSeen
          ? `fetch_url POST content-type was ${JSON.stringify(diagnosticRequest?.contentType ?? null)}; expected exactly "application/json"`
          : !requestBodySeen
            ? `fetch_url POST body was ${diagnosticRequest?.requestBodyTruncated ? 'truncated' : JSON.stringify(diagnosticRequest?.requestBody ?? null)}; expected exactly ${FETCH_URL_PROBE_BODY}`
            : !validMockRequestSeen
              ? 'no single fetch_url POST had both the exact application/json content type and exact probe body'
              : !historySeen
                ? 'no successful fetch_url tool.called History event targets the exact receiver URL'
                : undefined);

    ctx.logChanged(
      'fetch-url-probe',
      `[scenario] fetch_url receiptBytes=${markdown?.length ?? 0} score=${score}/${scoreMax} mockRequest=${mockRequestSeen ? 'yes' : 'no'} contentType=${contentTypeSeen ? 'yes' : 'no'} requestBody=${requestBodySeen ? 'yes' : 'no'} history=${historySeen ? 'yes' : 'no'}${failReason ? ` failReason="${failReason}"` : ''}`,
    );
    ctx.recordSniff?.({
      key: 'tool-routing-fetch-url',
      score,
      bytes: markdown?.length ?? 0,
      ...(failReason ? { failReason } : {}),
    });

    if (!receipt.ok || !validMockRequestSeen || !historySeen) {
      return { done: false };
    }
    return {
      done: true,
      success: true,
      reason: `fetch_url POST reached ${exactUrl}, returned 200, was recorded in History, and produced ${FETCH_URL_RECEIPT_PATH}`,
    };
  },
};
