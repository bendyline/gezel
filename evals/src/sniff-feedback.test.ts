import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import {
  _resetSniffNudgeMemoryForTests,
  postMissingDeliverableFeedback,
  postSniffFeedback,
  structuralOrderRepairLine,
} from './sniff-feedback.ts';
import type { SniffResult } from './success-check.ts';
import type { EvalContext, EvalTerminalFailure } from './types.ts';

interface MockedClient {
  messageGezel: ReturnType<typeof vi.fn>;
  sendChatMessage: ReturnType<typeof vi.fn>;
  listChatSessions: ReturnType<typeof vi.fn>;
  listGezels: ReturnType<typeof vi.fn>;
  ensureGezel: ReturnType<typeof vi.fn>;
  listInflightTurns: ReturnType<typeof vi.fn>;
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
    gezels?: Array<{ id: string; role?: string | null; roleBasedName?: string | null }>;
    inflight?: Array<{
      sessionId?: string;
      gezelId: string;
      projectId?: string;
      userText?: string;
      startedAt?: number;
      elapsedMs?: number;
    }>;
    messageGezelImpl?: () => Promise<unknown>;
  } = {},
): MockedClient {
  const sessions = opts.sessions ?? [];
  const gezels = opts.gezels ?? [];
  const inflight = opts.inflight ?? [];
  return {
    messageGezel: vi
      .fn()
      .mockImplementation(opts.messageGezelImpl ?? (() => Promise.resolve({ accepted: true }))),
    sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
    listChatSessions: vi.fn().mockResolvedValue({ sessions }),
    listGezels: vi.fn().mockResolvedValue({ gezels }),
    listInflightTurns: vi.fn().mockImplementation((query = {}) =>
      Promise.resolve({
        inflight: inflight.filter((turn) => {
          if (query.gezelId && turn.gezelId !== query.gezelId) return false;
          if (query.projectId && turn.projectId !== query.projectId) return false;
          return true;
        }),
      }),
    ),
    ensureGezel: vi.fn().mockResolvedValue({
      gezelId: 'ensured-dev-1',
      name: 'Ensured Dev',
      role: 'Developer',
      action: 'created-bespoke',
    }),
  };
}

function makeCtx(client: MockedClient, meesterId = 'meester-1'): EvalContext {
  return {
    client: client as unknown as GezelClient,
    meesterId,
    log: () => {},
    logChanged: () => {},
  };
}

describe('structuralOrderRepairLine', () => {
  it('recommends a bounded rewrite for execution-order failures', () => {
    const line = structuralOrderRepairLine(
      'runlog.md',
      'STEP 1 must be recorded under its heading in execution order',
    );

    expect(line).toContain('structural-order failure');
    expect(line).toContain('one bounded `write_file` rewrite');
    expect(line).toContain('Do not append');
  });

  it('does not rewrite ordinary missing-content guidance', () => {
    expect(structuralOrderRepairLine('report.md', 'summary section is missing')).toBeUndefined();
  });
});

