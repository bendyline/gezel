import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import type { MockServicesRuntime } from '../mock/mock-server.ts';
import type { EvalContext } from '../types.ts';
import { getScenario } from './index.ts';
import {
  BROWSER_MCP_TOOL_ARGUMENT_SCHEMAS,
  BROWSER_SCREENSHOT_PATH,
  BROWSER_TARGET_URL,
  BROWSER_TOOL_MOCK_SERVICES,
  REQUIRED_BROWSER_TOOL_NAMES,
  checkBrowserToolEvidence,
  toolRoutingBrowserScenario,
} from './tool-routing-browser.ts';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function pngBytes(): Uint8Array {
  const bytes = new Uint8Array(2_048);
  bytes.set(PNG_SIGNATURE);
  return bytes;
}

function completeHistory(researchTarget = BROWSER_TARGET_URL) {
  return REQUIRED_BROWSER_TOOL_NAMES.map((name) => ({
    name,
    ...(name === 'browser_navigate' ? { researchTarget } : {}),
  }));
}

function argsFor(name: string): Record<string, unknown> {
  if (name === 'browser_navigate') return { url: BROWSER_TARGET_URL };
  if (name === 'browser_click') return { ref: 'e1' };
  if (name === 'browser_type') return { ref: 'e2', text: 'crew@example.com' };
  if (name === 'browser_take_screenshot') return { filename: BROWSER_SCREENSHOT_PATH };
  return {};
}

function completeMockCalls() {
  return REQUIRED_BROWSER_TOOL_NAMES.map((name) => ({ name, args: argsFor(name) }));
}

function context(
  opts: {
    historyTools?: readonly string[];
    mockTools?: readonly string[];
    navigationTarget?: string;
    screenshot?: Uint8Array | null;
  } = {},
): EvalContext {
  const historyTools = opts.historyTools ?? REQUIRED_BROWSER_TOOL_NAMES;
  const mockTools = opts.mockTools ?? REQUIRED_BROWSER_TOOL_NAMES;
  const screenshot = opts.screenshot === undefined ? pngBytes() : opts.screenshot;
  const service = {
    id: 'playwright',
    kind: 'mcp' as const,
    baseUrl: 'https://127.0.0.1:43123',
    credentialName: null,
    token: null,
    requests: mockTools.map((name) => ({
      at: new Date(0).toISOString(),
      method: 'POST',
      path: `tools/call:${name}`,
      matchedRoute: `tools/call ${name}`,
      status: 200,
      authorized: true,
      toolArgs: argsFor(name),
    })),
  };
  const mocks = {
    services: new Map([[service.id, service]]),
  } as unknown as MockServicesRuntime;
  const client = {
    listProjects: vi.fn(async () => ({
      projects: [{ id: 'browser-probe', name: 'Browser Tool Probe' }],
    })),
    listHistory: vi.fn(async () => ({
      entries: historyTools.map((name) => ({
        entryType: 'event',
        kind: 'tool.called',
        summary: `Tool ${name} ran (1ms)`,
        details: {
          name,
          success: true,
          ...(name === 'browser_navigate'
            ? { researchTarget: opts.navigationTarget ?? BROWSER_TARGET_URL }
            : {}),
        },
      })),
    })),
    fetchProjectWorkspaceBlob: vi.fn(async (_projectId: string, path: string) => {
      if (path !== BROWSER_SCREENSHOT_PATH || screenshot === null) throw new Error('not found');
      return new Blob([screenshot as BlobPart]);
    }),
  } as unknown as GezelClient;

  return {
    client,
    meesterId: 'meester',
    mocks,
    log: vi.fn(),
    logChanged: vi.fn(),
    recordSniff: vi.fn(),
  };
}

