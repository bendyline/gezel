import { describe, expect, it } from 'vitest';
import { ToolFailureTracker } from './tool-failure-tracker.js';
import { TurnAbortError } from './turn-abort-error.js';

describe('ToolFailureTracker', () => {
  it('passes successful tool output through unchanged with count 0', () => {
    const t = new ToolFailureTracker();
    const r = t.recordResult('create_task', 'Created tk-1 — "Build x" with 3 phases.');
    expect(r.output).toContain('Created tk-1');
    expect(r.shouldAbort).toBe(false);
    expect(r.count).toBe(0);
  });

  it('counts ERROR-prefixed outputs as failures and increments per tool', () => {
    const t = new ToolFailureTracker();
    expect(t.recordResult('create_task', 'ERROR: validation x').count).toBe(1);
    expect(t.recordResult('create_task', 'ERROR: validation x').count).toBe(2);
  });

  it('counts plain MCP teaching errors as failures too', () => {
    const t = new ToolFailureTracker({ surgicalEditsAvailable: true, delegationAvailable: true });
    t.recordResult(
      'replace_lines',
      'replace_lines was rejected because src/game.ts failed validation',
    );
    t.recordResult(
      'replace_lines',
      'replace_lines was rejected because src/game.ts failed validation',
    );
    const r = t.recordResult(
      'replace_lines',
      'replace_lines was rejected because src/game.ts failed validation',
    );
    expect(r.count).toBe(3);
    expect(r.output).toContain('3rd consecutive failure of `replace_lines`');
    expect(r.output).toContain('delegate_meester');
  });

  it('counts Write failed transport errors as failures', () => {
    const t = new ToolFailureTracker();
    expect(t.recordResult('delegate_meester', 'Write failed: fetch failed').count).toBe(1);
  });

  it('uses one shared transport circuit across different tool names', () => {
    const t = new ToolFailureTracker();
    const first = t.recordResult('delegate_researcher', 'Write failed: fetch failed');
    expect(first.shouldAbort).toBe(false);
    expect(first.transportFailure).toBe(true);
    expect(first.output).toContain('share the same connection');

    const second = t.recordResult('message_gezel', 'ERROR: fetch failed');
    expect(second.shouldAbort).toBe(true);
    expect(second.transportFailure).toBe(true);
    expect(second.count).toBe(2);
  });

  it('surfaces transport aborts as an internal connection problem', () => {
    const err = ToolFailureTracker.buildAbort({
      providerLabel: 'llama.cpp',
      toolName: 'message_gezel',
      count: 2,
      transportFailure: true,
    });
    expect(err.message).toContain('internal tool connection');
    expect(err.userMessage).toContain('lost its internal tool connection');
    expect(err.userMessage).not.toContain('message_gezel');
  });

  it('counts draft-plan set_task_status refusals and redirects to set_step_deliverable immediately', () => {
    const t = new ToolFailureTracker();
    const refusal = [
      'Cannot change draft task plan-eval/1 with set_task_status.',
      'Draft plans stay in draft while you author about, outcomes, gated build steps, and verification.',
      'Ungated build steps: implement.',
      'Do not call set_task_status or activate_task yet. Attach gates to the draft plan first:',
      'set_step_deliverable({ task: "plan-eval/1", stepId: "implement", path: "index.html", kind: "html-page" })',
    ].join('\n');
    const r = t.recordResult('set_task_status', refusal);

    expect(r.count).toBe(1);
    expect(r.shouldAbort).toBe(false);
    expect(r.output).toContain('[runtime]');
    expect(r.output).toContain('STOP calling `set_task_status`');
    expect(r.output).toContain('Your next tool call must be `set_step_deliverable`');
  });

  it('appends a soft warning at the soft threshold (default 3)', () => {
    const t = new ToolFailureTracker();
    t.recordResult('create_task', 'ERROR: x');
    t.recordResult('create_task', 'ERROR: x');
    const r = t.recordResult('create_task', 'ERROR: x');
    expect(r.count).toBe(3);
    expect(r.shouldAbort).toBe(false);
    expect(r.output).toContain('[runtime]');
    expect(r.output).toContain('3rd consecutive failure of `create_task`');
    expect(r.output).toContain('STOP retrying');
  });

  it('uses a full-source soft warning for repeated source edit failures', () => {
    const t = new ToolFailureTracker();
    t.recordResult('write_file', 'ERROR: truncated');
    t.recordResult('write_file', 'ERROR: truncated');
    const r = t.recordResult('write_file', 'ERROR: truncated');

    expect(r.count).toBe(3);
    expect(r.shouldAbort).toBe(false);
    expect(r.output).toContain('STOP retrying fragments');
    expect(r.output).toContain('complete corrected source file');
    expect(r.output).toContain('write_file');
  });

  it('steers to a targeted line-number patch (replace_lines) when surgical edits are available', () => {
    const t = new ToolFailureTracker({ surgicalEditsAvailable: true });
    t.recordResult('write_file', 'ERROR: truncated');
    t.recordResult('write_file', 'ERROR: truncated');
    const r = t.recordResult('write_file', 'ERROR: truncated');

    // No "re-emit the whole file" advice — point at replace_lines (edit by
    // line number), the surgical tool a small model can actually drive.
    expect(r.output).toContain('replace_lines');
    expect(r.output).not.toContain('complete corrected source file');
    expect(r.output).toContain('TARGETED');
  });

  it('escalates to delegation on repeated source-edit failure when delegation is available', () => {
    const t = new ToolFailureTracker({ surgicalEditsAvailable: true, delegationAvailable: true });
    t.recordResult('replace_in_file', 'ERROR: pattern not found');
    t.recordResult('replace_in_file', 'ERROR: pattern not found');
    const r = t.recordResult('replace_in_file', 'ERROR: pattern not found');
    // Soft nudge still offers the better tool first, plus the handoff hint.
    expect(r.output).toContain('replace_lines');
    expect(r.output).toContain('delegate_meester');
  });

  it('treats replace_lines as a source-edit tool (its failures get the source-edit corrective)', () => {
    const t = new ToolFailureTracker({ surgicalEditsAvailable: true, delegationAvailable: true });
    t.recordResult('replace_lines', 'ERROR: bad range');
    t.recordResult('replace_lines', 'ERROR: bad range');
    const r = t.recordResult('replace_lines', 'ERROR: bad range');
    expect(r.output).toContain('delegate_meester');
  });

  it('keeps complete-write advice for truncated source writes even when surgical edits are available', () => {
    const t = new ToolFailureTracker({ surgicalEditsAvailable: true });
    const err =
      'ERROR: Refusing to write `index.html` because the content looks truncated (the final HTML tag is incomplete). Call `write_file` again with the complete file contents in one tool call.';
    t.recordResult('write_file', err);
    t.recordResult('write_file', err);
    const r = t.recordResult('write_file', err);

    expect(r.sourceFailureKind).toBe('truncated');
    expect(r.output).toContain('complete corrected source file');
    expect(r.output).not.toContain('TARGETED');
  });

  it('keeps complete-write advice when an atomic source write persisted no draft', () => {
    const t = new ToolFailureTracker({ surgicalEditsAvailable: true });
    const err =
      'ERROR: scripts/clean_data.mjs: syntax error. This write was rejected atomically; THE FILE WAS NOT WRITTEN and no bytes from this call were persisted.';
    t.recordResult('write_file', err);
    t.recordResult('write_file', err);
    const r = t.recordResult('write_file', err);

    expect(r.sourceFailureKind).toBe('not-persisted');
    expect(r.output).toContain('complete corrected source file');
    expect(r.output).not.toContain('TARGETED');
    expect(r.output).not.toContain('replace_lines');
  });

  it('buildAbortMessage steers to a targeted line-number patch when surgical edits are available', () => {
    const msg = ToolFailureTracker.buildAbortMessage({
      providerLabel: 'Mac AI',
      toolName: 'write_file',
      count: 5,
      surgicalEditsAvailable: true,
    });
    expect(msg).toContain('replace_lines');
    expect(msg).not.toContain('entire corrected source file');
  });

  it('buildAbortMessage hands off to a more capable model when delegation is available', () => {
    const msg = ToolFailureTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'replace_in_file',
      count: 5,
      surgicalEditsAvailable: true,
      delegationAvailable: true,
    });
    expect(msg).toContain('delegate_meester');
    // Escalation takes precedence over edit-tool advice once the budget's spent.
    expect(msg).not.toContain('replace_lines');
  });

  it('buildAbortMessage keeps complete-write advice for truncated source writes', () => {
    const msg = ToolFailureTracker.buildAbortMessage({
      providerLabel: 'Mac AI',
      toolName: 'write_file',
      count: 5,
      surgicalEditsAvailable: true,
      sourceFailureKind: 'truncated',
    });
    expect(msg).toContain('complete `write_file');
    expect(msg).not.toContain('replace_in_file');
  });

  it('buildUserMessage is plain — no provider prefix, no model-coaching imperatives', () => {
    const msg = ToolFailureTracker.buildUserMessage({ toolName: 'replace_in_file', count: 5 });
    expect(msg).not.toContain('[');
    expect(msg).not.toContain('replace_lines');
    expect(msg).not.toContain('write_file');
    expect(msg).not.toMatch(/your next message/i);
    expect(msg).toContain('file edit');
    expect(msg).toContain('5');
  });

  it('buildUserMessage names the failing tool for a non-edit structured failure', () => {
    const msg = ToolFailureTracker.buildUserMessage({ toolName: 'create_task', count: 5 });
    expect(msg).toContain('create_task');
    expect(msg).not.toContain('[');
  });

  it('buildAbort carries the model corrective on message and the user summary on userMessage', () => {
    const err = ToolFailureTracker.buildAbort({
      providerLabel: 'llama.cpp',
      toolName: 'replace_in_file',
      count: 5,
      surgicalEditsAvailable: true,
    });
    expect(err).toBeInstanceOf(TurnAbortError);
    // model-facing on .message — keeps the provider label + tool steering
    expect(err.message).toContain('[llama.cpp]');
    expect(err.message).toContain('replace_lines');
    // user-facing on .userMessage — neither leaks to the banner
    expect(err.userMessage).not.toContain('[llama.cpp]');
    expect(err.userMessage).not.toContain('replace_lines');
  });

  it('hard-aborts at the hard threshold (default 5) without augmenting output further', () => {
    const t = new ToolFailureTracker();
    for (let i = 0; i < 4; i++) t.recordResult('create_task', 'ERROR: x');
    const r = t.recordResult('create_task', 'ERROR: x');
    expect(r.count).toBe(5);
    expect(r.shouldAbort).toBe(true);
    // Hard-abort returns the raw output — caller is expected to throw,
    // not push the augmented string to the model (it'll never run again).
    expect(r.output).toBe('ERROR: x');
  });

  it('resets the counter when the SAME tool succeeds', () => {
    const t = new ToolFailureTracker();
    t.recordResult('create_task', 'ERROR: x');
    t.recordResult('create_task', 'ERROR: x');
    t.recordResult('create_task', 'Created tk-1 — ok');
    const r = t.recordResult('create_task', 'ERROR: x');
    expect(r.count).toBe(1);
  });

  it('does NOT reset when a DIFFERENT tool succeeds (catches ping-pong loops)', () => {
    const t = new ToolFailureTracker();
    t.recordResult('create_task', 'ERROR: x');
    t.recordResult('create_task', 'ERROR: x');
    t.recordResult('list_gezels', 'Maya, Leo, Ada');
    const r = t.recordResult('create_task', 'ERROR: x');
    expect(r.count).toBe(3);
    expect(r.shouldAbort).toBe(false);
    expect(r.output).toContain('3rd consecutive failure');
  });

  it('tracks each tool independently', () => {
    const t = new ToolFailureTracker();
    t.recordResult('create_task', 'ERROR: x');
    t.recordResult('update_project', 'ERROR: y');
    expect(t.recordResult('create_task', 'ERROR: x').count).toBe(2);
    expect(t.recordResult('update_project', 'ERROR: y').count).toBe(2);
  });

  it('honors custom thresholds', () => {
    const t = new ToolFailureTracker({ softWarningAt: 2, hardAbortAt: 3 });
    t.recordResult('x', 'ERROR: 1');
    const soft = t.recordResult('x', 'ERROR: 2');
    expect(soft.shouldAbort).toBe(false);
    expect(soft.output).toContain('2nd consecutive');
    const hard = t.recordResult('x', 'ERROR: 3');
    expect(hard.shouldAbort).toBe(true);
  });

  it('uses correct ordinals for 11th/12th/13th edge cases', () => {
    const t = new ToolFailureTracker({ softWarningAt: 11, hardAbortAt: 100 });
    for (let i = 0; i < 10; i++) t.recordResult('x', 'ERROR: y');
    const r = t.recordResult('x', 'ERROR: y');
    expect(r.output).toContain('11th consecutive');
  });

  it('builds a user-facing abort message with provider label', () => {
    const msg = ToolFailureTracker.buildAbortMessage({
      providerLabel: 'Mac AI',
      toolName: 'create_task',
      count: 5,
    });
    expect(msg).toContain('[Mac AI]');
    expect(msg).toContain('`create_task` failed 5 times');
    expect(msg).toContain('preserved');
  });

  it('nudges toward a handoff on the FIRST write_artifact workspace-collision refusal', () => {
    const t = new ToolFailureTracker();
    const r = t.recordResult(
      'write_artifact',
      'ERROR: Refusing write_artifact("script.js") because a workspace file already exists at that path. write_artifact would create a side-drawer copy, not update the project.',
    );
    // Unlike the generic soft warning (which only fires at the 3rd failure
    // and tells the model to "pick a different call shape"), the collision
    // nudge is immediate and points at the only valid move: a handoff.
    expect(r.count).toBe(1);
    expect(r.shouldAbort).toBe(false);
    expect(r.output).toContain('[runtime]');
    expect(r.output).toContain('WORKSPACE file');
    expect(r.output).toContain('hand off');
    expect(r.output).toContain('delegate_developer');
  });

  it('aborts a write_artifact workspace-collision after 3, sooner than the generic 5', () => {
    const t = new ToolFailureTracker();
    const collision =
      'ERROR: Refusing write_artifact("script.js") because a workspace file already exists at that path.';
    expect(t.recordResult('write_artifact', collision).shouldAbort).toBe(false); // 1
    expect(t.recordResult('write_artifact', collision).shouldAbort).toBe(false); // 2
    const third = t.recordResult('write_artifact', collision); // 3
    expect(third.count).toBe(3);
    expect(third.shouldAbort).toBe(true);
  });

  it('does NOT fast-abort a non-collision write_artifact error (keeps the generic budget)', () => {
    const t = new ToolFailureTracker();
    const malformed = 'ERROR: write_artifact validation failed: content is required';
    t.recordResult('write_artifact', malformed); // 1
    t.recordResult('write_artifact', malformed); // 2
    const third = t.recordResult('write_artifact', malformed); // 3 — generic soft warning
    expect(third.count).toBe(3);
    expect(third.shouldAbort).toBe(false);
    expect(third.output).toContain('STOP retrying');
    expect(third.output).not.toContain('WORKSPACE file');
    expect(t.recordResult('write_artifact', malformed).shouldAbort).toBe(false); // 4
    expect(t.recordResult('write_artifact', malformed).shouldAbort).toBe(true); // 5 — generic abort
  });

  it('uses a full-source hard abort message for source edit failures', () => {
    const msg = ToolFailureTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'replace_in_file',
      count: 5,
    });
    expect(msg).toContain('`replace_in_file` failed 5 times');
    expect(msg).toContain('Stop emitting source fragments');
    expect(msg).toContain('entire corrected source file');
    expect(msg).toContain('write_file({ path, content })');
    expect(msg).not.toContain('Ask the gezel');
  });

  it('lets missing deliverable feedback redirect a source edit failure', () => {
    const msg = ToolFailureTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'write_file',
      count: 5,
    });
    expect(msg).toContain('different missing deliverable path');
    expect(msg).toContain('write that exact path next');
    expect(msg).toContain('Otherwise');
  });
});
