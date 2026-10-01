import { describe, expect, it } from 'vitest';
import {
  DELIVERABLE_READY_FOOTER_LIMIT,
  DELIVERABLE_READY_GRACE_ITERATIONS,
  DeliverableReadySteer,
  deliverableReadyFooter,
  deliverableTouch,
  terminalToolClosingText,
} from './terminal-tool-policy.js';

const policy = {
  toolNames: ['make_move'],
  closingArg: 'moveThought',
  fallbackText: 'Move made — your turn.',
  maxClosingChars: 140,
};

describe('terminalToolClosingText', () => {
  it('always terminates a successful task-step handoff', () => {
    expect(
      terminalToolClosingText(
        undefined,
        'advance_task_step',
        { ref: 'default/10', stepId: 'research' },
        'Completed step "research" on default/10.\nActive step is now "Lock the slide outline".',
      ),
    ).toBe('Completed step "research" on default/10. Active step is now "Lock the slide outline".');
  });

  // The owner read the model-facing bookkeeping as the gezel's last word.
  it('replies with only the plain first paragraph of a task-step handoff', () => {
    expect(
      terminalToolClosingText(
        undefined,
        'advance_task_step',
        { ref: 'default/2', stepId: 'finish' },
        'Finished "Finish". "Weekly posts" is complete.\n\nCompleted step "finish" on default/2. Active step is now "(none)". Task is now complete (terminal step).',
      ),
    ).toBe('Finished "Finish". "Weekly posts" is complete.');
  });

  it('keeps a rejected task-step handoff in the repair loop', () => {
    expect(
      terminalToolClosingText(
        undefined,
        'advance_task_step',
        { ref: 'default/10', stepId: 'research' },
        'ERROR: [gate_rejected] citations do not resolve',
      ),
    ).toBeNull();
  });

  it('uses the action call table talk as one compact line', () => {
    expect(
      terminalToolClosingText(
        policy,
        'make_move',
        { moveThought: 'That opens the center.\nYour turn.' },
        'run abc — status: ok',
      ),
    ).toBe('That opens the center. Your turn.');
  });

  it('does not terminate a failed action', () => {
    expect(
      terminalToolClosingText(
        policy,
        'make_move',
        { moveThought: 'Done.' },
        'ERROR: Illegal move. Legal moves: b6-c5',
      ),
    ).toBeNull();
  });
});

describe('terminalToolClosingText — checkpoint-bound terminal writes', () => {
  const policy = {
    toolNames: ['write_artifact'],
    fallbackText: 'Checkpoint written for validation.',
    maxClosingChars: 120,
    onlyWhenArgEquals: { arg: 'path', value: 'tasks/1/billables.json' },
  };

  it('lets a write to another deliverable continue the turn', () => {
    expect(
      terminalToolClosingText(
        policy,
        'write_artifact',
        { path: 'tasks/1/scope.md' },
        'Wrote tasks/1/scope.md',
      ),
    ).toBeNull();
  });

  it('ends the turn on the checkpoint file, however the path is spelled', () => {
    expect(
      terminalToolClosingText(
        policy,
        'write_artifact',
        { path: './tasks/1/billables.json' },
        'Wrote tasks/1/billables.json',
      ),
    ).toBe('Checkpoint written for validation.');
  });
});

describe('deliverableReadyFooter', () => {
  const both = new Set(['write_file', 'write_task_note', 'advance_task_step']);
  const base = {
    toolName: 'write_file',
    args: { path: 'index.html', content: '<html></html>' },
    output: 'Wrote index.html (2048 bytes)',
    deliverableFile: 'index.html',
    ready: true,
    liveToolNames: both,
    firedCount: 0,
  };

  it('fires on a successful deliverable write once the step is ready', () => {
    expect(deliverableReadyFooter(base)).toBe(
      "[runtime] `index.html` now meets this step's completion condition — stop polishing it. Finish any other file the procedure names, then call `write_task_note` with the path and result, then `advance_task_step`.",
    );
  });

  it('fires on a passing validate and on surgical edits, however the path is spelled', () => {
    expect(
      deliverableReadyFooter({
        ...base,
        toolName: 'validate',
        args: { path: './index.html' },
        output: 'validate index.html — PASS (4 checks)\n\n✓ htmlLint',
      }),
    ).not.toBeNull();
    expect(
      deliverableReadyFooter({
        ...base,
        toolName: 'replaceInFile',
        args: { path: 'workspace/index.html', old: 'a', new: 'b' },
        output: 'Replaced 1 occurrence in index.html',
      }),
    ).not.toBeNull();
  });

  it('stays silent until the deliverable is ready', () => {
    expect(deliverableReadyFooter({ ...base, ready: false })).toBeNull();
  });

  it('ignores other paths, failed writes, failed validates, and artifact validates', () => {
    expect(deliverableReadyFooter({ ...base, args: { path: 'tests/model.test.js' } })).toBeNull();
    expect(deliverableReadyFooter({ ...base, args: { path: 'sub/index.html' } })).toBeNull();
    expect(
      deliverableReadyFooter({ ...base, output: 'ERROR: write rejected — html incomplete' }),
    ).toBeNull();
    expect(
      deliverableReadyFooter({
        ...base,
        toolName: 'validate',
        args: { path: 'index.html' },
        output: 'validate index.html — FAIL (1 of 4 completed checks failed)',
      }),
    ).toBeNull();
    expect(
      deliverableTouch(
        'validate',
        { path: 'index.html', where: 'artifact' },
        'validate index.html — PASS (2 checks)',
        'index.html',
      ),
    ).toBeNull();
    expect(
      deliverableReadyFooter({ ...base, toolName: 'read_file', output: '<html></html>' }),
    ).toBeNull();
  });

  it('names only the task tools this turn wired', () => {
    const advanceOnly = deliverableReadyFooter({
      ...base,
      liveToolNames: new Set(['write_file', 'advance_task_step']),
    });
    expect(advanceOnly).toContain('then call `advance_task_step`.');
    expect(advanceOnly).not.toContain('write_task_note');

    const noteOnly = deliverableReadyFooter({
      ...base,
      liveToolNames: new Set(['write_file', 'write_task_note']),
    });
    expect(noteOnly).toContain('`write_task_note` with the path and result and end your turn');
    expect(noteOnly).not.toContain('advance_task_step');

    const neither = deliverableReadyFooter({ ...base, liveToolNames: new Set(['write_file']) });
    expect(neither).toContain('then end your turn; the runtime advances the step.');
    expect(neither).not.toContain('write_task_note');
    expect(neither).not.toContain('advance_task_step');
  });

  it('caps at two footers per turn', () => {
    expect(DELIVERABLE_READY_FOOTER_LIMIT).toBe(2);
    expect(deliverableReadyFooter({ ...base, firedCount: 1 })).not.toBeNull();
    expect(deliverableReadyFooter({ ...base, firedCount: 2 })).toBeNull();
  });
});