describe('postSniffFeedback', () => {
  it('posts a from-meester message naming the missing signals (petshop working-image case)', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-voorman', gezelId: 'voorman-1', lastActivityAt: '2026-05-21T05:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['pet-vocab', 'store-vocab', 'structured-page', 'image-asset'],
      score: 4,
      missingRequiredSignals: ['working-image'],
    };

    await postSniffFeedback(ctx, 'workspace/pet-shop/index.html', sniff);

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('voorman-1');
    expect(body.fromGezelId).toBe('meester-1');
    expect(body.text).toContain('working-image');
    expect(body.text).toContain('workspace/pet-shop/index.html');
    expect(body.text).toContain('pet-vocab'); // also names what's passing
    expect(body.text).toContain('working-image'); // names what's missing
    expect(body.text).toContain('<img>'); // generic hint that working-image needs a real image element
    expect(body.text).toContain('<img src="assets/logo.png" alt="Pet shop logo">');
    expect(body.text).toContain('Placeholder');
    expect(body.text).toContain('next message must start with that tool call');
    expect(body.text).toContain('ensure_gezel');
    expect(body.text).toContain('message_gezel');
    expect(body.text).toContain('do not queue a message, call `ask_specialist`');
    expect(body.text).toContain('do not queue a message');
  });

  it('defers sniff feedback while the selected target is already mid-turn', async () => {
    const logs: string[] = [];
    const client = makeClient({
      sessions: [
        {
          id: 'sess-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
      inflight: [
        {
          sessionId: 'sess-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          elapsedMs: 90_000,
        },
      ],
    });
    const ctx = {
      ...makeCtx(client),
      log: (line: string) => logs.push(line),
    };
    const sniff: SniffResult = {
      ok: false,
      signals: ['index-present'],
      score: 1,
      missingRequiredSignals: ['priority-filter'],
      failReason: 'Priority filter is missing.',
    };

    await postSniffFeedback(ctx, 'index.html', sniff, { projectId: 'launch-board' });

    expect(client.messageGezel).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('deferred nudge for index.html');
  });

  it('allows sniff feedback when the selected target has been mid-turn for several minutes', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 'sess-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
      inflight: [
        {
          sessionId: 'sess-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          elapsedMs: 5 * 60_000,
        },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['index-present'],
      score: 1,
      missingRequiredSignals: ['priority-filter'],
      failReason: 'Priority filter is missing.',
    };

    await postSniffFeedback(ctx, 'index.html', sniff, { projectId: 'launch-board' });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
  });

  it('honors a custom sniff-feedback inflight defer window', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 'sess-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
      inflight: [
        {
          sessionId: 'sess-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          elapsedMs: 90_000,
        },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['index-present'],
      score: 1,
      missingRequiredSignals: ['due-date-input'],
      failReason: 'Due date input is missing.',
    };

    await postSniffFeedback(ctx, 'index.html', sniff, {
      projectId: 'launch-board',
      inflightDeferMs: 60_000,
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
  });

  it('delivers explicit-project sniff feedback even when the target session is in Default', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 's-default-dev',
          gezelId: 'dev-1',
          projectId: 'default',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
      gezels: [{ id: 'dev-1', role: 'Developer' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['types-exported'],
      score: 1,
      missingRequiredSignals: ['producer-file'],
      failReason: 'src/producer.ts is missing',
    };

    await postSniffFeedback(ctx, 'src/producer.ts', sniff, {
      projectId: 'typescript-event-pipeline',
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('dev-1');
    expect(body.projectId).toBe('typescript-event-pipeline');
    expect(body.expectedDeliverable).toEqual({ kind: 'file', filePath: 'src/producer.ts' });
  });

  it('uses concrete image src hints for petshop working-image repairs', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-voorman', gezelId: 'voorman-1', lastActivityAt: '2026-06-02T05:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['pet-vocab', 'store-vocab', 'structured-page', 'image-asset'],
      score: 4,
      missingRequiredSignals: ['working-image'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff, {
      availableImageSrcs: ['assets/generated/image-1213420199.png'],
      brokenImageSrcs: [
        'assets/logo.png',
        'assets/pets/dog_placeholder.jpg',
        'assets/pets/cat_placeholder.jpg',
      ],
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('assets/generated/image-1213420199.png');
    expect(body.text).toContain(
      '<img src="assets/generated/image-1213420199.png" alt="Pet shop logo">',
    );
    expect(body.text).toContain('EXACT PATCH');
    expect(body.text).toContain('Broken image src values currently in `index.html`');
    expect(body.text).toContain('Replace those broken local image src values');
    expect(body.text).toContain('assets/logo.png');
    expect(body.text).toContain('assets/pets/dog_placeholder.jpg');
    expect(body.text).toContain('Do not call `make_dir`');
    expect(body.text).toContain(
      'replace_in_file({ path: "index.html", find: "assets/logo.png", replace: "assets/generated/image-1213420199.png" })',
    );
  });

  it('can also copy sniff feedback to the meester for coordination-sensitive repairs', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 'sess-builder',
          gezelId: 'builder-1',
          projectId: 'pet-shop-website',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['pet-vocab', 'store-vocab', 'structured-page', 'image-asset'],
      score: 4,
      missingRequiredSignals: ['working-image'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff, {
      availableImageSrcs: ['assets/generated/logo.png'],
      brokenImageSrcs: ['assets/logo.png'],
      projectId: 'pet-shop-website',
      notifyMeester: true,
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel.mock.calls[0]![0]).toBe('builder-1');
    expect(client.sendChatMessage).toHaveBeenCalledTimes(1);
    const [meesterId, body] = client.sendChatMessage.mock.calls[0]!;
    expect(meesterId).toBe('meester-1');
    expect(body.projectId).toBe('pet-shop-website');
    expect(body.message).toContain('scenario coordinator copy');
    expect(body.message).toContain('assets/generated/logo.png');
    expect(body.message).toContain('patch the workspace file yourself');
  });

  it('tells the model to create an asset when petshop has no image file yet', async () => {
    const client = makeClient({
      sessions: [{ id: 'sess-dev', gezelId: 'dev-1', lastActivityAt: '2026-06-02T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['pet-vocab', 'store-vocab', 'structured-page'],
      score: 3,
      missingRequiredSignals: ['working-image', 'image-asset'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff, {
      expectedDeliverable: null,
      notifyMeester: true,
      projectId: 'pet-shop-website',
      assetHandoff: {
        jobTitle: 'Image generator',
        filePath: 'assets/logo.png',
        message:
          'Generate the missing pet shop logo with generate_image({ saveAs: "assets/logo.png" }).',
      },
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.projectId).toBe('pet-shop-website');
    expect(body.expectedDeliverable).toBeUndefined();
    expect(body.text).toContain('No usable raster image asset exists');
    expect(body.text).toContain('generate_image');
    expect(body.text).toContain('assets/logo.png');
    expect(body.text).toContain('Do not hand-write an SVG fallback');
    expect(body.text).toContain(
      'expectedDeliverable: { kind: "file", filePath: "assets/logo.png" }',
    );
    expect(body.text).toContain('`make_dir` alone is not enough');
    expect(body.text).not.toContain('If `assets/logo.png` exists beside this page');

    expect(client.sendChatMessage).toHaveBeenCalledTimes(1);
    const coordinatorBody = client.sendChatMessage.mock.calls[0]![1];
    expect(coordinatorBody.projectId).toBe('pet-shop-website');
    expect(coordinatorBody.message).toContain('non-write_file tool');
    expect(coordinatorBody.message).toContain('assets/logo.png');
    expect(coordinatorBody.message).not.toContain(
      'expectedDeliverable: { kind: "file", filePath: "index.html" }',
    );

    expect(client.ensureGezel).toHaveBeenCalledWith({ jobTitle: 'Image generator' });
    const [assetTarget, assetBody] = client.messageGezel.mock.calls[1]!;
    expect(assetTarget).toBe('ensured-dev-1');
    expect(assetBody.projectId).toBe('pet-shop-website');
    expect(assetBody.expectedDeliverable).toEqual({
      kind: 'file',
      filePath: 'assets/logo.png',
    });
    expect(assetBody.text).toContain('generate_image');
    expect(assetBody.text).toContain('assets/logo.png');
  });

  it('posts again when a concrete image src appears for the same sniff failure', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-06-02T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['pet-vocab', 'store-vocab', 'structured-page', 'image-asset'],
      score: 4,
      missingRequiredSignals: ['working-image'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff);
    await postSniffFeedback(ctx, 'index.html', sniff, {
      availableImageSrcs: ['assets/generated/logo.png'],
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
    expect(client.messageGezel.mock.calls[1]![1].text).toContain('assets/generated/logo.png');
  });

  it('posts again when concrete broken image srcs change for the same image asset', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-06-02T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['pet-vocab', 'store-vocab', 'structured-page', 'image-asset'],
      score: 4,
      missingRequiredSignals: ['working-image'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff, {
      availableImageSrcs: ['assets/generated/logo.png'],
      brokenImageSrcs: ['assets/logo.png'],
    });
    await postSniffFeedback(ctx, 'index.html', sniff, {
      availableImageSrcs: ['assets/generated/logo.png'],
      brokenImageSrcs: ['assets/pets/dog_placeholder.jpg'],
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
    expect(client.messageGezel.mock.calls[1]![1].text).toContain('assets/pets/dog_placeholder.jpg');
  });

  it('includes the failReason verbatim when present (tictactoe JS parse case)', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-05-21T05:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['name', 'grid', 'click', 'win-detect'],
      score: 4,
      failReason: 'inline JS does not parse: Unexpected token } at line 47',
      missingRequiredSignals: ['js-parses', 'js-size-ok'],
    };

    await postSniffFeedback(ctx, 'workspace/x/index.html', sniff);

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('inline JS does not parse');
    expect(body.text).toContain('Unexpected token } at line 47');
    expect(body.text).toContain('js-parses');
  });

  it('gives a source-file rewrite directive for html-size-ok misses', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-06-04T17:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: [
        'tank-vocab',
        'render-surface',
        'keyboard-input',
        'combat',
        'game-loop',
        'gameplay',
        'js-parses',
        'js-size-ok',
      ],
      score: 8,
      failReason: 'Your tank-combat game is functional but minimal (HTML is 2403 bytes).',
      missingRequiredSignals: ['html-size-ok'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff);

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('html-size-ok');
    expect(body.text).toContain('Replace `index.html` with one complete');
    expect(body.text).toContain('target roughly 5-7 KB');
    expect(body.text).toContain('Do not pad with comments');
    expect(body.text).toContain('Do not use `write_artifact`');
    expect(body.text).toContain('write_file');
  });

  it('gives tic-tac-toe structure guidance when board signals are missing', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-06-04T19:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['js-parses', 'js-size-ok'],
      score: 2,
      missingRequiredSignals: ['name', 'grid', 'click', 'win-detect'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff);

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('TICTACTOE_FULL_REWRITE');
    expect(body.text).toContain('Your next tool call MUST be `write_file`');
    expect(body.text).toContain('tic-tac-toe page still lacks');
    expect(body.text).toContain('class="cell"');
    expect(body.text).toContain('data-cell');
    expect(body.text).toContain('winningLines');
    expect(body.text).toContain('addEventListener("click", handleClick)');
    expect(body.text).toContain('Reset / Play Again');
    expect(body.text).toContain('Use this compact structure');
    expect(body.text).toContain('<!doctype html><html>');
    expect(body.text).toContain('data-cell="8"');
    expect(body.text).not.toContain('target roughly 5-7 KB');
  });

  it('uses the full tic-tac-toe rewrite when only the inline script size is too small', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-06-05T12:20:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['name', 'grid', 'click', 'win-detect', 'js-parses'],
      score: 5,
      failReason:
        'Your tic-tac-toe is functional but minimal (inline JS is 597 bytes). Add at least 2 features.',
      missingRequiredSignals: ['js-size-ok'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff);

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('TICTACTOE_FULL_REWRITE');
    expect(body.text).toContain('Your next tool call MUST be `write_file`');
    expect(body.text).toContain('score counters for X/O/draws');
    expect(body.text).toContain('about 1-2 KB');
    expect(body.text).toContain('Use this compact structure');
    expect(body.text).toContain('<script>var cells=Array.from');
    expect(body.text).toContain('Do not pad with comments');
    expect(body.text).not.toContain('patch the deliverable');
  });

  it('tells the target to re-read and re-emit cleanly for source parse failures', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-05-21T05:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['tank-vocab', 'render-surface', 'keyboard-input'],
      score: 3,
      failReason: "inline JS does not parse (Identifier 'tanks' has already been declared)",
      missingRequiredSignals: ['js-parses'],
    };

    await postSniffFeedback(ctx, 'workspace/index.html', sniff, {
      sourceText: '<script>const tanks = [];\nconst tanks = [];</script>',
    });

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('parse failure is a duplicate declaration');
    expect(body.text).toContain('remove every duplicated block');
    expect(body.text).toContain('one clean complete file using `write_file`');
    expect(body.text).toContain('Keep exactly one declaration');
    expect(body.text).toContain(
      'Do not use `append_to_file`, `insert_at_marker`, or `replace_lines`',
    );
    expect(body.text).toContain("Identifier 'tanks' has already been declared");
    expect(body.text).not.toContain('patch the deliverable with the smallest syntax fix first');
  });

  it('allows append recovery for truncated inline script failures', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-06-04T20:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['name', 'grid', 'click', 'win-detect'],
      score: 4,
      failReason:
        'inline <script> opened 1x but only closed 0x — the write_file body was truncated mid-script (no </script> ever arrived).',
      missingRequiredSignals: ['js-parses', 'js-size-ok'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff);

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('truncated inline `<script>` block');
    expect(body.text).toContain('append_to_file');
    expect(body.text).toContain('</script></body></html>');
    expect(body.text).toContain('must NOT start a new `<script>`');
    expect(body.text).not.toContain('Do not use `append_to_file`');
  });

  it('treats Unexpected end of input as a truncated script repair', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-06-04T20:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['name', 'click'],
      score: 2,
      failReason: 'inline JS does not parse (Unexpected end of input)',
      missingRequiredSignals: ['grid', 'win-detect', 'js-parses'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff);

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('truncated inline `<script>` block');
    expect(body.text).toContain('append_to_file');
    expect(body.text).not.toContain('Read `index.html`, then use `replace_in_file`');
  });

  it('includes exact replace_in_file candidates for common parse-corrupted HTML', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-06-04T05:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['tank-vocab', 'render-surface', 'keyboard-input', 'combat', 'game-loop'],
      score: 5,
      failReason: 'inline JS does not parse (Invalid or unexpected token)',
      missingRequiredSignals: ['js-parses'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff, {
      sourceText: [
        "<style>body{background: #353';}</style>",
        '<script>',
        'function draw(){ requestAnimationFrame(draw)); }',
        '</script>',
      ].join('\n'),
    });

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain(
      `replace_in_file({ path: "index.html", find: "background: #353';", replace: "background: #353;" })`,
    );
    expect(body.text).toContain(
      'replace_in_file({ path: "index.html", find: "requestAnimationFrame(draw));", replace: "requestAnimationFrame(draw);" })',
    );
    expect(body.text).toContain('If one matches the file you read, call it before a full rewrite');
  });

  it('includes exact replace_in_file candidates for tic-tac-toe bracket typos', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-06-04T05:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['name', 'grid', 'click', 'win-detect'],
      score: 4,
      failReason: "inline JS does not parse (Unexpected token ']')",
      missingRequiredSignals: ['js-parses'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff, {
      sourceText:
        'if (board[a] !== "" && board[a] === board[b]] && board[b] === board[c]]) { roundWon = true; }',
    });

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain(
      'replace_in_file({ path: "index.html", find: "board[b]]", replace: "board[b]", occurrence: "all" })',
    );
    expect(body.text).toContain(
      'replace_in_file({ path: "index.html", find: "board[c]]", replace: "board[c]", occurrence: "all" })',
    );
  });

  it('includes exact replace_in_file candidates for combo-index bracket typos', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-06-04T05:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['name', 'grid', 'click', 'win-detect', 'js-size-ok'],
      score: 5,
      failReason: "inline JS does not parse (Unexpected token ']')",
      missingRequiredSignals: ['js-parses'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff, {
      sourceText:
        'if (board[combo[0]] && board[combo[0]]] === board[combo[1]]] && board[combo[0]]] === board[combo[2]]]) { status.innerText = `Player ${board[combo[0]]]} Wins!`; }',
    });

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain(
      'replace_in_file({ path: "index.html", find: "board[combo[0]]]", replace: "board[combo[0]]", occurrence: "all" })',
    );
    expect(body.text).toContain(
      'replace_in_file({ path: "index.html", find: "board[combo[1]]]", replace: "board[combo[1]]", occurrence: "all" })',
    );
    expect(body.text).toContain(
      'replace_in_file({ path: "index.html", find: "board[combo[2]]]", replace: "board[combo[2]]", occurrence: "all" })',
    );
  });

  it('includes exact replace_in_file candidates for condition-index bracket typos', async () => {
    const client = makeClient({
      sessions: [
        { id: 'sess-builder', gezelId: 'builder-1', lastActivityAt: '2026-06-04T05:00:00Z' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['name', 'grid', 'click', 'win-detect', 'js-size-ok'],
      score: 5,
      failReason: "inline JS does not parse (Unexpected token ']')",
      missingRequiredSignals: ['js-parses'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff, {
      sourceText:
        'if (board[condition[0]] !== "" && board[condition[0]]] === board[condition[1]]] && board[condition[0]]] === board[condition[2]]]) { status.innerText = `Player ${board[condition[0]]} Wins!`; }',
    });

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain(
      'replace_in_file({ path: "index.html", find: "board[condition[0]]]", replace: "board[condition[0]]", occurrence: "all" })',
    );
    expect(body.text).toContain(
      'replace_in_file({ path: "index.html", find: "board[condition[1]]]", replace: "board[condition[1]]", occurrence: "all" })',
    );
    expect(body.text).toContain(
      'replace_in_file({ path: "index.html", find: "board[condition[2]]]", replace: "board[condition[2]]", occurrence: "all" })',
    );
  });

  it('uses a scenario-specific repair directive for non-parse sniff failures', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'writer-1', lastActivityAt: '2026-06-03T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['section-architecture'],
      score: 1,
      failReason: 'review is only 2350 bytes (need >= 5000)',
      missingRequiredSignals: ['size-ok'],
    };

    await postSniffFeedback(ctx, 'review.md', sniff, {
      repairDirective: 'Rewrite workspace review.md with real source citations.',
    });

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('Rewrite workspace review.md with real source citations.');
    expect(body.text).not.toContain('Re-read the scenario prompt + mission objectives');
  });

  it('tells generic file sniff repairs to write instead of replying in prose', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'writer-1', lastActivityAt: '2026-06-03T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: [],
      score: 16,
      failReason: 'press-release.md has unsupported claim wording (matched "efficiency")',
      missingRequiredSignals: ['remove unsupported claim'],
    };

    await postSniffFeedback(ctx, 'press-release.md', sniff);

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain(
      'Your next assistant action should be a file-writing tool call for `press-release.md`',
    );
    expect(body.text).toContain('not a prose summary saying it is fixed');
  });

  it('prefers a developer over a copywriter for workspace markdown repairs', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 's-writer',
          gezelId: 'writer-1',
          projectId: 'driftwater',
          lastActivityAt: '2026-06-03T05:10:00Z',
        },
        {
          id: 's-dev',
          gezelId: 'dev-1',
          projectId: 'driftwater',
          lastActivityAt: '2026-06-03T05:00:00Z',
        },
      ],
      gezels: [
        { id: 'writer-1', role: 'Copywriter' },
        { id: 'dev-1', role: 'Developer' },
      ],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['word-band'],
      score: 1,
      failReason: 'missing required disclosure',
    };

    await postSniffFeedback(ctx, 'customer-notice.md', sniff, {
      projectId: 'driftwater',
    });

    const [target] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('dev-1');
  });

  it('keeps scenario-specific repair directives on parse failures', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'dev-1', lastActivityAt: '2026-06-03T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['title-app-name', 'size-4kb'],
      score: 2,
      failReason: 'inline JS does not parse (Unexpected end of input)',
      missingRequiredSignals: ['localstorage-persistence', 'js-parses'],
    };

    await postSniffFeedback(ctx, 'notes.html', sniff, {
      repairDirective: 'Restore localStorage.getItem/localStorage.setItem in one parseable script.',
    });

    const body = client.messageGezel.mock.calls[0]![1];
    expect(body.text).toContain('truncated inline `<script>` block');
    expect(body.text).toContain(
      'Restore localStorage.getItem/localStorage.setItem in one parseable script.',
    );
  });

  it('posts again when a scenario-specific repair directive changes', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'writer-1', lastActivityAt: '2026-06-03T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['section-architecture'],
      score: 1,
      failReason: 'review is only 2350 bytes (need >= 5000)',
      missingRequiredSignals: ['size-ok'],
    };

    await postSniffFeedback(ctx, 'review.md', sniff, {
      repairDirective: 'First directive.',
    });
    await postSniffFeedback(ctx, 'review.md', sniff, {
      repairDirective: 'Second directive.',
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
    expect(client.messageGezel.mock.calls[1]![1].text).toContain('Second directive.');
  });

  it('posts again when a scenario-specific dedupe token changes', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'dev-1', lastActivityAt: '2026-06-03T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['yaml-parses'],
      score: 1,
      failReason: 'all-paths-present: missing /books/{id}#DELETE',
      missingRequiredSignals: ['all-paths-present'],
    };

    await postSniffFeedback(ctx, 'bookstore-openapi', sniff, { dedupeToken: 'rev-1' });
    await postSniffFeedback(ctx, 'bookstore-openapi', sniff, { dedupeToken: 'rev-1' });
    await postSniffFeedback(ctx, 'bookstore-openapi', sniff, { dedupeToken: 'rev-2' });

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });

  it('dedups non-parse sniff failures across partial source revisions', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'dev-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['yaml-parses', 'openapi-3.1', 'schemas-named'],
      score: 3,
      failReason: 'all-paths-present: missing /books/{id}#DELETE',
      missingRequiredSignals: ['all-paths-present', 'auth-on-mutations'],
    };

    await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
      sourceText: 'paths:\n  /books:\n    get: {}\n',
    });
    await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
      sourceText: 'paths:\n  /books:\n    get: {}\n  /books/{id}:\n    get: {}\n',
    });

    // New contract (B1 ladder): a DELIVERED nudge followed by a revision
    // that still fails identically gets exactly one escalated follow-up
    // (stage 1, targeted edit) — bounded escalation, not per-revision
    // spam, and no longer the dedup-to-silence that starved
    // one-golden-miss repair loops.
    expect(client.messageGezel).toHaveBeenCalledTimes(2);
    expect(client.messageGezel.mock.calls[1]![1].text).toContain('REPEAT MISS — attempt 2');
    // An identical re-poll of the SAME revision stays deduped.
    await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
      sourceText: 'paths:\n  /books:\n    get: {}\n  /books/{id}:\n    get: {}\n',
    });
    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });

  it('dedups parse sniff failures across partial source revisions', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['render-surface'],
      score: 1,
      failReason: 'inline JS does not parse (Invalid or unexpected token)',
      missingRequiredSignals: ['js-parses'],
    };

    await postSniffFeedback(ctx, 'index.html', sniff, {
      sourceText: '<script>requestAnimationFrame(draw));</script>',
    });
    await postSniffFeedback(ctx, 'index.html', sniff, {
      sourceText: '<script>requestAnimationFrame(gameLoop));</script>',
    });

    // First send carries the exact parse-repair hint; the revised-but-
    // still-failing second revision gets the stage-1 escalation (which
    // preserves the parse-repair ladder underneath the REPEAT MISS line).
    expect(client.messageGezel).toHaveBeenCalledTimes(2);
    expect(client.messageGezel.mock.calls[0]![1].text).toContain(
      'replace_in_file({ path: "index.html", find: "requestAnimationFrame(draw));", replace: "requestAnimationFrame(draw);" })',
    );
    expect(client.messageGezel.mock.calls[1]![1].text).toContain('REPEAT MISS — attempt 2');
  });

  it('dedups identical sniff failures (same path, same missing set, same failReason)', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-21T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: ['a'],
      score: 1,
      missingRequiredSignals: ['b', 'c'],
    };

    await postSniffFeedback(ctx, 'workspace/x.html', sniff);
    await postSniffFeedback(ctx, 'workspace/x.html', sniff);
    await postSniffFeedback(ctx, 'workspace/x.html', sniff);

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
  });

  it('fires again when the missing-signals set changes (model patched something)', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-21T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const first: SniffResult = {
      ok: false,
      signals: [],
      score: 0,
      missingRequiredSignals: ['a', 'b', 'c'],
    };
    const second: SniffResult = {
      ok: false,
      signals: ['a'],
      score: 1,
      missingRequiredSignals: ['b', 'c'],
    };

    await postSniffFeedback(ctx, 'workspace/x.html', first);
    await postSniffFeedback(ctx, 'workspace/x.html', second);

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });

  it('fires again when the failReason changes (different specific error)', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-21T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const first: SniffResult = {
      ok: false,
      signals: [],
      score: 0,
      failReason: 'no inline <script>',
    };
    const second: SniffResult = {
      ok: false,
      signals: [],
      score: 0,
      failReason: 'inline JS too small (< 4KB)',
    };

    await postSniffFeedback(ctx, 'workspace/x.html', first);
    await postSniffFeedback(ctx, 'workspace/x.html', second);

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });

  it("no-op when sniff is ok (success path is the caller's job)", async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-21T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = { ok: true, signals: ['everything'], score: 1 };

    await postSniffFeedback(ctx, 'workspace/x.html', sniff);

    expect(client.messageGezel).not.toHaveBeenCalled();
  });

  it('no-op when ok is false but neither missingRequiredSignals nor failReason is set', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-21T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = { ok: false, signals: [], score: 0 };

    await postSniffFeedback(ctx, 'workspace/x.html', sniff);

    expect(client.messageGezel).not.toHaveBeenCalled();
  });

  it('no-op when only the meester has an active session', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'meester-1', lastActivityAt: '2026-05-21T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = { ok: false, signals: [], score: 0, missingRequiredSignals: ['x'] };

    await postSniffFeedback(ctx, 'workspace/x.html', sniff);

    expect(client.messageGezel).not.toHaveBeenCalled();
  });

  it('swallows messageGezel errors and retries on the next call', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-21T05:00:00Z' }],
      messageGezelImpl: () => Promise.reject(new Error('daemon unreachable')),
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: [],
      score: 0,
      missingRequiredSignals: ['x'],
    };

    await expect(postSniffFeedback(ctx, 'workspace/x.html', sniff)).resolves.toEqual({
      status: 'send-failed',
    });
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    await postSniffFeedback(ctx, 'workspace/x.html', sniff);
    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });

  it('_resetSniffNudgeMemoryForTests clears the per-context dedup state', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-05-21T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff: SniffResult = {
      ok: false,
      signals: [],
      score: 0,
      missingRequiredSignals: ['x'],
    };

    await postSniffFeedback(ctx, 'workspace/x.html', sniff);
    expect(client.messageGezel).toHaveBeenCalledTimes(1);

    _resetSniffNudgeMemoryForTests(ctx);

    await postSniffFeedback(ctx, 'workspace/x.html', sniff);
    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });
});