describe('tool-routing-browser', () => {
  it('is a first-class scenario backed by the hermetic system Playwright replacement', () => {
    expect(getScenario('tool-routing-browser')).toBe(toolRoutingBrowserScenario);
    expect(BROWSER_TOOL_MOCK_SERVICES).toHaveLength(1);
    expect(toolRoutingBrowserScenario.mockMcpToolArgumentSchemas).toBe(
      BROWSER_MCP_TOOL_ARGUMENT_SCHEMAS,
    );
    expect(BROWSER_TOOL_MOCK_SERVICES[0]).toMatchObject({
      kind: 'mcp',
      id: 'playwright',
      toolsetId: '@playwright/mcp',
    });
    expect(
      BROWSER_TOOL_MOCK_SERVICES[0]?.kind === 'mcp'
        ? BROWSER_TOOL_MOCK_SERVICES[0].tools.map((tool) => tool.name)
        : [],
    ).toEqual(REQUIRED_BROWSER_TOOL_NAMES);
  });

  it('accepts only complete History, MCP-call, exact-navigation, and PNG evidence', () => {
    expect(
      checkBrowserToolEvidence({
        history: completeHistory(),
        mockToolCalls: completeMockCalls(),
        screenshotBytes: pngBytes(),
      }),
    ).toMatchObject({ ok: true, score: 15, scoreMax: 15 });
  });

  it('does not pass from mock calls alone without successful History evidence', () => {
    expect(
      checkBrowserToolEvidence({
        history: [],
        mockToolCalls: completeMockCalls(),
        screenshotBytes: pngBytes(),
      }),
    ).toMatchObject({
      ok: false,
      failReason: 'no successful browser_navigate tool.called History event',
    });
  });

  it('requires the exact navigation target and a real PNG screenshot', () => {
    expect(
      checkBrowserToolEvidence({
        history: completeHistory('https://example.invalid/wrong'),
        mockToolCalls: completeMockCalls(),
        screenshotBytes: pngBytes(),
      }),
    ).toMatchObject({
      ok: false,
      failReason: `browser_navigate History did not target ${BROWSER_TARGET_URL}`,
    });
    expect(
      checkBrowserToolEvidence({
        history: completeHistory(),
        mockToolCalls: completeMockCalls(),
        screenshotBytes: new Uint8Array(2_048),
      }),
    ).toMatchObject({
      ok: false,
      failReason: `${BROWSER_SCREENSHOT_PATH} is missing or is not a real PNG`,
    });
  });

  it('requires meaningful click, type, and screenshot arguments', () => {
    const calls = completeMockCalls().map((call) =>
      call.name === 'browser_type' ? { ...call, args: { ref: 'e2', text: 'wrong' } } : call,
    );
    expect(
      checkBrowserToolEvidence({
        history: completeHistory(),
        mockToolCalls: calls,
        screenshotBytes: pngBytes(),
      }),
    ).toMatchObject({
      ok: false,
      failReason: 'browser_type did not enter crew@example.com at Email ref e2',
    });
  });

  it('accepts a correct retry after an earlier call used the wrong arguments', () => {
    const calls = [
      { name: 'browser_navigate', args: { url: 'https://wrong.invalid' } },
      { name: 'browser_type', args: { ref: 'e2', text: 'wrong' } },
      { name: 'browser_take_screenshot', args: { filename: 'wrong.png' } },
      ...completeMockCalls(),
    ];
    expect(
      checkBrowserToolEvidence({
        history: completeHistory(),
        mockToolCalls: calls,
        screenshotBytes: pngBytes(),
      }),
    ).toMatchObject({ ok: true, score: 15, scoreMax: 15 });
  });

  it('keeps polling when either the real History rail or MCP observation is incomplete', async () => {
    const withoutHistory = await toolRoutingBrowserScenario.successCheck(
      context({ historyTools: REQUIRED_BROWSER_TOOL_NAMES.slice(1) }),
    );
    expect(withoutHistory).toEqual({ done: false });

    const withoutMockCall = await toolRoutingBrowserScenario.successCheck(
      context({ mockTools: REQUIRED_BROWSER_TOOL_NAMES.slice(0, -1) }),
    );
    expect(withoutMockCall).toEqual({ done: false });
  });

  it('passes after the complete six-call journey produces its screenshot', async () => {
    await expect(toolRoutingBrowserScenario.successCheck(context())).resolves.toMatchObject({
      done: true,
      success: true,
    });
  });
});
