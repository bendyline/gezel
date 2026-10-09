import { turnStateWanted } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  buildContinuationNudge,
  buildFailedToolRecoveryNudge,
  isNoopConfirmationResponse,
  isSubstantiveExistingWorkspaceFile,
  isValidationRepairPrompt,
  messageExpressesModifyIntent,
  unresolvedFailedToolCalls,
} from './manager.js';

describe('buildContinuationNudge', () => {
  it('turns an incomplete write_file prefix into a concrete complete-call nudge', () => {
    const nudge = buildContinuationNudge('`write_file(', [
      {
        content:
          '[Deliverable expected as a FILE at `index.html`. Your first assistant action should be the tool call `write_file({ path, content })`.]',
      },
    ]);

    expect(nudge).toContain('incomplete tool call `write_file(`');
    expect(nudge).toContain(
      'write_file({ path: "index.html", content: <full deliverable contents> })',
    );
    expect(nudge).toContain('Do not narrate');
  });

  it('keeps the default nudge for ordinary stalled prose', () => {
    const nudge = buildContinuationNudge("I'll do that now.");

    expect(nudge).toContain('stopped before taking the next concrete step');
  });
});

describe('lean game turn recovery', () => {
  it.each(['Can you take your turn?', 'It is your move.', 'Nice one!', 'Try again.'])(
    "refreshes authoritative state for a person's %j",
    (prompt) => {
      expect(turnStateWanted(prompt, 'direct-user')).toBe(true);
    },
  );

  it('never refreshes for a page seed, a handoff or text that already carries the board', () => {
    expect(turnStateWanted('Your opponent played c3-d4. It is your turn.', 'system')).toBe(false);
    expect(turnStateWanted('Please make a move.', 'cross-gezel')).toBe(false);
    expect(
      turnStateWanted('Board now:\n...\nLegal moves: b6-c5\nPlease make a move.', 'direct-user'),
    ).toBe(false);
  });

  it('treats a failed tool as corrective until the same tool later succeeds', () => {
    const failed = {
      name: 'make_move',
      success: false,
      errorMessage: 'Illegal move f6-e5. Legal moves: b6-c5',
    };
    expect(unresolvedFailedToolCalls([failed])).toEqual([failed]);
    expect(buildFailedToolRecoveryNudge(unresolvedFailedToolCalls([failed]))).toContain(
      'Legal moves: b6-c5',
    );
    expect(unresolvedFailedToolCalls([failed, { name: 'make_move', success: true }])).toEqual([]);
  });
});

describe('isValidationRepairPrompt', () => {
  it.each([
    [
      'initial scenario check',
      "[Message from Nadia]: [scenario check] I looked at `runlog.md` and the success criteria aren't met yet.",
    ],
    [
      'initial runtime check',
      '[Message from Orion]: [runtime check seed-tasks-render] I opened `index.html` in a headless browser.',
    ],
    [
      'repeat targeted repair',
      "[Message from Nadia]: REPEAT MISS — attempt 2 on `runlog.md`: the same check is failing.\n\n[scenario check] I looked at `runlog.md` and the success criteria aren't met yet.",
    ],
    [
      'repeat append repair',
      "REPEAT APPEND MISS — attempt 2 on `report.md`: the append did not clear the check.\n\n[scenario check] I looked at `report.md` and the success criteria aren't met yet.",
    ],
    [
      'repeat combined repair',
      "REPEAT COMBINED MISS — attempt 3 on `report.md`: the combined repair did not clear the checks.\n\n[scenario check] I looked at `report.md` and the success criteria aren't met yet.",
    ],
    [
      'full-rewrite escalation',
      'GATE_FULL_REWRITE: 3 completed repairs of `index.html` have failed this scenario check with the exact same result — targeted edits are not landing.',
    ],
  ])('recognizes %s', (_label, prompt) => {
    expect(isValidationRepairPrompt(prompt)).toBe(true);
  });

  it.each([
    'Please summarize why the report describes a REPEAT MISS in our scenario-check logic.',
    'REPEAT MISS — attempt 2 on `runlog.md`: this is quoted documentation, not a delivered check.',
    'The latest [scenario check] output is included below for discussion.',
    'GATE_FULL_REWRITE is the name of an escalation marker in our evaluator.',
    '[Status]: REPEAT MISS — attempt 2 on `runlog.md`: quoted documentation.\n\n[scenario check] I looked at `runlog.md` and it still fails.',
  ])('does not classify ordinary user text: %s', (prompt) => {
    expect(isValidationRepairPrompt(prompt)).toBe(false);
  });
});

