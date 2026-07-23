import type { GezelClient } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeReport } from './html-validation.ts';
import { _resetNudgeMemoryForTests, postRuntimeFeedback } from './runtime-feedback.ts';
import type { EvalContext } from './types.ts';

interface MockedClient {
  messageGezel: ReturnType<typeof vi.fn>;
  listChatSessions: ReturnType<typeof vi.fn>;
  listWorkspaceWrites: ReturnType<typeof vi.fn>;
}

function makeClient(
  opts: {
    sessions?: Array<{
      id: string;
      gezelId: string;
      lastActivityAt: string;
      archived?: boolean;
      projectId?: string;
    }>;
    messageGezelImpl?: () => Promise<unknown>;
    workspaceWrites?: Array<{
      at: string;
      op: 'write' | 'delete' | 'mkdir' | 'rename';
      path: string;
      gezelId?: string;
      sessionId?: string;
    }>;
  } = {},
): MockedClient {
  const sessions = opts.sessions ?? [];
  return {
    messageGezel: vi
      .fn()
      .mockImplementation(opts.messageGezelImpl ?? (() => Promise.resolve({ accepted: true }))),
    listChatSessions: vi.fn().mockResolvedValue({ sessions }),
    listWorkspaceWrites: vi.fn().mockResolvedValue({ entries: opts.workspaceWrites ?? [] }),
  };
}

function makeCtx(client: MockedClient, meesterId = 'meester-1'): EvalContext {
  const logs: string[] = [];
  return {
    client: client as unknown as GezelClient,
    meesterId,
    log: (line: string) => logs.push(line),
    logChanged: () => {
      /* unused in these tests */
    },
  };
}

function makeReport(
  failed: Array<{ name: string; why: string }>,
  passed: string[] = [],
  pageErrors: string[] = [],
): RuntimeReport {
  return {
    ran: true,
    passed,
    failed,
    pageErrors,
  };
}

