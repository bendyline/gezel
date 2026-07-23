/**
 * Coverage for the Gemma-specific behaviors added in Step 6.
 * These all opt in via the gemma4-* manifest configs; the tests
 * exercise each behavior's hook directly so the migration's
 * Gemma-26B repro signal is reproducible from CI.
 */

import type { ChatMessageToolCall } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { OpenAIFunctionTool } from '../../providers/mcp-bridge.js';
import type { McpToolWrapper, McpToolWrapperContext } from '../../providers/mcp-wrappers/types.js';
import type { TurnCtx } from '../types.js';
import { McpValidateIdsStrict } from './mcp-validate-ids-strict.js';
import { ReasoningCapturePreToolProse } from './reasoning-capture-pre-tool-prose.js';
import { TurnAutoAcknowledgeToolErrors } from './turn-auto-acknowledge-tool-errors.js';
import { TurnPermissionStall } from './turn-permission-stall.js';
import {
  TurnSingleToolPerTurn,
  type TurnSingleToolPerTurnConfig,
} from './turn-single-tool-per-turn.js';

const STOCK_CTX = {
  spec: { kind: 'stdio' as const, command: 'node', args: [], env: {} },
  cwd: '/tmp',
  modelTier: 'medium' as const,
  isMeester: true,
  hasTool: () => true,
  callTool: async () => ({ text: '', images: [] }),
} satisfies McpToolWrapperContext;

const NON_MEESTER_CTX = {
  ...STOCK_CTX,
  isMeester: false,
} satisfies McpToolWrapperContext;

function turnCtx(overrides: Partial<TurnCtx>): TurnCtx {
  return {
    catalogId: 'gemma4-26b',
    tier: 'medium',
    family: 'gemma',
    modelId: 'gemma4:26b',
    providerName: 'ollama',
    sessionId: 's',
    isMeester: true,
    userText: '',
    drained: [],
    assistantContent: '',
    continuationCount: 0,
    ...overrides,
  };
}

function dyn(b: { mcpWrapper?: McpToolWrapper | ((c: never) => McpToolWrapper) }): McpToolWrapper {
  if (!b.mcpWrapper) throw new Error('expected an mcpWrapper');
  if (typeof b.mcpWrapper === 'function')
    return (b.mcpWrapper as (c: never) => McpToolWrapper)(undefined as never);
  return b.mcpWrapper;
}

describe('ReasoningCapturePreToolProse', () => {
  const cap = ReasoningCapturePreToolProse.captureReasoning!;

  it('captures a leading thought block ending at a blank line', () => {
    const out = cap(
      'thought\nPlan: I need to call create_project for the user.\n\nVisible reply',
      undefined as never,
      undefined as never,
    );
    expect(out.visible).toBe('Visible reply');
    expect(out.reasoning).toContain('Plan: I need to call create_project');
  });

  it('captures the whole text when no blank line is present', () => {
    const out = cap('Plan: weighing options', undefined as never, undefined as never);
    expect(out.visible).toBe('');
    expect(out.reasoning).toBe('Plan: weighing options');
  });

  it('passes through cleanly when no thinking-prefix is at the start', () => {
    const out = cap("Here's the answer to your question.", undefined as never, undefined as never);
    expect(out.visible).toBe("Here's the answer to your question.");
    expect(out.reasoning).toBe('');
  });

  it('matches case-insensitively', () => {
    const out = cap(
      'WAIT, let me reconsider.\n\nActual reply',
      undefined as never,
      undefined as never,
    );
    expect(out.visible).toBe('Actual reply');
  });
});