describe('isNoopConfirmationResponse', () => {
  it('accepts a short acknowledgement to a no-action confirmation prompt', () => {
    expect(
      isNoopConfirmationResponse(
        "Heads up: Marta is rescuing the project. You don't need to do anything -- just confirm you've seen this note.",
        "Got it. Marta's taking over the rescue; I'll stay out of the way.",
      ),
    ).toBe(true);
  });

  it('does not suppress real work intent', () => {
    expect(
      isNoopConfirmationResponse(
        "Heads up: Marta is rescuing the project. You don't need to do anything -- just confirm you've seen this note.",
        "Got it. I'll start reviewing the files now.",
      ),
    ).toBe(false);
  });
});

describe('isSubstantiveExistingWorkspaceFile', () => {
  it('does not treat a tiny HTML stub as stale enough to skip repair', () => {
    expect(
      isSubstantiveExistingWorkspaceFile(
        'index.html',
        '<html><body><h1>Tic-Tac-Toe Game</h1><p>You can play here.</p></body></html>',
      ),
    ).toBe(false);
  });

  it('treats a complete inline-script HTML file as stale enough to skip duplicate handoffs', () => {
    const html = `<!doctype html>
<html><body><h1>Tic-Tac-Toe</h1><div id="board"></div><script>
${'const board = [];'.repeat(40)}
document.getElementById("board").addEventListener("click", () => {});
</script></body></html>`;

    expect(isSubstantiveExistingWorkspaceFile('index.html', html)).toBe(true);
  });

  it('keeps non-HTML stale checks existence-based', () => {
    expect(isSubstantiveExistingWorkspaceFile('notes.md', 'done')).toBe(true);
  });
});

describe('messageExpressesModifyIntent', () => {
  it('flags the reported "subtract 50 points" change request', () => {
    // The exact failure (qwen3.6 "Space Shooter Arcade"): a
    // direct modification handoff naming an existing file was misread as a
    // redundant create and silently dropped before the developer ever ran.
    expect(
      messageExpressesModifyIntent(
        '[Message from Laxmi]: Update workspace/index.html so that when an alien reaches the bottom of the level, subtract 50 points.',
      ),
    ).toBe(true);
  });

  it('flags common modify verbs and behavioral-delta phrasing', () => {
    for (const msg of [
      'change the score color to red',
      'fix the collision bug in index.html',
      'remove the pause menu',
      'make it so the ship respawns after 3 seconds',
      'the boss should now take two hits instead of one',
      'add a high-score table to the game',
      'when the player dies, show a retry button',
    ]) {
      expect(messageExpressesModifyIntent(msg), msg).toBe(true);
    }
  });

  it('does NOT flag a from-scratch create brief', () => {
    // A typical "build the whole file" delegation must still be eligible for
    // the redundant-create short-circuit — only its event triggers ("spawn
    // in waves") lack the "when …" framing, so they read as create, not
    // modify.
    const create =
      '[Message from Laxmi]: Create workspace/index.html — a browser space shooter. ' +
      'Single self-contained HTML file, Canvas at 60fps. Arrow keys / WASD to move the ship, ' +
      'Spacebar to shoot. Enemies spawn in progressively faster waves. Real-time score counter. ' +
      'Game-over screen with the final score.';
    expect(messageExpressesModifyIntent(create)).toBe(false);
  });
});