describe('postMissingDeliverableFeedback', () => {
  it('nudges the active specialist to write the missing HTML workspace file', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-06-02T05:00:00Z' }],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', { minPolls: 2 });
    expect(client.messageGezel).not.toHaveBeenCalled();

    await postMissingDeliverableFeedback(ctx, 'index.html', { minPolls: 2 });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('builder-1');
    expect(body.text).toContain('complete, self-contained HTML file');
    expect(body.text).toContain('write_file({ path: "index.html"');
    expect(body.text).toContain('Artifact-only plans');
    expect(body.text).not.toContain('full analysis so far');
  });

  it('prefers a writer over a more recent image generator for missing HTML', async () => {
    const client = makeClient({
      sessions: [
        { id: 's-image', gezelId: 'image-1', lastActivityAt: '2026-06-02T05:10:00Z' },
        { id: 's-dev', gezelId: 'dev-1', lastActivityAt: '2026-06-02T05:00:00Z' },
        { id: 's-voorman', gezelId: 'lead-1', lastActivityAt: '2026-06-02T04:55:00Z' },
      ],
      gezels: [
        { id: 'image-1', role: 'Image generator' },
        { id: 'dev-1', role: 'Developer' },
        { id: 'lead-1', role: 'Voorman' },
      ],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', { minPolls: 1 });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('dev-1');
    expect(body.text).toContain('write_file({ path: "index.html"');
  });

  it('escalates missing HTML immediately when only coordination roles are active', async () => {
    const client = makeClient({
      sessions: [
        { id: 's-image', gezelId: 'image-1', lastActivityAt: '2026-06-02T05:20:00Z' },
        { id: 's-lead', gezelId: 'lead-1', lastActivityAt: '2026-06-02T05:10:00Z' },
        { id: 's-designer', gezelId: 'designer-1', lastActivityAt: '2026-06-02T05:00:00Z' },
      ],
      gezels: [
        { id: 'image-1', role: 'Image generator' },
        { id: 'lead-1', role: 'Voorman' },
        { id: 'designer-1', role: 'Designer' },
      ],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', { minPolls: 1 });

    expect(client.ensureGezel).toHaveBeenCalledWith({
      jobTitle: 'Developer',
    });
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('ensured-dev-1');
    expect(body.text).toContain('No implementation specialist is active yet');
    expect(body.text).toContain('create or ensure a Developer/Builder');
    expect(body.text).toContain('expectedDeliverable: { kind: "file", filePath: "index.html" }');
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it('prefers a developer over a slightly more recent voorman for missing HTML', async () => {
    const client = makeClient({
      sessions: [
        { id: 's-lead', gezelId: 'lead-1', lastActivityAt: '2026-06-02T05:10:00Z' },
        { id: 's-dev', gezelId: 'dev-1', lastActivityAt: '2026-06-02T05:09:53Z' },
      ],
      gezels: [
        { id: 'lead-1', role: 'Voorman' },
        { id: 'dev-1', role: 'Developer' },
      ],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', { minPolls: 1 });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('dev-1');
    expect(body.text).toContain('write_file({ path: "index.html"');
  });

  it('can defer missing HTML feedback when the caller requests a longer coordinator grace', async () => {
    const client = makeClient({
      sessions: [{ id: 's-lead', gezelId: 'lead-1', lastActivityAt: '2026-06-02T05:10:00Z' }],
      gezels: [{ id: 'lead-1', role: 'Voorman' }],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      coordinatorFallbackAfterPolls: 2,
    });

    expect(client.messageGezel).not.toHaveBeenCalled();
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(client.ensureGezel).not.toHaveBeenCalled();
  });

  it('ensures a developer for deferred missing HTML feedback after a long absence', async () => {
    const client = makeClient({
      sessions: [{ id: 's-lead', gezelId: 'lead-1', lastActivityAt: '2026-06-02T05:10:00Z' }],
      gezels: [{ id: 'lead-1', role: 'Voorman' }],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      coordinatorFallbackAfterPolls: 3,
    });
    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      coordinatorFallbackAfterPolls: 3,
    });
    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      coordinatorFallbackAfterPolls: 3,
    });

    expect(client.ensureGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('ensured-dev-1');
    expect(body.text).toContain('No implementation specialist is active yet');
    expect(body.text).toContain('create or ensure a Developer/Builder');
    expect(body.text).toContain('expectedDeliverable: { kind: "file", filePath: "index.html" }');
    expect(body.text).toContain('write_file({ path: "index.html"');
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it('ensures a developer for missing HTML when only coordinator and non-writer roles exist', async () => {
    const client = makeClient({
      sessions: [
        { id: 's-image', gezelId: 'image-1', lastActivityAt: '2026-06-02T05:20:00Z' },
        { id: 's-designer', gezelId: 'designer-1', lastActivityAt: '2026-06-02T05:15:00Z' },
        { id: 's-lead', gezelId: 'lead-1', lastActivityAt: '2026-06-02T05:10:00Z' },
      ],
      gezels: [
        { id: 'image-1', role: 'Image generator' },
        { id: 'designer-1', role: 'Designer' },
        { id: 'lead-1', role: 'Voorman' },
      ],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      coordinatorFallbackAfterPolls: 2,
    });
    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      coordinatorFallbackAfterPolls: 2,
    });

    expect(client.ensureGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('ensured-dev-1');
    expect(body.text).toContain('create or ensure a Developer/Builder');
    expect(body.text).toContain('message_gezel');
    expect(body.text).toContain('expectedDeliverable: { kind: "file", filePath: "index.html" }');
    expect(body.text).toContain('write_file({ path: "index.html"');
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it('ensures a developer for deferred missing HTML feedback when only an image specialist exists', async () => {
    const client = makeClient({
      sessions: [{ id: 's-image', gezelId: 'image-1', lastActivityAt: '2026-06-02T05:10:00Z' }],
      gezels: [{ id: 'image-1', role: 'Image generator' }],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      coordinatorFallbackAfterPolls: 2,
    });
    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      coordinatorFallbackAfterPolls: 2,
    });

    expect(client.ensureGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('ensured-dev-1');
    expect(body.text).toContain('No implementation specialist is active yet');
    expect(body.text).toContain('ensure_gezel');
    expect(body.text).toContain('expectedDeliverable: { kind: "file", filePath: "index.html" }');
    expect(body.text).toContain('write_file({ path: "index.html"');
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it('keeps missing HTML nudges on implementation specialists when one appears after fallback selection', async () => {
    const client = makeClient();
    client.listChatSessions
      .mockResolvedValueOnce({
        sessions: [{ id: 's-lead', gezelId: 'lead-1', lastActivityAt: '2026-06-02T05:10:00Z' }],
      })
      .mockResolvedValueOnce({
        sessions: [
          { id: 's-lead', gezelId: 'lead-1', lastActivityAt: '2026-06-02T05:10:00Z' },
          { id: 's-dev', gezelId: 'dev-1', lastActivityAt: '2026-06-02T05:11:00Z' },
        ],
      });
    client.listGezels
      .mockResolvedValueOnce({ gezels: [{ id: 'lead-1', role: 'Voorman' }] })
      .mockResolvedValueOnce({
        gezels: [
          { id: 'lead-1', role: 'Voorman' },
          { id: 'dev-1', role: 'Developer' },
        ],
      });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', { minPolls: 1, repeatEvery: 99 });
    await postMissingDeliverableFeedback(ctx, 'index.html', { minPolls: 1, repeatEvery: 99 });

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
    const [firstTarget, firstBody] = client.messageGezel.mock.calls[0]!;
    expect(firstTarget).toBe('ensured-dev-1');
    expect(firstBody.text).toContain('write_file({ path: "index.html"');
    const [secondTarget, secondBody] = client.messageGezel.mock.calls[1]!;
    expect(secondTarget).toBe('dev-1');
    expect(secondBody.text).toContain('write_file({ path: "index.html"');
    expect(client.ensureGezel).toHaveBeenCalledTimes(1);
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it('nudges a roster developer with no session in the inferred project', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 's-lead',
          gezelId: 'lead-1',
          projectId: 'pet-shop-website',
          lastActivityAt: '2026-06-02T05:10:00Z',
        },
      ],
      gezels: [
        { id: 'lead-1', role: 'Voorman' },
        { id: 'dev-1', role: 'Developer' },
      ],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', { minPolls: 1 });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('dev-1');
    expect(body.projectId).toBe('pet-shop-website');
    expect(body.text).toContain('write_file({ path: "index.html"');
  });

  it('nudges a roster developer in the explicit project even before any specialist session exists', async () => {
    const client = makeClient({
      sessions: [],
      gezels: [{ id: 'dev-1', role: 'Developer' }],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      projectId: 'pet-shop-website',
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('dev-1');
    expect(body.projectId).toBe('pet-shop-website');
    expect(body.text).toContain('write_file({ path: "index.html"');
  });

  it('uses explicit project scope over a specialist default-project session', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 's-default-dev',
          gezelId: 'dev-1',
          projectId: 'default',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
      gezels: [{ id: 'dev-1', role: 'Developer' }],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'src/producer.ts', {
      minPolls: 1,
      projectId: 'typescript-event-pipeline',
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('dev-1');
    expect(body.projectId).toBe('typescript-event-pipeline');
    expect(body.expectedDeliverable).toEqual({ kind: 'file', filePath: 'src/producer.ts' });
    expect(body.text).toContain('write_file({ path: "src/producer.ts"');
  });

  it('nudges a roster reviewer for a markdown deliverable in the explicit project', async () => {
    const client = makeClient({
      sessions: [],
      gezels: [{ id: 'reviewer-1', role: 'Reviewer' }],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'review.md', {
      minPolls: 1,
      projectId: 'squisq-code-review',
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('reviewer-1');
    expect(body.projectId).toBe('squisq-code-review');
    expect(body.text).toContain('write_file({ path: "review.md"');
  });

  it('can defer a missing markdown nudge while a reviewer has just appeared', async () => {
    const client = makeClient({
      sessions: [],
      gezels: [{ id: 'reviewer-1', role: 'Reviewer' }],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'review.md', {
      minPolls: 1,
      projectId: 'squisq-code-review',
      targetGracePolls: 2,
    });
    await postMissingDeliverableFeedback(ctx, 'review.md', {
      minPolls: 1,
      projectId: 'squisq-code-review',
      targetGracePolls: 2,
    });
    await postMissingDeliverableFeedback(ctx, 'review.md', {
      minPolls: 1,
      projectId: 'squisq-code-review',
      targetGracePolls: 2,
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('reviewer-1');
    expect(body.projectId).toBe('squisq-code-review');
    expect(body.text).toContain('write_file({ path: "review.md"');
  });

  it('keeps project scope when ensuring a developer for a missing markdown deliverable', async () => {
    const client = makeClient({ sessions: [], gezels: [] });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'review.md', {
      minPolls: 1,
      coordinatorFallbackAfterPolls: 2,
      projectId: 'squisq-code-review',
    });
    await postMissingDeliverableFeedback(ctx, 'review.md', {
      minPolls: 1,
      coordinatorFallbackAfterPolls: 2,
      projectId: 'squisq-code-review',
    });

    expect(client.ensureGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('ensured-dev-1');
    expect(body.projectId).toBe('squisq-code-review');
    expect(body.text).toContain('write_file({ path: "review.md"');
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it('does not enqueue duplicate ensured-developer fallbacks while the first is still inside the repeat window', async () => {
    const client = makeClient({ sessions: [], gezels: [] });
    const ctx = makeCtx(client);

    for (let i = 0; i < 5; i += 1) {
      await postMissingDeliverableFeedback(ctx, 'review.md', {
        minPolls: 1,
        repeatEvery: 5,
        coordinatorFallbackAfterPolls: 2,
        projectId: 'squisq-code-review',
      });
    }

    expect(client.ensureGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [, body] = client.messageGezel.mock.calls[0]!;
    expect(body.projectId).toBe('squisq-code-review');
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it('names a near-miss markdown deliverable and still requires the exact file path', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'reviewer-1', lastActivityAt: '2026-06-02T05:00:00Z' }],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'review.md', {
      minPolls: 1,
      nearMiss: {
        path: 'review_plan.md',
        location: 'artifacts/squisq-code-review/review_plan.md',
        bytes: 2575,
      },
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [target, body] = client.messageGezel.mock.calls[0]!;
    expect(target).toBe('reviewer-1');
    expect(body.text).toContain('review_plan.md');
    expect(body.text).toContain('artifacts/squisq-code-review/review_plan.md');
    expect(body.text).toContain('wrong deliverable path or location');
    expect(body.text).toContain('plan');
    expect(body.text).toContain('artifact/library-only file');
    expect(body.text).toContain('write_file({ path: "review.md"');
    expect(body.text).toContain('exact file `review.md`');
  });

  it('includes a scenario-specific repair directive for absent deliverables', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'reviewer-1', lastActivityAt: '2026-06-02T05:00:00Z' }],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'review.md', {
      minPolls: 1,
      repairDirective: 'First call fetch_repo for the repository URL, then write review.md.',
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    const [, body] = client.messageGezel.mock.calls[0]!;
    expect(body.text).toContain('First call fetch_repo');
    expect(body.text).toContain('write_file({ path: "review.md"');
  });

  it('defers missing-deliverable feedback while the selected target is already mid-turn', async () => {
    const logs: string[] = [];
    const client = makeClient({
      sessions: [
        {
          id: 's-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
      inflight: [
        {
          sessionId: 's-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          elapsedMs: 120_000,
        },
      ],
    });
    const ctx = {
      ...makeCtx(client),
      log: (line: string) => logs.push(line),
    };

    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      projectId: 'launch-board',
    });

    expect(client.messageGezel).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('missing-deliverable nudge for index.html deferred');
  });

  it('allows missing-deliverable feedback after a long-running target turn', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 's-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
      inflight: [
        {
          sessionId: 's-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          elapsedMs: 5 * 60_000,
        },
      ],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      projectId: 'launch-board',
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(1);
  });

  it('honors a custom missing-deliverable inflight grace window', async () => {
    const logs: string[] = [];
    const client = makeClient({
      sessions: [
        {
          id: 's-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
      inflight: [
        {
          sessionId: 's-dev',
          gezelId: 'dev-1',
          projectId: 'launch-board',
          elapsedMs: 5 * 60_000,
        },
      ],
    });
    const ctx = {
      ...makeCtx(client),
      log: (line: string) => logs.push(line),
    };

    await postMissingDeliverableFeedback(ctx, 'index.html', {
      minPolls: 1,
      projectId: 'launch-board',
      inflightGraceMs: 7 * 60_000,
    });

    expect(client.messageGezel).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('target dev-1 is still mid-turn');
  });

  it('routes a newly discovered exact wrong-surface deliverable to a developer', async () => {
    const logs: string[] = [];
    const inflight: Array<{
      sessionId?: string;
      gezelId: string;
      projectId?: string;
      elapsedMs?: number;
    }> = [];
    const client = makeClient({
      sessions: [
        {
          id: 's-writer',
          gezelId: 'writer-1',
          projectId: 'driftwater-outage-notice',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
      inflight,
    });
    const ctx = {
      ...makeCtx(client),
      log: (line: string) => logs.push(line),
    };

    await postMissingDeliverableFeedback(ctx, 'customer-notice.md', {
      minPolls: 1,
      repeatEvery: 99,
      maxNudges: 1,
      projectId: 'driftwater-outage-notice',
      nearMiss: {
        path: 'drafts/old-notice.md',
        location: 'workspace/drafts/old-notice.md',
      },
    });
    inflight.push({
      sessionId: 's-writer',
      gezelId: 'writer-1',
      projectId: 'driftwater-outage-notice',
      elapsedMs: 60_000,
    });

    await postMissingDeliverableFeedback(ctx, 'customer-notice.md', {
      minPolls: 1,
      repeatEvery: 99,
      maxNudges: 1,
      projectId: 'driftwater-outage-notice',
      nearMiss: {
        path: 'customer-notice.md',
        location: 'documents/customer-notice.md',
      },
    });

    expect(client.messageGezel).toHaveBeenCalledTimes(2);
    const [, body] = client.messageGezel.mock.calls[1]!;
    const [target] = client.messageGezel.mock.calls[1]!;
    expect(target).toBe('ensured-dev-1');
    expect(body.text).toContain('documents/customer-notice.md');
    expect(logs.join('\n')).toContain('wrong-surface developer handoff for customer-notice.md');
  });

  it('suggests artifact copy as a fast path for exact artifact-side near misses', async () => {
    const client = makeClient({
      sessions: [
        {
          id: 's-writer',
          gezelId: 'writer-1',
          projectId: 'driftwater-outage-notice',
          lastActivityAt: '2026-06-02T05:00:00Z',
        },
      ],
    });
    const ctx = makeCtx(client);

    await postMissingDeliverableFeedback(ctx, 'customer-notice.md', {
      minPolls: 1,
      projectId: 'driftwater-outage-notice',
      nearMiss: {
        path: 'customer-notice.md',
        location: 'artifacts/customer-notice.md',
        bytes: 1280,
      },
    });

    const [, body] = client.messageGezel.mock.calls[0]!;
    expect(body.text).toContain('copy_artifact_to_workspace');
    expect(body.text).toContain('source: "customer-notice.md"');
    expect(body.text).toContain('dest: "customer-notice.md"');
    expect(body.text).toContain(
      'Do not end your turn until `copy_artifact_to_workspace` or `write_file`',
    );
  });
});

describe('sniff escalation ladder', () => {
  const failingSniff = (over: Partial<SniffResult> = {}): SniffResult => ({
    ok: false,
    signals: ['yaml-parses'],
    score: 1,
    failReason: 'all-paths-present: missing /books/{id}#DELETE',
    missingRequiredSignals: ['all-paths-present'],
    ...over,
  });

  it('escalates across delivered revisions: plain → REPEAT MISS → GATE_FULL_REWRITE → suppression', async () => {
    const logs: string[] = [];
    const requestTerminalFailure = vi.fn();
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'dev-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    const ctx = {
      ...makeCtx(client),
      log: (m: string) => logs.push(m),
      requestTerminalFailure,
    };
    const sniff = failingSniff();
    const directive = 'Scenario directive: add DELETE under /books/{id}.';

    await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
      sourceText: 'rev-1',
      repairDirective: directive,
    });
    await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
      sourceText: 'rev-2',
      repairDirective: directive,
    });
    await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
      sourceText: 'rev-3',
      repairDirective: directive,
    });
    expect(client.messageGezel).toHaveBeenCalledTimes(3);

    const first = client.messageGezel.mock.calls[0]![1].text as string;
    const second = client.messageGezel.mock.calls[1]![1].text as string;
    const third = client.messageGezel.mock.calls[2]![1].text as string;

    expect(first).toContain('[scenario check]');
    expect(first).toContain(directive);

    expect(second).toContain('REPEAT MISS — attempt 2');
    expect(second).toContain(directive);
    // Stage 1 must NOT trip the immediate-write clamp.
    expect(second).not.toContain('Do not end your turn until');
    expect(second).not.toContain('write_file({ path:');

    // Stage 2: the full-rewrite strategy change — immediate-write trigger
    // phrases present, scenario-check header ABSENT (that header routes
    // into the patch-only repair mode which forbids whole-file rewrites).
    expect(third).toContain('GATE_FULL_REWRITE');
    expect(third).toContain('Do not end your turn until `write_file`');
    expect(third).toContain('write_file({ path: "openapi.yaml"');
    expect(third).toContain(directive);
    expect(third).not.toContain('[scenario check] I looked at');

    // 4th distinct revision → no more model nudges; hand a structured
    // terminal failure to the runner instead of waiting for its time-based
    // retry-loop watchdog.
    const exhausted = await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
      sourceText: 'rev-4',
      repairDirective: directive,
    });
    expect(client.messageGezel).toHaveBeenCalledTimes(3);
    expect(logs.join('\n')).toContain('escalation stage 3');
    expect(exhausted).toMatchObject({
      status: 'exhausted',
      attempts: 4,
      failure: { failureMode: 'model-stuck' },
    });
    expect(requestTerminalFailure).toHaveBeenCalledTimes(1);
    expect(requestTerminalFailure.mock.calls[0]![0].reason).toContain(
      'bounded scenario feedback exhausted after 4 delivered-and-completed attempts',
    );
    expect(requestTerminalFailure.mock.calls[0]![0].reason).toContain('all-paths-present');

    // A materially different failure (signal cleared) starts a fresh ladder.
    const progressed = failingSniff({
      failReason: 'auth-on-mutations: POST /books lacks security',
      missingRequiredSignals: ['auth-on-mutations'],
    });
    await postSniffFeedback(ctx, 'openapi.yaml', progressed, { sourceText: 'rev-4' });
    expect(client.messageGezel).toHaveBeenCalledTimes(4);
    expect(client.messageGezel.mock.calls[3]![1].text).not.toContain('REPEAT MISS');
  });

  it('counts a completed post-nudge repair when the checked bytes are identical', async () => {
    const logs: string[] = [];
    const requestTerminalFailure = vi.fn();
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'dev-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    let actionSnapshot = { completedMutationTurns: 0, inflight: false };
    const snapshotRepairActions = vi.fn(async () => actionSnapshot);
    const ctx = {
      ...makeCtx(client),
      log: (message: string) => logs.push(message),
      requestTerminalFailure,
      snapshotRepairActions,
    };
    const sniff = failingSniff();
    const opts = { sourceText: 'byte-identical-revision' };

    await postSniffFeedback(ctx, 'openapi.yaml', sniff, opts);
    actionSnapshot = { completedMutationTurns: 1, inflight: false };
    await postSniffFeedback(ctx, 'openapi.yaml', sniff, opts);
    actionSnapshot = { completedMutationTurns: 2, inflight: false };
    await postSniffFeedback(ctx, 'openapi.yaml', sniff, opts);
    actionSnapshot = { completedMutationTurns: 3, inflight: false };
    const exhausted = await postSniffFeedback(ctx, 'openapi.yaml', sniff, opts);

    expect(client.messageGezel).toHaveBeenCalledTimes(3);
    expect(client.messageGezel.mock.calls[0]![1].text).toContain('[scenario check]');
    expect(client.messageGezel.mock.calls[1]![1].text).toContain('REPEAT MISS — attempt 2');
    expect(client.messageGezel.mock.calls[2]![1].text).toContain('GATE_FULL_REWRITE');
    expect(exhausted).toMatchObject({ status: 'exhausted', attempts: 4 });
    expect(requestTerminalFailure).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain(
      'counted completed post-nudge file mutation for openapi.yaml despite byte-identical checked content (signature attempt 4)',
    );
  });

  it('does not count repeated polls or an uncommitted in-flight mutation', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'dev-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    let actionSnapshot = { completedMutationTurns: 0, inflight: false };
    const ctx = {
      ...makeCtx(client),
      snapshotRepairActions: vi.fn(async () => actionSnapshot),
    };
    const sniff = failingSniff();
    const opts = { sourceText: 'unchanged' };

    expect(await postSniffFeedback(ctx, 'openapi.yaml', sniff, opts)).toMatchObject({
      status: 'sent',
      attempts: 1,
    });
    expect(await postSniffFeedback(ctx, 'openapi.yaml', sniff, opts)).toEqual({
      status: 'deduped',
    });

    actionSnapshot = { completedMutationTurns: 1, inflight: true };
    expect(await postSniffFeedback(ctx, 'openapi.yaml', sniff, opts)).toEqual({
      status: 'deduped',
    });
    expect(client.messageGezel).toHaveBeenCalledTimes(1);

    actionSnapshot = { completedMutationTurns: 1, inflight: false };
    expect(await postSniffFeedback(ctx, 'openapi.yaml', sniff, opts)).toMatchObject({
      status: 'sent',
      stage: 1,
      attempts: 2,
    });
    expect(client.messageGezel).toHaveBeenCalledTimes(2);
  });

  it('keeps proven localized repairs surgical through bounded escalation', async () => {
    const logs: string[] = [];
    const requestTerminalFailure = vi.fn();
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'dev-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    const ctx = {
      ...makeCtx(client),
      log: (message: string) => logs.push(message),
      requestTerminalFailure,
    };
    const sniff = failingSniff({
      failReason: 'allowed-imports: remove unused UserStore import',
    });
    const directive =
      'The function bodies already pass. Remove only the unused import with replace_in_file. Do not use write_file.';

    for (const sourceText of ['rev-1', 'rev-2', 'rev-3']) {
      await postSniffFeedback(ctx, 'src/handlers.ts', sniff, {
        sourceText,
        repairDirective: directive,
        targetedEditsOnly: true,
      });
    }

    expect(client.messageGezel).toHaveBeenCalledTimes(3);
    const third = client.messageGezel.mock.calls[2]![1].text as string;
    expect(third).toContain('REPEAT MISS — attempt 3');
    expect(third).toContain(directive);
    expect(third).not.toContain('GATE_FULL_REWRITE');
    expect(third).not.toContain('Do not end your turn until `write_file`');
    expect(third).not.toContain('write_file({ path:');

    await postSniffFeedback(ctx, 'src/handlers.ts', sniff, {
      sourceText: 'rev-4',
      repairDirective: directive,
      targetedEditsOnly: true,
    });
    expect(client.messageGezel).toHaveBeenCalledTimes(3);
    expect(logs.join('\n')).toContain('escalation stage 3');
    expect(requestTerminalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ failureMode: 'model-stuck' }),
    );
  });

  it('defers exhaustion while the repair target is still mid-turn', async () => {
    const logs: string[] = [];
    const inflight: Array<{
      sessionId: string;
      gezelId: string;
      projectId: string;
      elapsedMs: number;
    }> = [];
    const requestTerminalFailure = vi.fn();
    const client = makeClient({
      sessions: [
        {
          id: 's',
          gezelId: 'dev-1',
          projectId: 'project-1',
          lastActivityAt: '2026-06-04T05:00:00Z',
        },
      ],
      inflight,
    });
    const ctx = {
      ...makeCtx(client),
      log: (message: string) => logs.push(message),
      requestTerminalFailure,
    };
    const sniff = failingSniff();

    for (const sourceText of ['rev-1', 'rev-2', 'rev-3']) {
      await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
        sourceText,
        projectId: 'project-1',
      });
    }
    inflight.push({
      sessionId: 's',
      gezelId: 'dev-1',
      projectId: 'project-1',
      elapsedMs: 10 * 60_000,
    });

    const deferred = await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
      sourceText: 'rev-4',
      projectId: 'project-1',
    });
    expect(deferred).toEqual({ status: 'deferred' });
    expect(requestTerminalFailure).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('deferred exhaustion terminal handoff');

    inflight.length = 0;
    const exhausted = await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
      sourceText: 'rev-4',
      projectId: 'project-1',
    });
    expect(exhausted.status).toBe('exhausted');
    expect(requestTerminalFailure).toHaveBeenCalledTimes(1);
    expect(client.messageGezel).toHaveBeenCalledTimes(3);
  });

  it('hands off exhaustion even when the final target lookup fails', async () => {
    const logs: string[] = [];
    const requestTerminalFailure = vi.fn();
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'dev-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    const ctx = {
      ...makeCtx(client),
      log: (message: string) => logs.push(message),
      requestTerminalFailure,
    };
    const sniff = failingSniff();
    for (const sourceText of ['rev-1', 'rev-2', 'rev-3']) {
      await postSniffFeedback(ctx, 'openapi.yaml', sniff, { sourceText });
    }
    client.listChatSessions.mockRejectedValueOnce(new Error('temporary session-list failure'));

    const exhausted = await postSniffFeedback(ctx, 'openapi.yaml', sniff, {
      sourceText: 'rev-4',
    });

    expect(exhausted.status).toBe('exhausted');
    expect(requestTerminalFailure).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain('target lookup failed for openapi.yaml');
    expect(client.messageGezel).toHaveBeenCalledTimes(3);
  });

  it('keeps explicit append-only repairs on append_to_file across escalation stages', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'writer-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff = failingSniff({
      signals: ['all-sections', 'evidence-citations'],
      failReason: 'postmortem.md is 5922B (need ≥ 6 KB)',
      missingRequiredSignals: ['file-present'],
    });
    const directive =
      'Your next tool call must be `append_to_file({ path: "postmortem.md", content: "more" })`. Do not call `write_file`, rewrite existing sections, or answer in chat first.';

    for (const sourceText of ['rev-1', 'rev-2', 'rev-3']) {
      await postSniffFeedback(ctx, 'postmortem.md', sniff, {
        sourceText,
        repairDirective: directive,
      });
    }

    expect(client.messageGezel).toHaveBeenCalledTimes(3);
    const first = client.messageGezel.mock.calls[0]![1].text as string;
    const second = client.messageGezel.mock.calls[1]![1].text as string;
    const third = client.messageGezel.mock.calls[2]![1].text as string;

    expect(first).toContain(directive);
    for (const escalated of [second, third]) {
      expect(escalated).toContain('REPEAT APPEND MISS');
      expect(escalated).toContain(directive);
      expect(escalated).not.toContain('GATE_FULL_REWRITE');
      expect(escalated).not.toContain('using `replace_in_file` or `replace_lines`');
    }
  });

  it('repeats an explicit combined repair plan without narrowing to the first failure', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'writer-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff = failingSniff({
      signals: ['all-sections', 'evidence-citations'],
      failReason: 'postmortem.md is 4947B (need ≥ 6 KB)',
      missingRequiredSignals: ['file-present', 'grounded-core-facts', 'action-items-formatted'],
    });
    const directive = [
      'INCIDENT POSTMORTEM COMBINED PATCH: fix every acceptance failure below in this same repair turn.',
      '1. Use `replace_in_file` to repair Owner cells.',
      '2. Use `append_to_file` to clear the size and grounding checks.',
      'Complete every numbered file edit before replying.',
    ].join(' ');

    for (const sourceText of ['rev-1', 'rev-2', 'rev-3']) {
      await postSniffFeedback(ctx, 'postmortem.md', sniff, {
        sourceText,
        repairDirective: directive,
      });
    }

    expect(client.messageGezel).toHaveBeenCalledTimes(3);
    const first = client.messageGezel.mock.calls[0]![1].text as string;
    const second = client.messageGezel.mock.calls[1]![1].text as string;
    const third = client.messageGezel.mock.calls[2]![1].text as string;
    expect(first).toContain(directive);
    for (const escalated of [second, third]) {
      expect(escalated).toContain('REPEAT COMBINED MISS');
      expect(escalated).toContain('repeat the entire numbered repair directive');
      expect(escalated).toContain(directive);
      expect(escalated).not.toContain('fixes the FIRST failure');
      expect(escalated).not.toContain('GATE_FULL_REWRITE');
      expect(escalated).not.toContain('Do not end your turn until `write_file`');
    }
  });

  it('does not count undelivered attempts (no target yet) toward the ladder', async () => {
    const requestTerminalFailure = vi.fn();
    const client = makeClient({ sessions: [] });
    const ctx = { ...makeCtx(client), requestTerminalFailure };
    const sniff = failingSniff();
    // Revisions churn while no non-meester session exists — nothing sends,
    // nothing counts.
    await postSniffFeedback(ctx, 'openapi.yaml', sniff, { sourceText: 'rev-1' });
    await postSniffFeedback(ctx, 'openapi.yaml', sniff, { sourceText: 'rev-2' });
    await postSniffFeedback(ctx, 'openapi.yaml', sniff, { sourceText: 'rev-3' });
    expect(client.messageGezel).not.toHaveBeenCalled();

    // First eventual delivery is still the plain stage-0 nudge.
    client.listChatSessions.mockResolvedValue({
      sessions: [{ id: 's', gezelId: 'dev-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    await postSniffFeedback(ctx, 'openapi.yaml', sniff, { sourceText: 'rev-4' });
    expect(client.messageGezel).toHaveBeenCalledTimes(1);
    expect(client.messageGezel.mock.calls[0]![1].text).not.toContain('REPEAT MISS');
    expect(client.messageGezel.mock.calls[0]![1].text).toContain('[scenario check]');
    expect(requestTerminalFailure).not.toHaveBeenCalled();
  });

  it('keeps expectedDeliverable-null repairs surgical while advancing through bounded exhaustion', async () => {
    const requestTerminalFailure = vi.fn();
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    const snapshotRepairActions = vi.fn(async () => ({
      completedMutationTurns: 99,
      inflight: false,
    }));
    const ctx = { ...makeCtx(client), requestTerminalFailure, snapshotRepairActions };
    const sniff = failingSniff({
      failReason: undefined,
      missingRequiredSignals: ['working-image', 'image-asset'],
    });
    const results = [];
    for (const rev of ['r1', 'r2', 'r3', 'r4']) {
      results.push(
        await postSniffFeedback(ctx, 'index.html', sniff, {
          sourceText: rev,
          expectedDeliverable: null,
        }),
      );
    }
    const texts = client.messageGezel.mock.calls.map((c) => c[1].text as string);
    expect(texts).toHaveLength(3);
    expect(results.map((result) => result.status)).toEqual(['sent', 'sent', 'sent', 'exhausted']);
    expect(results[2]).toMatchObject({ status: 'sent', stage: 2, attempts: 3 });
    expect(results[3]).toMatchObject({ status: 'exhausted', attempts: 4 });
    for (const t of texts) {
      expect(t).not.toContain('GATE_FULL_REWRITE');
      expect(t).not.toContain('Do not end your turn until');
    }
    expect(texts[2]).toContain('REPEAT MISS — attempt 3');
    expect(requestTerminalFailure).toHaveBeenCalledTimes(1);
    expect(snapshotRepairActions).toHaveBeenCalled();
  });

  it('keeps read-first null handoffs pinned to a bounded mutation target across escalations', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'operator-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const sniff = failingSniff({
      failReason: 'runlog.md must record STEP 1, STEP 2, STEP 3, then STEP 4 in execution order',
      missingRequiredSignals: ['no-phantom-completion'],
    });
    const opts = {
      expectedDeliverable: null,
      postReadMutationTarget: 'runlog.md',
      repairDirective:
        'RUNBOOK_ORDER_REWRITE: first use read_file on runbook.md and runlog.md. Then rewrite runlog.md once in execution order.',
    } as const;

    for (const sourceText of ['revision-1', 'revision-2', 'revision-3']) {
      await postSniffFeedback(ctx, 'runlog.md', sniff, { ...opts, sourceText });
    }

    const texts = client.messageGezel.mock.calls.map((call) => call[1].text as string);
    expect(texts).toHaveLength(3);
    for (const text of texts) {
      expect(text).toContain('POST_READ_MUTATION_TARGET');
      expect(text).toContain('mutate exactly `runlog.md`');
      expect(text).toContain('one bounded `write_file` rewrite');
      expect(text).not.toContain('Do not rewrite the whole file');
      expect(text).not.toContain('GATE_FULL_REWRITE');
    }
    expect(texts[1]).toContain('REPEAT READ-THEN-MUTATE MISS');
    expect(texts[2]).toContain('repeat the bounded `write_file` rewrite');
    expect(client.messageGezel.mock.calls[0]![1].expectedDeliverable).toBeUndefined();
  });

  it('counts byte-identical completed mutations when expectedDeliverable is null', async () => {
    const logs: string[] = [];
    const requestTerminalFailure = vi.fn();
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'reader-1', lastActivityAt: '2026-06-04T05:00:00Z' }],
    });
    let actionSnapshot = { completedMutationTurns: 0, inflight: false };
    const ctx = {
      ...makeCtx(client),
      log: (message: string) => logs.push(message),
      requestTerminalFailure,
      snapshotRepairActions: vi.fn(async () => actionSnapshot),
    };
    const sniff = failingSniff({
      failReason: 'source-read provenance missing successful read_file calls',
    });
    const opts = {
      sourceText: 'byte-identical-output',
      expectedDeliverable: null,
    } as const;

    await postSniffFeedback(ctx, 'runlog.md', sniff, opts);
    actionSnapshot = { completedMutationTurns: 1, inflight: false };
    await postSniffFeedback(ctx, 'runlog.md', sniff, opts);
    actionSnapshot = { completedMutationTurns: 2, inflight: false };
    await postSniffFeedback(ctx, 'runlog.md', sniff, opts);
    actionSnapshot = { completedMutationTurns: 3, inflight: false };
    const exhausted = await postSniffFeedback(ctx, 'runlog.md', sniff, opts);

    expect(client.messageGezel).toHaveBeenCalledTimes(3);
    expect(client.messageGezel.mock.calls[2]![1].text).toContain('REPEAT MISS — attempt 3');
    expect(client.messageGezel.mock.calls[2]![1].text).not.toContain('GATE_FULL_REWRITE');
    expect(exhausted).toMatchObject({ status: 'exhausted', attempts: 4 });
    expect(requestTerminalFailure).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain(
      'counted completed post-nudge file mutation for runlog.md despite byte-identical checked content (signature attempt 4)',
    );
  });
});