describe('postRuntimeFeedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts a from-meester message naming the failed assertion verbatim on first call', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 'sess-builder',
          gezelId: 'builder-1',
          lastActivityAt: '2026-05-20T15:00:00Z',
          projectId: 'game-project',
        },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport(
      [
        {
          name: 'keyboard-listener-installed',
          why: 'DOM signature unchanged after ArrowRight + Space + 400ms',
        },
      ],
      ['canvas-present', 'no-page-errors'],
    );

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report);

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('builder-1');
    expect(body.fromGezelId).toBe('meester-1');
    expect(body.text).toContain('keyboard-listener-installed');
    expect(body.text).toContain('DOM signature unchanged after ArrowRight + Space');
    expect(body.text).toContain('window.gameState = gameState');
    expect(body.text).toContain('document.body.dataset.inputTick');
    expect(body.text).toContain('workspace/x/index.html');
    expect(body.text).toContain('validate(');
    expect(body.expectedDeliverable).toEqual({
      kind: 'file',
      filePath: 'workspace/x/index.html',
    });
    expect(body.projectId).toBe('game-project');
  });

  it('can suppress expected deliverable hints and append scenario-specific guidance', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 'sess-builder',
          gezelId: 'builder-1',
          lastActivityAt: '2026-05-20T15:00:00Z',
        },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport([{ name: 'seed-tasks-render', why: 'found 0' }], ['no-page-errors']);

    await postRuntimeFeedback(ctx, 'index.html', report, '<html></html>', {
      expectedDeliverable: null,
      extraInstruction: 'MODULE_REPAIR: keep index.html as a shell and patch src/app.js.',
    });

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.expectedDeliverable).toBeUndefined();
    expect(body.text).toContain('MODULE_REPAIR');
    expect(body.text).toContain('patch src/app.js');
  });

  it('turns undefined-identifier page errors into an exact casing repair hint', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport(
      [{ name: 'click-marks-a-cell', why: 'cell content unchanged after click' }],
      ['nine-cells-rendered'],
      ['GameState is not defined'],
    );
    const fileContent = [
      'let gameState = ["", "", ""];',
      'GameState[0] = currentPlayer;',
      'if (!GameState.includes("")) status.innerText = "draw";',
    ].join('\n');

    await postRuntimeFeedback(ctx, 'index.html', report, fileContent);

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('`GameState` is undefined');
    expect(body.text).toContain('`gameState`');
    expect(body.text).toContain(
      'replaceInFile({ path: "index.html", find: "GameState", replace: "gameState", occurrence: "all" })',
    );
    expect(body.text).toContain('Do not make an identity edit');
  });

  it('turns near-miss undefined identifiers into an exact typo repair hint', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport(
      [{ name: 'nine-cells-rendered', why: 'only 1 cell-like elements' }],
      ['js-parses'],
      ['cellDivt is not defined'],
    );
    const fileContent = [
      'const cellDiv = document.createElement("div");',
      'cellDiv.classList.add("cell");',
      'cellDivt.innerText = cell;',
      'grid.appendChild(cellDiv);',
    ].join('\n');

    await postRuntimeFeedback(ctx, 'index.html', report, fileContent);

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('`cellDivt` is undefined');
    expect(body.text).toContain('`cellDiv`');
    expect(body.text).toContain(
      'replaceInFile({ path: "index.html", find: "cellDivt", replace: "cellDiv", occurrence: "all" })',
    );
  });

  it('explains DOM lifecycle fixes for seed task render failures', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport(
      [
        {
          name: 'seed-tasks-render',
          why: 'expected at least 3 rendered task cards/items, found 0',
        },
      ],
      ['no-page-errors'],
    );

    await postRuntimeFeedback(
      ctx,
      'index.html',
      report,
      '<script type="module" src="./src/app.js"></script>',
    );

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('seed-task render failures');
    expect(body.text).toContain('first render happen immediately');
    expect(body.text).toContain('Do not only register it inside a later `window.load` handler');
    expect(body.text).toContain('Call the render/init function directly');
  });

  it('forces tic-tac-toe DOM runtime failures into a literal nine-cell rewrite', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport(
      [
        { name: 'nine-cells-rendered', why: 'only 1 cell-like elements (need >= 9)' },
        { name: 'click-marks-a-cell', why: 'no clickable cell found to drive' },
      ],
      ['no-page-errors'],
    );

    await postRuntimeFeedback(ctx, 'tic-tac-toe-game/workspace/index.html', report);

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('TICTACTOE_FULL_REWRITE');
    expect(body.text).toContain('Your next tool call MUST be `writeFile`');
    expect(body.text).toContain('data-cell="0"');
    expect(body.text).toContain('data-cell="8"');
    expect(body.text).toContain('Do not rely on JavaScript to create the cells');
    expect(body.text).toContain('do not call `validate`, `readFile`, `ask_user_question`');
    expect(body.text).not.toContain('Call `validate');
  });

  it('emits an exact empty-grid repair hint for tic-tac-toe runtime failures', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport([
      { name: 'nine-cells-rendered', why: 'only 1 cell-like elements (need >= 9)' },
      { name: 'click-marks-a-cell', why: 'no clickable cell found to drive' },
    ]);
    const fileContent = [
      '<div id="status">Player X turn</div>',
      '<div class="grid" id="grid"></div>',
      '<script>',
      'const cells = document.querySelectorAll(".cell");',
      '</script>',
    ].join('\n');

    await postRuntimeFeedback(ctx, 'index.html', report, fileContent);

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('empty grid container');
    expect(body.text).toContain('<button class=\\"cell\\" data-cell=\\"0\\"');
    expect(body.text).toContain(
      'replaceInFile({ path: "index.html", find: "<div class=\\"grid\\" id=\\"grid\\"></div>"',
    );
    expect(body.text).toContain('Do not append another unrelated script fragment');
  });

  it('dedups identical failure sets when file content is unchanged (same content = same poll cycle)', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport([
      { name: 'keyboard-listener-installed', why: 'DOM signature unchanged' },
    ]);
    const fileContent = '<html><script>/* same content all three polls */</script></html>';

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report, fileContent);
    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report, fileContent);
    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report, fileContent);

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
  });

  it('RE-NUDGES when the team rewrites the file but the same assertion still fails (the sonnet tankcombat case)', async () => {
    // Pre-fix behaviour: dedup hashed (filePath, failed-names) only,
    // so a 50-rewrite loop got exactly one nudge and then silence.
    // Post-fix: content fingerprint participates in the hash, so each
    // distinct rewrite that still fails the same assertion triggers
    // an escalating re-nudge.
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport([
      { name: 'keyboard-listener-installed', why: 'DOM signature unchanged' },
    ]);

    await postRuntimeFeedback(ctx, 'index.html', report, '<html>v1</html>');
    await postRuntimeFeedback(ctx, 'index.html', report, '<html>v2</html>');
    await postRuntimeFeedback(ctx, 'index.html', report, '<html>v3</html>');

    expect(client.messageGezel).toHaveBeenCalledTimes(3);
    const messages = client.messageGezel.mock.calls.map((c) => c[1].text);
    // First nudge is neutral; later nudges escalate.
    expect(messages[0]).toMatch(/runtime check\]/);
    expect(messages[1]).toMatch(/attempt 2/);
    expect(messages[2]).toMatch(/attempt 3/);
  });

  it('escalates to "STOP REWRITING" after attempt 3 (loop-breaker for stubborn models)', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'b', lastActivityAt: '2026-05-20T15:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const report = makeReport([{ name: 'x', why: 'y' }]);

    for (let i = 1; i <= 5; i++) {
      await postRuntimeFeedback(ctx, 'index.html', report, `<html>v${i}</html>`);
    }
    expect(client.messageGezel).toHaveBeenCalledTimes(5);
    const last = client.messageGezel.mock.calls[4]![1].text;
    expect(last).toMatch(/STOP REWRITING/);
    expect(last).toMatch(/attempt 5/);
  });

  it('fires again when the failed assertion set changes (model wrote new code with different defects)', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const first = makeReport([{ name: 'keyboard-listener-installed', why: 'no listener' }]);
    const second = makeReport([
      { name: 'keyboard-listener-installed', why: 'no listener' },
      { name: 'canvas-renders', why: 'pixel sum 0' },
    ]);

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', first);
    await postRuntimeFeedback(ctx, 'workspace/x/index.html', second);

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });

  it('treats failures in different order as the same set (sort before hashing)', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const a = makeReport([
      { name: 'a', why: 'why-a' },
      { name: 'b', why: 'why-b' },
    ]);
    const b = makeReport([
      { name: 'b', why: 'why-b' },
      { name: 'a', why: 'why-a' },
    ]);

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', a);
    await postRuntimeFeedback(ctx, 'workspace/x/index.html', b);

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
  });

  it('different file paths are tracked independently', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const report = makeReport([{ name: 'x', why: 'y' }]);

    await postRuntimeFeedback(ctx, 'a/index.html', report);
    await postRuntimeFeedback(ctx, 'b/index.html', report);

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });

  it('no-op when report.ran is false (Playwright bootstrap failure)', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const report: RuntimeReport = {
      ran: false,
      passed: [],
      failed: [{ name: 'something', why: 'whatever' }],
      pageErrors: [],
      bootstrapError: 'chromium missing',
    };

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report);

    expect(client.messageGezel).not.toHaveBeenCalled();
  });

  it('no-op when no assertions failed', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const report = makeReport([], ['everything-passed']);

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report);

    expect(client.messageGezel).not.toHaveBeenCalled();
  });

  it('no-op when only the meester has an active session (no Builder/Voorman to nudge)', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-meester', gezelId: 'meester-1', lastActivityAt: '2026-05-20T15:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport([{ name: 'x', why: 'y' }]);

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report);

    expect(client.messageGezel).not.toHaveBeenCalled();
  });

  it('skips archived sessions', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 's-old',
          gezelId: 'builder-1',
          lastActivityAt: '2026-05-20T15:00:00Z',
          archived: true,
        },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport([{ name: 'x', why: 'y' }]);

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report);

    expect(client.messageGezel).not.toHaveBeenCalled();
  });

  it('picks the most recently active non-meester gezel when multiple exist', async () => {
    const client = makeClient({
      sessions: [
        { id: 's-old', gezelId: 'voorman-1', lastActivityAt: '2026-05-20T14:00:00Z' },
        { id: 's-new', gezelId: 'builder-2', lastActivityAt: '2026-05-20T15:00:00Z' },
        { id: 's-meester', gezelId: 'meester-1', lastActivityAt: '2026-05-20T15:30:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport([{ name: 'x', why: 'y' }]);

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report);

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel.mock.calls[0]![0]).toBe('builder-2');
  });

  it('routes project runtime feedback to the failing file last writer before a newer specialist', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 'sess-builder',
          gezelId: 'builder-1',
          projectId: 'site',
          lastActivityAt: '2026-05-20T14:00:00Z',
        },
        {
          id: 'sess-image',
          gezelId: 'image-generator-1',
          projectId: 'site',
          lastActivityAt: '2026-05-20T15:00:00Z',
        },
      ],
      workspaceWrites: [
        {
          at: '2026-05-20T14:00:00Z',
          op: 'write',
          path: 'index.html',
          gezelId: 'builder-1',
          sessionId: 'sess-builder',
        },
      ],
    });
    const ctx = makeCtx(client);
    const report = makeReport([{ name: 'all-rendered-local-images-resolve', why: 'missing' }]);

    await postRuntimeFeedback(ctx, 'index.html', report, '<html></html>', {
      projectId: 'site',
    });

    expect(client.listWorkspaceWrites).toHaveBeenCalledWith('site', 100);
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel.mock.calls[0]![0]).toBe('builder-1');
    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('do not invent more filenames');
    expect(body.text).toContain('use CSS placeholders for decorative product cards');
  });

  it('swallows messageGezel errors so a downstream failure does not crash the success-check loop', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' }],
      messageGezelImpl: () => Promise.reject(new Error('daemon unreachable')),
    });
    const ctx = makeCtx(client);
    const report = makeReport([{ name: 'x', why: 'y' }]);

    await expect(
      postRuntimeFeedback(ctx, 'workspace/x/index.html', report),
    ).resolves.toBeUndefined();
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    // Failed post should NOT mark the hash as posted — next poll should retry.
    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report);
    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });

  it('per-context dedup state is independent across trials (different ctx objects)', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' }],
    });
    const ctx1 = makeCtx(client);
    const ctx2 = makeCtx(client);
    const report = makeReport([{ name: 'x', why: 'y' }]);

    await postRuntimeFeedback(ctx1, 'workspace/x/index.html', report);
    await postRuntimeFeedback(ctx2, 'workspace/x/index.html', report);

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });

  it('_resetNudgeMemoryForTests clears the per-context dedup state', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-20T15:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const report = makeReport([{ name: 'x', why: 'y' }]);

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report);
    expect(client.messageGezel).toHaveBeenCalledTimes(1);

    _resetNudgeMemoryForTests(ctx);

    await postRuntimeFeedback(ctx, 'workspace/x/index.html', report);
    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });
});