describe('DeliverableReadySteer', () => {
  const live = () => new Set(['write_file', 'write_task_note', 'advance_task_step']);
  const write = { path: 'index.html', content: '<html></html>' };

  function steerWith(ready: (ctx: { writtenThisTurn: boolean }) => Promise<boolean>) {
    return DeliverableReadySteer.forStep({
      name: 'Build the model',
      deliverableFile: 'index.html',
      deliverableReady: ready,
    })!;
  }

  it('is off for artifact checkpoints and steps without a readiness probe', () => {
    const ready = async () => true;
    expect(
      DeliverableReadySteer.forStep({
        name: 'Checkpoint',
        deliverableFile: 'tasks/1/billables.json',
        deliverableIsArtifact: true,
        deliverableReady: ready,
      }),
    ).toBeNull();
    expect(
      DeliverableReadySteer.forStep({ name: 'Build', deliverableFile: 'index.html' }),
    ).toBeNull();
    expect(DeliverableReadySteer.forStep(undefined)).toBeNull();
  });

  it('asks the host only for deliverable touches, passing whether it was edited this turn', async () => {
    const seen: boolean[] = [];
    const steer = steerWith(async ({ writtenThisTurn }) => {
      seen.push(writtenThisTurn);
      return true;
    });
    expect(await steer.footerFor('grep_files', { pattern: 'x' }, 'no matches', live)).toBeNull();
    expect(
      await steer.footerFor(
        'validate',
        { path: 'index.html' },
        'validate index.html — PASS (3 checks)',
        live,
      ),
    ).not.toBeNull();
    expect(await steer.footerFor('write_file', write, 'Wrote index.html', live)).not.toBeNull();
    expect(seen).toEqual([false, true]);
    // Capped: a third touch neither fires nor re-reads the deliverable.
    expect(await steer.footerFor('write_file', write, 'Wrote index.html', live)).toBeNull();
    expect(seen).toHaveLength(2);
  });

  it('treats a throwing probe as not ready', async () => {
    const steer = steerWith(async () => {
      throw new Error('task file unreadable');
    });
    expect(await steer.footerFor('write_file', write, 'Wrote index.html', live)).toBeNull();
    expect(steer.firedCount).toBe(0);
  });

  it('closes the turn after the grace iterations when the model keeps polishing', async () => {
    const steer = steerWith(async () => true);
    await steer.footerFor('write_file', write, 'Wrote index.html', live);
    expect(await steer.backstopClosing()).toBeNull();
    await steer.footerFor('write_file', write, 'Wrote index.html', live);
    // The iteration that carried the second footer does not count.
    expect(await steer.backstopClosing()).toBeNull();
    for (let i = 1; i < DELIVERABLE_READY_GRACE_ITERATIONS; i++) {
      expect(await steer.backstopClosing()).toBeNull();
    }
    expect(await steer.backstopClosing()).toBe(
      "Finished `index.html`; handing it to the step's completion check.",
    );
  });

  it('stands down once the model tries to advance, or the file stops passing', async () => {
    const advancing = steerWith(async () => true);
    await advancing.footerFor('write_file', write, 'Wrote index.html', live);
    await advancing.footerFor('write_file', write, 'Wrote index.html', live);
    await advancing.footerFor(
      'advance_task_step',
      { ref: 'p/1', stepId: 'build' },
      'ERROR: [gate_rejected] htmlLint failed',
      live,
    );
    for (let i = 0; i <= DELIVERABLE_READY_GRACE_ITERATIONS + 1; i++) {
      expect(await advancing.backstopClosing()).toBeNull();
    }

    let ready = true;
    const broken = steerWith(async () => ready);
    await broken.footerFor('write_file', write, 'Wrote index.html', live);
    await broken.footerFor('write_file', write, 'Wrote index.html', live);
    ready = false;
    for (let i = 0; i <= DELIVERABLE_READY_GRACE_ITERATIONS + 1; i++) {
      expect(await broken.backstopClosing()).toBeNull();
    }
  });
});