describe('score-plateau escalation (progressive failures)', () => {
  // The signature ladder is blind to the progressive shape: every repair
  // fixes the named detail, a DIFFERENT check surfaces (new failReason,
  // often a new file), the signature resets, and no escalation ever fires
  // while the score sits still. These drive that exact shape.
  const progressive = (n: number): { filePath: string; sniff: SniffResult; sourceText: string } => ({
    filePath: ['src/store.ts', 'src/migrate.ts', 'src/handlers.ts', 'src/types.ts', 'src/extra.ts', 'src/more.ts', 'src/final.ts'][n % 7]!,
    sniff: {
      ok: false,
      signals: ['types-updated'],
      score: 4,
      failReason: `distinct failure class number ${'abcdefg'[n % 7]!} with its own wording`,
      missingRequiredSignals: ['handlers-updated'],
    },
    sourceText: `revision ${n} of the checked content`,
  });

  async function drive(ctx: EvalContext, n: number) {
    const step = progressive(n);
    return postSniffFeedback(ctx, step.filePath, step.sniff, { sourceText: step.sourceText });
  }

  it('escalates on a frozen score even when the failure signature churns', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-08-02T05:00:00Z' }],
    });
    const ctx = makeCtx(client);

    await drive(ctx, 0); // plateau attempt 1, delivered
    await drive(ctx, 1); // revision+churn -> plateau attempt 2
    await drive(ctx, 2); // -> plateau attempt 3 -> stage 1

    const texts = client.messageGezel.mock.calls.map((c) => c[1].text as string);
    expect(texts.length).toBe(3);
    // The signature ladder saw three fresh signatures — no REPEAT MISS.
    expect(texts.join('\n')).not.toContain('REPEAT MISS');
    expect(texts[2]).toContain('SCORE PLATEAU — 3 completed repairs');
    expect(texts[2]).toContain('score is still 4');
    expect(texts[2]).toContain('read_file');
  });

  it('a score improvement starts a fresh plateau', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-08-02T05:00:00Z' }],
    });
    const ctx = makeCtx(client);

    await drive(ctx, 0);
    await drive(ctx, 1);
    // Score rises to 5 — new plateau key, counter starts over.
    const improved = progressive(2);
    improved.sniff.score = 5;
    await postSniffFeedback(ctx, improved.filePath, improved.sniff, {
      sourceText: improved.sourceText,
    });
    const next = progressive(3);
    next.sniff.score = 5;
    await postSniffFeedback(ctx, next.filePath, next.sniff, { sourceText: next.sourceText });

    const texts = client.messageGezel.mock.calls.map((c) => c[1].text as string);
    expect(texts.length).toBe(4);
    expect(texts.join('\n')).not.toContain('SCORE PLATEAU');
  });

  it('reaches a plateau-flavored terminal only at the later threshold', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-08-02T05:00:00Z' }],
    });
    const failures: EvalTerminalFailure[] = [];
    const ctx: EvalContext = {
      ...makeCtx(client),
      requestTerminalFailure: (f) => failures.push(f),
    };

    let last: Awaited<ReturnType<typeof postSniffFeedback>> | undefined;
    for (let n = 0; n < 6; n++) last = await drive(ctx, n);

    expect(last).toMatchObject({ status: 'exhausted', attempts: 6 });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]!.reason).toContain('repair-exhausted (score plateau)');
    expect(failures[0]!.reason).toContain('score frozen at 4');
    expect(failures[0]!.failureMode).toBe('model-stuck');
  });

  it('the frozen-signature ladder still wins when the same failure repeats', async () => {
    const client = makeClient({
      sessions: [{ id: 's', gezelId: 'builder-1', lastActivityAt: '2026-08-02T05:00:00Z' }],
    });
    const ctx = makeCtx(client);
    const fixed = progressive(0);

    await postSniffFeedback(ctx, fixed.filePath, fixed.sniff, { sourceText: 'rev A' });
    await postSniffFeedback(ctx, fixed.filePath, fixed.sniff, { sourceText: 'rev B' });

    const texts = client.messageGezel.mock.calls.map((c) => c[1].text as string);
    expect(texts.length).toBe(2);
    expect(texts[1]).toContain('REPEAT MISS — attempt 2');
    expect(texts[1]).not.toContain('SCORE PLATEAU');
  });
});
