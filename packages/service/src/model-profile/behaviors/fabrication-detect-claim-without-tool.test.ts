/**
 * Coverage for `fabrication.detect-claim-without-tool`. Tests both
 * the pure detector (`detectFabricatedToolClaim`) and the wrapping
 * behavior hook so the full re-prompt path is exercised.
 */

import type { ChatMessageToolCall, ProviderName } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../types.js';
import {
  FabricationDetectClaimWithoutTool,
  detectFabricatedToolClaim,
} from './fabrication-detect-claim-without-tool.js';

function turnCtx(overrides: Partial<TurnCtx>): TurnCtx {
  return {
    catalogId: 'gemma4-26b',
    tier: 'medium',
    family: 'gemma',
    modelId: 'gemma4-26b',
    providerName: 'mlx' satisfies ProviderName,
    sessionId: 'sess-1',
    isMeester: true,
    userText: '',
    drained: [] as ChatMessageToolCall[],
    assistantContent: '',
    continuationCount: 0,
    ...overrides,
  };
}

describe('detectFabricatedToolClaim', () => {
  it('catches the wild-caught "I have created the project" without a create_project call', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have created the "Space Invaders" project.',
      firedToolNames: ['create_gezel_from_gilde', 'update_project', 'list_projects'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('created a project');
    expect(v.requiredTools).toContain('create_project');
    expect(v.nudge).toMatch(/create_project/);
  });

  it('catches "I\'ve created the **Space Invaders** project" (markdown-bold name)', () => {
    // Wild-caught from a Gemma 4 26B Meester reply on MLX. The bold
    // markdown placed between "the" and "project" was bypassing the
    // optional-name group and the fabrication detector silently passed.
    const v = detectFabricatedToolClaim({
      text: "I've created the **Space Invaders** project and assigned **Vivian** as your voorman.",
      firedToolNames: ['create_gezel_from_gilde', 'update_project'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('created a project');
  });

  it('catches the bare-titlecase form "I created the Space Invaders project"', () => {
    const v = detectFabricatedToolClaim({
      text: 'I created the Space Invaders project.',
      firedToolNames: [],
    });
    expect(v.fabricated).toBe(true);
  });

  it('catches the italic form "I created the *Space Invaders* project"', () => {
    const v = detectFabricatedToolClaim({
      text: 'I created the *Space Invaders* project.',
      firedToolNames: [],
    });
    expect(v.fabricated).toBe(true);
  });

  it('catches "I assigned **Vivian** as your voorman" when update_project did not succeed', () => {
    // Same wild-caught bundle. The third claim rule used to require
    // "the voorman" directly after the verb; the actual model output
    // was "assigned **Vivian** as your voorman" (name-then-role). The
    // extended pattern now accepts that shape.
    const v = detectFabricatedToolClaim({
      text: 'I assigned **Vivian** as your voorman to lead the crew.',
      firedToolNames: ['create_gezel_from_gilde'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('assigned the voorman');
  });

  it('catches "I set Carmen as the voorman" (bare-titlecase name)', () => {
    const v = detectFabricatedToolClaim({
      text: 'I set Carmen as the voorman.',
      firedToolNames: [],
    });
    expect(v.fabricated).toBe(true);
  });

  it('passes when create_project is among the fired tools', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have created the project.',
      firedToolNames: ['create_project', 'update_project'],
    });
    expect(v.fabricated).toBe(false);
    expect(v.nudge).toBeNull();
  });

  it('accepts start_project/start_job as justifying macro-backed project claims', () => {
    for (const tool of ['start_project', 'start_job']) {
      const v = detectFabricatedToolClaim({
        text: 'I have created the Browser Tic-Tac-Toe project.',
        firedToolNames: [tool],
      });
      expect(v.fabricated, `${tool} should justify project creation prose`).toBe(false);
    }
  });

  it('catches "I created a gezel" claims without any gezel-creation tool', () => {
    const v = detectFabricatedToolClaim({
      text: 'I created a new gezel called Vivian.',
      firedToolNames: ['list_gezels'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('created a gezel');
  });

  it('accepts ensure_gezel as justifying a gezel creation claim', () => {
    const v = detectFabricatedToolClaim({
      text: "I've created a gezel for that role.",
      firedToolNames: ['ensure_gezel'],
    });
    expect(v.fabricated).toBe(false);
  });

  it('accepts create_gezel_from_gilde as justifying a gezel creation claim', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have brought on a new gezel.',
      firedToolNames: ['create_gezel_from_gilde'],
    });
    expect(v.fabricated).toBe(false);
  });

  it('accepts project macros as justifying lead/specialist creation claims', () => {
    for (const tool of ['start_project', 'start_job']) {
      const v = detectFabricatedToolClaim({
        text: 'I have recruited a new gezel to lead the work.',
        firedToolNames: [tool],
      });
      expect(v.fabricated, `${tool} should justify lead creation prose`).toBe(false);
    }
  });

  it('catches "I assigned the voorman" without an update_project call', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have assigned the voorman to this project.',
      firedToolNames: ['create_gezel'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('assigned the voorman');
  });

  it('catches the wild-caught "I assigned the task to `dev-16a`" with a fabricated assignee', () => {
    // gemma4-e4b, "Space War Arcade": claimed it created and
    // assigned a task to `dev-16a` — a hallucinated id (real gezel ids
    // are name slugs) — with no assign_task / create_task call this turn.
    const v = detectFabricatedToolClaim({
      text: 'I have created a new task and assigned it to `dev-16a`.',
      firedToolNames: ['list_gezels'],
    });
    expect(v.fabricated).toBe(true);
    // "created a task" sorts first in the catalog, so either claim is a
    // valid catch; assert the assignee-specific guidance is reachable.
    const assignOnly = detectFabricatedToolClaim({
      text: 'I assigned the task to `dev-16a`, our engineer.',
      firedToolNames: ['ensure_gezel'],
    });
    expect(assignOnly.fabricated).toBe(true);
    expect(assignOnly.claim).toBe('assigned a task');
    expect(assignOnly.nudge).toMatch(/do not invent an id/i);
  });

  it('catches "I delegated it to the builder" without an assign tool', () => {
    const v = detectFabricatedToolClaim({
      text: 'I delegated it to the builder to implement.',
      firedToolNames: ['list_gezels'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('assigned a task');
  });

  it('accepts assign_task as justifying a task-assignment claim', () => {
    const v = detectFabricatedToolClaim({
      text: 'I assigned the task to Ravi.',
      firedToolNames: ['assign_task'],
    });
    expect(v.fabricated).toBe(false);
  });

  it('routes "assigned X as your voorman" to the voorman rule, not task-assignment', () => {
    const v = detectFabricatedToolClaim({
      text: 'I assigned Vivian as your voorman.',
      firedToolNames: [],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('assigned the voorman');
  });

  it("doesn't fire on legitimate file-creation prose that names a path, not a project", () => {
    const v = detectFabricatedToolClaim({
      text: 'I created a new file under packages/ui.',
      firedToolNames: ['write_artifact'],
    });
    expect(v.fabricated).toBe(false);
  });

  it('catches the wild-caught "I\'ve initialized the project" synonym', () => {
    const v = detectFabricatedToolClaim({
      text: "I've initialized the project and am ready to assign a voorman to lead the build.",
      firedToolNames: ['create_gezel_from_gilde', 'list_projects'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('created a project');
  });

  it('catches the Ypres "I have initiated the project" wording', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have initiated the project "Battle of Ypres Presentation".',
      firedToolNames: ['suggest_craftbook'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('created a project');
    expect(v.requiredTools).toEqual(
      expect.arrayContaining(['create_project', 'start_project', 'start_job']),
    );
  });

  it('catches a recruited voorman claim after lookup-only tools', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have recruited a `voorman` to begin drafting the presentation.',
      firedToolNames: ['suggest_craftbook', 'list_projects'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('recruited a voorman');
    expect(v.requiredTools).toEqual(
      expect.arrayContaining(['ensure_gezel', 'create_gezel_from_gilde', 'start_project']),
    );
  });

  it('accepts start_project as proof that a voorman was recruited', () => {
    const v = detectFabricatedToolClaim({
      text: 'I recruited a voorman to lead the project.',
      firedToolNames: ['start_project'],
    });
    expect(v.fabricated).toBe(false);
  });

  it('covers other project-creation synonyms (set up / spun up / started / made / bootstrapped / kicked off)', () => {
    for (const verb of ['set up', 'spun up', 'started', 'made', 'bootstrapped', 'kicked off']) {
      const v = detectFabricatedToolClaim({
        text: `I have ${verb} the project.`,
        firedToolNames: ['list_projects'],
      });
      expect(v.fabricated, `verb "${verb}" should trigger`).toBe(true);
    }
  });
});

describe('FabricationDetectClaimWithoutTool behavior hook', () => {
  it('returns a re-prompt verdict for the wild-caught Cosima case', () => {
    const verdict = FabricationDetectClaimWithoutTool.postTurnDetector!(
      turnCtx({
        assistantContent: 'I have created the "Space Invaders" project.',
        drained: [
          { name: 'create_gezel_from_gilde', durationMs: 12, success: true } as ChatMessageToolCall,
          { name: 'list_projects', durationMs: 12, success: true } as ChatMessageToolCall,
        ],
      }),
      undefined,
    );
    expect(verdict).not.toBeNull();
    expect(verdict?.warnUser).toBeUndefined();
    expect(verdict?.promptForNextTurn).toMatch(/create_project/);
    expect(verdict?.reason).toContain('created a project');
  });

  it('returns null when the matching tool was actually called', () => {
    const verdict = FabricationDetectClaimWithoutTool.postTurnDetector!(
      turnCtx({
        assistantContent: 'I have created the project.',
        drained: [{ name: 'create_project', durationMs: 12, success: true } as ChatMessageToolCall],
      }),
      undefined,
    );
    expect(verdict).toBeNull();
  });

  it('routes the exact Ypres fabrication back to invoke_craftbook', () => {
    const verdict = FabricationDetectClaimWithoutTool.postTurnDetector!(
      turnCtx({
        userText: 'Can you create a PowerPoint about the Battle of Ypres?',
        assistantContent:
          'I have initiated the project "Battle of Ypres Presentation" and recruited a `voorman`.',
        drained: [
          { name: 'suggest_craftbook', durationMs: 12, success: true } as ChatMessageToolCall,
        ],
      }),
      undefined,
    );
    expect(verdict).not.toBeNull();
    expect(verdict?.promptForNextTurn).toContain('call `invoke_craftbook` now');
    expect(verdict?.promptForNextTurn).toContain('Do not call `suggest_craftbook` again');
    expect(verdict?.promptForNextTurn).toContain('do not switch to a project/job kickoff macro');
  });

  // ── File-write fabrication ───────────────────────────────────────
  // These claims were observed in 3 of 3 timed-out tictactoe trials
  // on Gemma 4 26B MLX (eval batches). The model would
  // narrate `index.html` completion without `write_file` or
  // `write_artifact` ever firing, then the eval would time out
  // waiting for an artifact that never landed.

  it('catches "I have created the `index.html` file" without write_file/write_artifact', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have created the `index.html` file containing the full Tic-Tac-Toe game.',
      firedToolNames: ['list_artifacts'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('wrote a file');
    expect(v.requiredTools).toEqual(expect.arrayContaining(['write_file', 'write_artifact']));
    expect(v.nudge).toMatch(/write_file|write_artifact/);
  });

  it('catches "I have written the `index.html` file" wording', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have written the `index.html` file containing the complete Tic-Tac-Toe game logic.',
      firedToolNames: [],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('wrote a file');
  });

  it('catches "I have successfully written" with adverb infix', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have successfully written the single-file HTML implementation of Tic-Tac-Toe to `index.html`.',
      firedToolNames: ['read_artifact'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('wrote a file');
  });

  it('catches "I have created the single-file HTML application" (no extension, "single-file" anchor)', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have created the single-file HTML application for Browser Tic-Tac-Toe.',
      firedToolNames: [],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('wrote a file');
  });

  it('catches "I have implemented … in a single `index.html` file"', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have implemented the Tic-Tac-Toe game in a single `index.html` file.',
      firedToolNames: [],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('wrote a file');
  });

  it('does NOT fire when write_file actually succeeded', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have created the `index.html` file.',
      firedToolNames: ['write_file'],
    });
    expect(v.fabricated).toBe(false);
  });

  it('does NOT fire when write_file saved an invalid first draft for repair', () => {
    const verdict = FabricationDetectClaimWithoutTool.postTurnDetector!(
      turnCtx({
        assistantContent: 'I wrote `index.html` to the workspace.',
        drained: [
          {
            name: 'write_file',
            durationMs: 12,
            success: false,
            errorMessage:
              'inline JS does not parse (Unexpected token ]).\n\nInvalid first draft index.html was saved anyway so you can continue with read_file({ path: "index.html" }) and then repair it with replace_in_file(...) instead of starting over.',
          } as ChatMessageToolCall,
        ],
      }),
      undefined,
    );
    expect(verdict).toBeNull();
  });

  it('does NOT fire when append_to_file actually succeeded (after a truncated write_file)', () => {
    // `append_to_file` is the partner primitive used to recover from a
    // truncated `write_file`. Once a successful append lands, "I have
    // written the file" is no longer a fabrication — the file IS now
    // complete.
    const v = detectFabricatedToolClaim({
      text: 'I have written the `index.html` file.',
      firedToolNames: ['append_to_file'],
    });
    expect(v.fabricated).toBe(false);
  });

  it('does NOT fire when write_artifact actually succeeded', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have written the `index.html` file.',
      firedToolNames: ['write_artifact'],
    });
    expect(v.fabricated).toBe(false);
  });

  // ── Draft-plan deliverable gate fabrication ──────────────────────

  it('catches "I have attached the deliverable gate" without set_step_deliverable', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have attached the required `index.html` deliverable gate to all non-terminal steps in the draft plan.',
      firedToolNames: ['set_task_status'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('attached deliverable gates');
    expect(v.requiredTools).toEqual(expect.arrayContaining(['set_step_deliverable']));
    expect(v.nudge).toMatch(/set_step_deliverable/);
    expect(v.nudge).toMatch(/Do not call `set_task_status`/);
  });

  it('does NOT fire when set_step_deliverable actually succeeded', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have attached the required `index.html` deliverable gate to all non-terminal steps in the draft plan.',
      firedToolNames: ['set_step_deliverable'],
    });
    expect(v.fabricated).toBe(false);
  });

  it('does NOT treat future-tense deliverable-gate prose as a completed gate claim', () => {
    const v = detectFabricatedToolClaim({
      text: 'Now I must attach `index.html` deliverables to all non-terminal steps as required by the eval harness rules.',
      firedToolNames: ['add_task_step', 'set_outcomes'],
    });
    expect(v.fabricated).toBe(false);
  });

  // ── Task-advance fabrication ─────────────────────────────────────

  it('catches "I have advanced the task to complete the X phase"', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have advanced the task to complete the "Plan and execute" phase.',
      firedToolNames: ['read_task_notes'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('advanced or completed a task');
    expect(v.requiredTools).toEqual(
      expect.arrayContaining(['advance_task_step', 'set_task_status']),
    );
  });

  it('catches "I have completed the task and marked … as finished"', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have completed the task and marked the Tic-Tac-Toe game as finished.',
      firedToolNames: [],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('advanced or completed a task');
  });

  it('catches third-person framing "Task X is now complete"', () => {
    const v = detectFabricatedToolClaim({
      text: 'Task `browser-tic-tac-toe/5` is now **complete**.',
      firedToolNames: [],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('advanced or completed a task');
  });

  it('catches "marked the task as complete"', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have verified the implementation and marked the task as complete.',
      firedToolNames: ['read_artifact'],
    });
    expect(v.fabricated).toBe(true);
    expect(v.claim).toBe('advanced or completed a task');
  });

  it('does NOT fire when advance_task_step actually succeeded', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have advanced the task.',
      firedToolNames: ['advance_task_step'],
    });
    expect(v.fabricated).toBe(false);
  });

  it('does NOT fire when set_task_status actually succeeded', () => {
    const v = detectFabricatedToolClaim({
      text: 'I have marked the task as complete.',
      firedToolNames: ['set_task_status'],
    });
    expect(v.fabricated).toBe(false);
  });

  it('accepts project macros as justifying kickoff task claims', () => {
    for (const tool of ['start_project', 'start_job']) {
      const v = detectFabricatedToolClaim({
        text: 'I have created the kickoff task.',
        firedToolNames: [tool],
      });
      expect(v.fabricated, `${tool} should justify kickoff task prose`).toBe(false);
    }
  });

  it('only counts successful tool calls (failed update_project does not justify "voorman set" claim)', () => {
    const verdict = FabricationDetectClaimWithoutTool.postTurnDetector!(
      turnCtx({
        assistantContent: 'I have assigned the voorman to this project.',
        drained: [
          { name: 'update_project', durationMs: 12, success: false } as ChatMessageToolCall,
        ],
      }),
      undefined,
    );
    expect(verdict).not.toBeNull();
    expect(verdict?.reason).toContain('assigned the voorman');
  });
});