describe('McpValidateIdsStrict', () => {
  it('allows a call whose ID-args reference IDs the bridge has seen', async () => {
    const w = dyn(McpValidateIdsStrict);
    // First a postProcess to populate the seenIds set.
    await w.postProcess!(
      'create_project',
      {},
      { text: '{"id":"proj-real","name":"X"}', images: [] },
      STOCK_CTX,
    );
    const verdict = await w.preProcess!(
      'update_project',
      { id: 'proj-real', name: 'Y' },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
  });

  it('rejects a call whose ID-args reference values never returned', async () => {
    const w = dyn(McpValidateIdsStrict);
    const verdict = await w.preProcess!(
      'update_project',
      { id: 'space_invaders_123', name: 'Y' },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('reject');
    if (verdict.kind === 'reject') {
      expect(verdict.error).toContain('space_invaders_123');
    }
  });

  it('always allows the `default` project id (built-in sentinel)', async () => {
    const w = dyn(McpValidateIdsStrict);
    const verdict = await w.preProcess!('list_tasks', { projectId: 'default' }, STOCK_CTX);
    expect(verdict.kind).toBe('allow');
  });

  it('walks nested objects to find ID fields', async () => {
    const w = dyn(McpValidateIdsStrict);
    const verdict = await w.preProcess!(
      'create_task',
      { project: 'default', assignee: { kind: 'gezel', gezelId: 'fab-id' } },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('reject');
  });

  it('harvests IDs from non-JSON tool result text via regex fallback', async () => {
    const w = dyn(McpValidateIdsStrict);
    await w.postProcess!(
      'list_gezels',
      {},
      { text: 'Gezels:\n- "id":"g-7" (Ada)\n- "id":"g-8" (Bea)\n', images: [] },
      STOCK_CTX,
    );
    const verdict = await w.preProcess!('message_gezel', { targetGezelId: 'g-7' }, STOCK_CTX);
    expect(verdict.kind).toBe('allow');
  });

  it('seedFromText accepts ids baked into the system prompt so the first call referencing them passes', async () => {
    // Wild-caught cascade: a voorman session whose system prompt
    // includes "Tasks assigned to you in this project — tank-combat-arcade-game/2"
    // had its very first `get_task ref: "tank-combat-arcade-game/2"`
    // rejected because no PRIOR TOOL RESULT yielded that ref. The
    // seed-from-text path teaches the validator about ids the runtime
    // itself put in front of the model.
    const w = dyn(McpValidateIdsStrict);
    expect(typeof w.seedFromText).toBe('function');
    w.seedFromText!(
      'You are working in the project "Tank Combat Arcade Game".\n' +
        'The voorman of this project is **Okan**.\n' +
        '### Tasks assigned to you in this project (1)\n' +
        '- **tank-combat-arcade-game/2** — "Build Tank Combat Arcade Game"\n',
    );
    const verdict = await w.preProcess!(
      'get_task',
      { ref: 'tank-combat-arcade-game/2' },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    // Sanity: a fabricated ref of the same shape still rejects.
    const fab = await w.preProcess!(
      'get_task',
      { ref: 'tank-combat-fabricated-game/9' },
      STOCK_CTX,
    );
    expect(fab.kind).toBe('reject');
  });

  it('harvests task-ref shape from list_tasks output', async () => {
    // list_tasks formats lines as `• <ref> [status] (→ <who>) — "<title>" · …`.
    // The harvester needs the ref-shape regex to catch these — without
    // it the voorman flow wedges on the first call (`get_task` /
    // `read_task_notes`) using a ref taken verbatim from list_tasks.
    const w = dyn(McpValidateIdsStrict);
    await w.postProcess!(
      'list_tasks',
      {},
      {
        text:
          '• marketing/7 [active] (→ designer-1) — "Draft hero copy" · active step: outline\n' +
          '• marketing/8 [paused] (→ designer-1) — "Polish footer" · no active step',
        images: [],
      },
      STOCK_CTX,
    );
    const v1 = await w.preProcess!('read_task_notes', { ref: 'marketing/7' }, STOCK_CTX);
    expect(v1.kind).toBe('allow');
    const v2 = await w.preProcess!('get_task', { ref: 'marketing/8' }, STOCK_CTX);
    expect(v2.kind).toBe('allow');
    const v3 = await w.preProcess!('read_task_notes', { ref: 'fabricated/99' }, STOCK_CTX);
    expect(v3.kind).toBe('reject');
  });

  it('harvests prose-style IDs returned by create_* tools', async () => {
    // gezel-mcp's create_project / create_gezel_from_gilde reply with
    // text ending `… — id: <value>. Next: …` — the dominant shape
    // for "I just created something" results. The harvester must
    // catch it or the very next call's args are flagged as
    // fabrications.
    const w = dyn(McpValidateIdsStrict);
    await w.postProcess!(
      'create_project',
      {},
      {
        text: 'Created project "Tic-Tac-Toe Browser Game" — id: tic-tac-toe-browser-game-7f. Next: pick or create a voorman.',
        images: [],
      },
      STOCK_CTX,
    );
    await w.postProcess!(
      'create_gezel_from_gilde',
      {},
      { text: 'Created gezel "Mhairi" from template "voorman" — id: mhairi', images: [] },
      STOCK_CTX,
    );
    const v1 = await w.preProcess!(
      'update_project',
      { id: 'tic-tac-toe-browser-game-7f', voormanGezelId: 'mhairi' },
      STOCK_CTX,
    );
    expect(v1.kind).toBe('allow');
  });

  it('returns a fresh tracker per factory invocation (per-bridge state)', async () => {
    const w1 = dyn(McpValidateIdsStrict);
    const w2 = dyn(McpValidateIdsStrict);
    await w1.postProcess!('x', {}, { text: '{"id":"only-in-bridge-1"}', images: [] }, STOCK_CTX);
    const v1 = await w1.preProcess!('y', { id: 'only-in-bridge-1' }, STOCK_CTX);
    const v2 = await w2.preProcess!('y', { id: 'only-in-bridge-1' }, STOCK_CTX);
    expect(v1.kind).toBe('allow');
    expect(v2.kind).toBe('reject');
  });
});

describe('TurnSingleToolPerTurn', () => {
  function make(cfg: TurnSingleToolPerTurnConfig = { meesterOnly: true }): McpToolWrapper {
    const factory = TurnSingleToolPerTurn.mcpWrapper as (
      c: TurnSingleToolPerTurnConfig,
    ) => McpToolWrapper;
    return factory(cfg);
  }

  it('allows a single in-flight call', async () => {
    const w = make();
    const out = await w.preProcess!('create_project', {}, STOCK_CTX);
    expect(out.kind).toBe('allow');
  });

  it('rejects a second concurrent call before the first resolves', async () => {
    const w = make();
    await w.preProcess!('create_project', {}, STOCK_CTX);
    const out = await w.preProcess!('create_gezel', {}, STOCK_CTX);
    expect(out.kind).toBe('reject');
    if (out.kind === 'reject') {
      expect(out.error).toContain('one tool call per turn');
    }
  });

  it('allows the next call once the previous call ends', async () => {
    const w = make();
    await w.preProcess!('create_project', {}, STOCK_CTX);
    await w.onCallEnd!('create_project', {}, STOCK_CTX);
    const out = await w.preProcess!('create_gezel', {}, STOCK_CTX);
    expect(out.kind).toBe('allow');
  });

  it('drains the counter even when the SDK call throws (no postProcess ran)', async () => {
    // The Choplifter doom-loop trigger: the MCP transport timed out
    // with `-32001`, so `_invokeRaw` threw and the bridge skipped
    // both `postProcess` (success-only) and `postProcessError`
    // (tool-side-error-only). The terminal `onCallEnd` hook is the
    // ONLY path the bridge always invokes — without it, a single
    // thrown call wedges the rest of the turn.
    const w = make();
    await w.preProcess!('ask_specialist', {}, STOCK_CTX);
    // No postProcess / postProcessError this time — simulate the
    // throw path. The bridge's finally block invokes onCallEnd.
    await w.onCallEnd!('ask_specialist', {}, STOCK_CTX);
    const out = await w.preProcess!('list_projects', {}, STOCK_CTX);
    expect(out.kind).toBe('allow');
  });

  it('short-circuits on non-Meester sessions when meesterOnly: true', async () => {
    // Voorman / worker sessions inherit the same Gemma profile but
    // run high-throughput sequences ("ensure gezel" → "add step" →
    // "advance phase") we explicitly want. The wrapper has to opt
    // those flows out via ctx.isMeester or it punishes legitimate
    // work the way it punished Yusuke in the Choplifter session.
    const w = make({ meesterOnly: true });
    const first = await w.preProcess!('create_project', {}, NON_MEESTER_CTX);
    const second = await w.preProcess!('create_gezel', {}, NON_MEESTER_CTX);
    expect(first.kind).toBe('allow');
    expect(second.kind).toBe('allow');
  });

  it('applies unconditionally when meesterOnly: false', async () => {
    const w = make({ meesterOnly: false });
    await w.preProcess!('create_project', {}, NON_MEESTER_CTX);
    const out = await w.preProcess!('create_gezel', {}, NON_MEESTER_CTX);
    expect(out.kind).toBe('reject');
  });

  it('exposes a defaultConfig of { meesterOnly: true }', () => {
    expect(TurnSingleToolPerTurn.defaultConfig).toEqual({ meesterOnly: true });
  });
});

describe('TurnAutoAcknowledgeToolErrors', () => {
  const detect = TurnAutoAcknowledgeToolErrors.postTurnDetector!;

  function call(name: string, success: boolean): ChatMessageToolCall {
    return {
      name,
      success,
      durationMs: 1,
      ...(success ? {} : { errorMessage: 'bad' }),
    };
  }

  it('returns null when no tool calls errored', () => {
    const ctx = turnCtx({
      drained: [call('create_project', true)],
      assistantContent: 'I created the project.',
    });
    expect(detect(ctx, undefined as never)).toBeNull();
  });

  it('returns null when an error occurred AND the reply acknowledges failure', () => {
    const ctx = turnCtx({
      drained: [call('create_project', false)],
      assistantContent: "I tried but the call failed — couldn't validate the project shape.",
    });
    expect(detect(ctx, undefined as never)).toBeNull();
  });

  it('re-prompts acknowledged draft-plan gate failures toward set_step_deliverable', () => {
    const ctx = turnCtx({
      drained: [
        {
          name: 'set_task_status',
          success: false,
          durationMs: 1,
          errorMessage: [
            'Cannot change draft task plan-eval/1 with set_task_status.',
            'Draft plans stay in draft while you author about, outcomes, gated build steps, and verification.',
            'Ungated build steps: implement.',
            'Do not call set_task_status or activate_task yet. Attach gates to the draft plan first:',
            'set_step_deliverable({ task: "plan-eval/1", stepId: "implement", path: "index.html", kind: "html-page" })',
          ].join('\n'),
        } as ChatMessageToolCall,
      ],
      assistantContent:
        'I encountered an error because I tried to activate the draft plan before attaching the required deliverable gates.',
    });
    const out = detect(ctx, undefined as never);

    expect(out).not.toBeNull();
    expect(out!.reason).toContain('set_step_deliverable');
    expect(out!.promptForNextTurn).toContain(
      'Your next assistant action must be `set_step_deliverable',
    );
    expect(out!.promptForNextTurn).toContain('Do not call `set_task_status`');
  });

  it('does not re-prompt draft-plan gate failures after set_step_deliverable succeeds', () => {
    const ctx = turnCtx({
      drained: [
        {
          name: 'set_task_status',
          success: false,
          durationMs: 1,
          errorMessage:
            'Cannot change draft task plan-eval/1 with set_task_status.\nset_step_deliverable({ task: "plan-eval/1", stepId: "implement", path: "index.html", kind: "html-page" })',
        } as ChatMessageToolCall,
        { name: 'set_step_deliverable', success: true, durationMs: 1 } as ChatMessageToolCall,
      ],
      assistantContent: 'The first status change failed, but I attached the deliverable gate.',
    });

    expect(detect(ctx, undefined as never)).toBeNull();
  });

  it('returns null for writeFile errors that saved an invalid first draft for repair', () => {
    const ctx = turnCtx({
      drained: [
        {
          name: 'writeFile',
          success: false,
          durationMs: 1,
          errorMessage:
            'inline JS does not parse (Invalid destructuring assignment target)\n\n' +
            'Invalid first draft index.html was saved anyway so you can continue with readFile({ path: "index.html" }) and then repair it with replaceInFile(...) instead of starting over.',
        },
      ],
      assistantContent: 'I wrote `index.html` to the workspace.',
    });
    expect(detect(ctx, undefined as never)).toBeNull();
  });

  it('does not re-prompt after a later retry of the same tool succeeds', () => {
    const ctx = turnCtx({
      drained: [call('create_project', false), call('create_project', true)],
      assistantContent: 'The project is ready.',
    });

    expect(detect(ctx, undefined as never)).toBeNull();
  });

  it('keeps unrelated failures after another tool error is superseded', () => {
    const ctx = turnCtx({
      drained: [
        call('create_project', false),
        call('message_gezel', false),
        call('create_project', true),
      ],
      assistantContent: 'The project is ready.',
    });

    const out = detect(ctx, undefined as never);
    expect(out).not.toBeNull();
    expect(out!.reason).toContain('message_gezel');
    expect(out!.reason).not.toContain('create_project');
  });

  it('does not re-prompt when a later write repairs a failed surgical edit on the same path', () => {
    const ctx = turnCtx({
      drained: [
        {
          ...call('replaceLines', false),
          path: 'workspace\\src//store.ts',
        },
        {
          ...call('writeFile', true),
          path: './src/store.ts',
        },
      ],
      assistantContent: 'The store repair landed.',
    });

    expect(detect(ctx, undefined as never)).toBeNull();
  });

  it('does not re-prompt when the same mutation tool later succeeds on the same path', () => {
    const ctx = turnCtx({
      drained: [
        {
          ...call('writeFile', false),
          path: 'workspace/src/store.ts',
        },
        {
          ...call('writeFile', true),
          path: './src/store.ts',
        },
      ],
      assistantContent: 'The store repair landed.',
    });

    expect(detect(ctx, undefined as never)).toBeNull();
  });

  it('still re-prompts when a later workspace mutation succeeds on a different path', () => {
    const ctx = turnCtx({
      drained: [
        {
          ...call('replaceLines', false),
          path: 'src/store.ts',
        },
        {
          ...call('writeFile', true),
          path: 'src/handlers.ts',
        },
      ],
      assistantContent: 'The repair landed.',
    });

    const out = detect(ctx, undefined as never);
    expect(out).not.toBeNull();
    expect(out!.reason).toContain('replaceLines');
  });

  it('still re-prompts when the same workspace mutation tool later succeeds on a different path', () => {
    const ctx = turnCtx({
      drained: [
        {
          ...call('writeFile', false),
          path: 'src/store.ts',
        },
        {
          ...call('writeFile', true),
          path: 'src/handlers.ts',
        },
      ],
      assistantContent: 'The handler repair landed.',
    });

    const out = detect(ctx, undefined as never);
    expect(out).not.toBeNull();
    expect(out!.reason).toContain('writeFile');
  });

  it('still re-prompts when the matching mutation happened before the failure', () => {
    const ctx = turnCtx({
      drained: [
        {
          ...call('writeFile', true),
          path: 'src/store.ts',
        },
        {
          ...call('replaceLines', false),
          path: 'src/store.ts',
        },
      ],
      assistantContent: 'The store repair landed.',
    });

    expect(detect(ctx, undefined as never)).not.toBeNull();
  });

  it('does not treat a successful non-mutation on the same path as a repair', () => {
    const ctx = turnCtx({
      drained: [
        {
          ...call('replaceLines', false),
          path: 'src/store.ts',
        },
        {
          ...call('readFile', true),
          path: 'src/store.ts',
        },
      ],
      assistantContent: 'The store repair landed.',
    });

    expect(detect(ctx, undefined as never)).not.toBeNull();
  });

  it('fires a verdict when an error occurred AND the reply claims success', () => {
    const ctx = turnCtx({
      drained: [call('create_project', false)],
      assistantContent: "I have created the project for you. It's ready to use.",
    });
    const out = detect(ctx, undefined as never);
    expect(out).not.toBeNull();
    expect(out!.promptForNextTurn).toBeDefined();
    expect(out!.reason).toContain('create_project');
  });

  it('fires when ANY of the called tools errored, even if others succeeded', () => {
    const ctx = turnCtx({
      drained: [call('list_gezels', true), call('message_gezel', false)],
      assistantContent: 'Sent the message.',
    });
    expect(detect(ctx, undefined as never)).not.toBeNull();
  });
});

describe('TurnPermissionStall', () => {
  const detect = TurnPermissionStall.postTurnDetector!;

  function call(name: string, success = true): ChatMessageToolCall {
    return {
      name,
      success,
      durationMs: 1,
      ...(success ? {} : { errorMessage: 'bad' }),
    };
  }

  it('re-prompts when an action request ends in a prose permission question', () => {
    const out = detect(
      turnCtx({
        userText: 'Can you fix the Space Invaders game?',
        drained: [call('readFile')],
        assistantContent: 'I found the issue. Would you like me to proceed with these fixes?',
      }),
      undefined as never,
    );
    expect(out).not.toBeNull();
    expect(out!.reason).toContain('prose permission');
    expect(out!.promptForNextTurn).toContain('already asked');
    expect(out!.promptForNextTurn).toContain('action tool call');
  });

  it('also catches a stall after a successful edit landed', () => {
    const out = detect(
      turnCtx({
        userText: 'Please fix src/game.ts.',
        drained: [call('replaceLines')],
        assistantContent: 'I updated `initGame`. Should I proceed with the next changes?',
      }),
      undefined as never,
    );
    expect(out).not.toBeNull();
  });

  it('does not fire when the model used the structured question tool', () => {
    const out = detect(
      turnCtx({
        userText: 'Can you fix the game?',
        drained: [call('ask_user_question')],
        assistantContent: 'Should I proceed with a full rewrite or a patch?',
      }),
      undefined as never,
    );
    expect(out).toBeNull();
  });

  it('does not fire for non-action chat', () => {
    const out = detect(
      turnCtx({
        userText: 'Can you explain the options?',
        drained: [],
        assistantContent: 'Would you like me to proceed with implementing one?',
      }),
      undefined as never,
    );
    expect(out).toBeNull();
  });
});
