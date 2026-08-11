import { describe, expect, it } from 'vitest';
import { ToolRepeatTracker } from './tool-repeat-tracker.js';
import { TurnAbortError } from './turn-abort-error.js';

describe('ToolRepeatTracker', () => {
  it('passes the first call through with count=1, no warning', () => {
    const t = new ToolRepeatTracker();
    const r = t.recordCall('read_file', { path: 'package.json' }, 'file contents...');
    expect(r.count).toBe(1);
    expect(r.shouldAbort).toBe(false);
    expect(r.output).toBe('file contents...');
  });

  it('passes the second call through with count=2, no warning', () => {
    const t = new ToolRepeatTracker();
    t.recordCall('read_file', { path: 'package.json' }, 'contents');
    const r = t.recordCall('read_file', { path: 'package.json' }, 'contents');
    expect(r.count).toBe(2);
    expect(r.shouldAbort).toBe(false);
    expect(r.output).toBe('contents');
  });

  it('annotates with a soft warning at the 3rd same-args call', () => {
    const t = new ToolRepeatTracker();
    t.recordCall('read_task_notes', { ref: 'a/3' }, 'notes...');
    t.recordCall('read_task_notes', { ref: 'a/3' }, 'notes...');
    const r = t.recordCall('read_task_notes', { ref: 'a/3' }, 'notes...');
    expect(r.count).toBe(3);
    expect(r.shouldAbort).toBe(false);
    expect(r.output).toContain('[runtime]');
    expect(r.output).toContain('3 times this turn');
    expect(r.output).toContain('`read_task_notes`');
    expect(r.output).toContain('stop re-fetching');
  });

  it('hard-aborts at the 5th same-args call', () => {
    const t = new ToolRepeatTracker();
    for (let i = 0; i < 4; i++) {
      t.recordCall('read_file', { path: 'a.json' }, 'x');
    }
    const r = t.recordCall('read_file', { path: 'a.json' }, 'x');
    expect(r.count).toBe(5);
    expect(r.shouldAbort).toBe(true);
  });

  it('counts repeated write_file calls to the same path even when content changes', () => {
    const t = new ToolRepeatTracker();
    t.recordCall('write_file', { path: 'script.js', content: 'one' }, 'wrote');
    t.recordCall('write_file', { path: 'script.js', content: 'two' }, 'wrote');
    const soft = t.recordCall('write_file', { path: 'script.js', content: 'three' }, 'wrote');
    expect(soft.count).toBe(3);
    expect(soft.output).toContain('same path `script.js` 3 times');
    expect(soft.output).toContain('Stop re-writing');

    t.recordCall('write_file', { path: 'script.js', content: 'four' }, 'wrote');
    const hard = t.recordCall('write_file', { path: 'script.js', content: 'five' }, 'wrote');
    expect(hard.count).toBe(5);
    expect(hard.shouldAbort).toBe(true);
  });

  it('counts repeated task notes by task + step even when the checklist text changes', () => {
    const t = new ToolRepeatTracker();
    t.recordCall(
      'write_task_note',
      { ref: 'frogger/1', stepId: 'build', text: 'Checklist version one' },
      'Appended note one',
    );
    t.recordCall(
      'write_task_note',
      { ref: 'frogger/1', stepId: 'build', text: 'Checklist version two' },
      'Appended note two',
    );
    const soft = t.recordCall(
      'write_task_note',
      { ref: 'frogger/1', stepId: 'build', text: 'Checklist version three' },
      'Appended note three',
    );
    expect(soft.count).toBe(3);
    expect(soft.output).toContain('task `frogger/1` step `build` 3 times');
    expect(soft.output).toContain('Stop re-writing');

    t.recordCall(
      'write_task_note',
      { ref: 'frogger/1', stepId: 'build', text: 'Checklist version four' },
      'Appended note four',
    );
    const hard = t.recordCall(
      'write_task_note',
      { ref: 'frogger/1', stepId: 'build', text: 'Checklist version five' },
      'Appended note five',
    );
    expect(hard.count).toBe(5);
    expect(hard.shouldAbort).toBe(true);

    const otherStep = t.recordCall(
      'write_task_note',
      { ref: 'frogger/1', stepId: 'evaluate', text: 'Evaluation note' },
      'Appended evaluation note',
    );
    expect(otherStep.count).toBe(1);
  });

  it('does not spend the persisted-write repeat budget on different atomically rejected drafts', () => {
    const t = new ToolRepeatTracker();
    const rejected =
      'ERROR: syntax error. This write is rejected atomically; THE FILE WAS NOT WRITTEN by this call.';

    const firstRejected = t.recordCall(
      'write_file',
      { path: 'scripts/derive.mjs', content: 'const broken = ;' },
      rejected,
    );
    const correctedRejected = t.recordCall(
      'write_file',
      { path: 'scripts/derive.mjs', content: 'const stillBroken: string = "x";' },
      rejected,
    );
    const firstPersisted = t.recordCall(
      'write_file',
      { path: 'scripts/derive.mjs', content: 'const valid = "x";' },
      'Wrote scripts/derive.mjs',
    );

    expect(firstRejected.count).toBe(1);
    expect(correctedRejected.count).toBe(1);
    expect(firstPersisted.count).toBe(1);
  });

  it('still detects an identical atomically rejected draft loop', () => {
    const t = new ToolRepeatTracker({ softWarningAt: 2, hardAbortAt: 3 });
    const args = { path: 'scripts/derive.mjs', content: 'const broken = ;' };
    const rejected = 'ERROR: THE FILE WAS NOT WRITTEN by this call.';

    t.recordCall('write_file', args, rejected);
    const soft = t.recordCall('write_file', args, rejected);
    const hard = t.recordCall('write_file', args, rejected);

    expect(soft.count).toBe(2);
    expect(soft.output).toContain('[runtime]');
    expect(hard.shouldAbort).toBe(true);
  });

  it('counts repeated replace_in_file calls to the same path even when patches change', () => {
    const t = new ToolRepeatTracker();
    t.recordCall(
      'replace_in_file',
      { path: 'index.html', find: 'one', replace: 'two' },
      'ERROR: not found',
    );
    t.recordCall(
      'replace_in_file',
      { path: 'index.html', find: 'three', replace: 'four' },
      'ERROR: not found',
    );
    const soft = t.recordCall(
      'replace_in_file',
      { path: 'index.html', find: 'five', replace: 'six' },
      'ERROR: not found',
    );

    expect(soft.count).toBe(3);
    expect(soft.output).toContain('same path `index.html` 3 times');

    t.recordCall(
      'replace_in_file',
      { path: 'index.html', find: 'seven', replace: 'eight' },
      'ERROR: not found',
    );
    const hard = t.recordCall(
      'replace_in_file',
      { path: 'index.html', find: 'nine', replace: 'ten' },
      'ERROR: not found',
    );
    expect(hard.count).toBe(5);
    expect(hard.shouldAbort).toBe(true);
  });

  it('counts cumulatively across the turn — interleaved calls still trip the threshold', () => {
    // Replicates the Atari Combat bug shape: read_task_notes,
    // [other reads], read_task_notes, [more reads], read_task_notes.
    // detectRepeatCall (consecutive-only) misses this; this tracker
    // catches it.
    const t = new ToolRepeatTracker();
    t.recordCall('read_task_notes', { ref: 'a/3' }, 'notes');
    t.recordCall('list_artifacts', { recursive: true }, '[]');
    t.recordCall('list_dir', { path: 'src' }, '[]');
    t.recordCall('read_task_notes', { ref: 'a/3' }, 'notes');
    t.recordCall('read_file', { path: 'package.json' }, '{}');
    const r = t.recordCall('read_task_notes', { ref: 'a/3' }, 'notes');
    expect(r.count).toBe(3);
    expect(r.shouldAbort).toBe(false);
    expect(r.output).toContain('3 times this turn');
  });

  it('treats different args of the same tool as separate fingerprints', () => {
    const t = new ToolRepeatTracker();
    t.recordCall('read_file', { path: 'a.json' }, 'a');
    t.recordCall('read_file', { path: 'a.json' }, 'a');
    const otherFirst = t.recordCall('read_file', { path: 'b.json' }, 'b');
    expect(otherFirst.count).toBe(1);
    expect(otherFirst.shouldAbort).toBe(false);
  });

  it('treats no-args calls as identical (`{}` fingerprint)', () => {
    const t = new ToolRepeatTracker();
    t.recordCall('list_packages', undefined, 'pkgs');
    t.recordCall('list_packages', null, 'pkgs');
    const r = t.recordCall('list_packages', {}, 'pkgs');
    expect(r.count).toBe(3);
  });

  it('honors custom thresholds', () => {
    const t = new ToolRepeatTracker({ softWarningAt: 2, hardAbortAt: 3 });
    t.recordCall('x', {}, 'y');
    const soft = t.recordCall('x', {}, 'y');
    expect(soft.shouldAbort).toBe(false);
    expect(soft.output).toContain('2 times this turn');
    const hard = t.recordCall('x', {}, 'y');
    expect(hard.shouldAbort).toBe(true);
  });

  it('builds a user-facing abort message with provider label', () => {
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'Mac AI',
      toolName: 'read_task_notes',
      count: 5,
    });
    expect(msg).toContain('[Mac AI]');
    expect(msg).toContain('`read_task_notes` was called with these exact arguments 5 times');
    expect(msg).toContain('Stop re-reading');
  });

  it('phrases the corrective as a direct directive TO THE GEZEL', () => {
    // Wild-caught (Gemma 26B batches): the prior wording
    // "Ask the gezel to summarize…" reads as a hint to the user and
    // didn't change the gezel's behavior on resume. The replacement
    // text must include an action-tool list the gezel can act on.
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'Mac AI',
      toolName: 'read_task_notes',
      count: 5,
    });
    expect(msg).toMatch(/write_artifact|write_file/);
    expect(msg).toMatch(/Stop|MUST/);
  });

  it('does NOT name `advance_task_phase` (which is not a real tool)', () => {
    // Wild-caught (qwen3.6 27B tankcombat voorman): the
    // hardcoded suggestion list named `advance_task_phase`, but the
    // real registered tool has always been `advance_task_step`. The
    // bad name pointed the model at a fabricated call.
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'Mac AI',
      toolName: 'get_task',
      count: 5,
    });
    expect(msg).not.toContain('advance_task_phase');
    expect(msg).toContain('advance_task_step');
  });

  it('uses the canonical installed-script tool in craftbook-step correctives', () => {
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'read_task_notes',
      count: 5,
      registeredTools: ['read_task_notes', 'run_installed_script', 'ask_user_question'],
      activeStep: {
        name: 'Load PR context',
        onExitScriptName: 'pr-context',
      },
    });

    expect(msg).toContain('run_installed_script({ name: "pr-context" })');
    expect(msg).not.toContain('`run_script');
  });

  it('filters action-tool suggestions to what is actually registered', () => {
    // Voorman loadout: no `write_file`, no `write_artifact` (read-only
    // workspace) — just `message_gezel`, `set_task_status`, etc.
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'Mac AI',
      toolName: 'get_task',
      count: 5,
      registeredTools: [
        'get_task',
        'read_task_notes',
        'message_gezel',
        'assign_task',
        'set_task_status',
        'advance_task_step',
        'ask_user_question',
      ],
    });
    expect(msg).not.toContain('write_file');
    expect(msg).not.toContain('write_artifact');
    expect(msg).toContain('message_gezel');
    expect(msg).toContain('assign_task');
    // Ship-code hint should be dropped when no write tool is wired.
    expect(msg).not.toContain('full file contents');
  });

  it('keeps repo/project macros available after coordination read loops', () => {
    // Wild-caught (squisq-review eval): the Meester looped
    // on list_gezels, then the corrective only suggested message_gezel.
    // For repo-intake work, that steers the model away from the actual
    // next action: fetch_repo/fetch_diff before recruiting a reviewer.
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'list_gezels',
      count: 5,
      registeredTools: [
        'list_gezels',
        'fetch_repo',
        'fetch_diff',
        'start_project',
        'ensure_gezel',
        'message_gezel',
      ],
    });
    expect(msg).toContain('fetch_repo');
    expect(msg).toContain('fetch_diff');
    expect(msg).toContain('start_project');
    expect(msg).toContain('ensure_gezel');
    expect(msg).toContain('message_gezel');
    expect(msg).toContain('remote repository');
    expect(msg).toContain('workspace contains real source files');
  });

  it('keeps the ship-code hint when a write tool IS registered', () => {
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'read_file',
      count: 5,
      registeredTools: ['read_file', 'write_file', 'message_gezel'],
    });
    expect(msg).toContain('write_file');
    expect(msg).toContain('full file contents');
  });

  it('does not present write_artifact as the ship-code path', () => {
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'read_file',
      count: 5,
      registeredTools: ['read_file', 'write_artifact', 'message_gezel', 'ask_user_question'],
    });
    expect(msg).toContain('do not use `write_artifact`');
    expect(msg).toContain('artifacts are for plans/scratch');
    expect(msg).not.toContain('full file contents');
  });

  it('routes source-file read loops without workspace write access to a developer handoff', () => {
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'read_file',
      args: { path: 'index.html' },
      count: 5,
      registeredTools: [
        'read_file',
        'write_artifact',
        'message_gezel',
        'assign_task',
        'ask_user_question',
      ],
    });
    expect(msg).not.toMatch(/single action-tool call \([^)]*`write_artifact`/);
    expect(msg).toContain('do not have workspace write access');
    expect(msg).toContain('Hand off to a developer');
    expect(msg).toContain('message_gezel');
    expect(msg).toContain('assign_task');
  });

  it('rewrites the corrective for write-tool loops to say "do something DIFFERENT"', () => {
    // Wild-caught (nemotron-nano-30b tankcombat): the abort
    // message was contradictory for write_artifact loops — said "Stop
    // re-reading" but also "call write_artifact now with full contents."
    // Branch the wording on tool class so write loops point at validate/
    // hand-off/accept rather than at write_artifact itself.
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'write_artifact',
      count: 5,
      registeredTools: [
        'write_artifact',
        'message_gezel',
        'advance_task_step',
        'ask_user_question',
      ],
    });
    expect(msg).toContain('already written');
    expect(msg).toContain('DIFFERENT');
    expect(msg).not.toContain('Stop re-reading');
    // The looping tool itself must NOT be the suggested next action.
    expect(msg).not.toMatch(/MUST start[^.]*`write_artifact`/);
    // ... but other action tools should still be surfaced.
    expect(msg).toContain('message_gezel');
  });

  it('also covers write_file + replace_in_file under the write-loop branch', () => {
    for (const tool of ['apply_patch', 'make_dir']) {
      const msg = ToolRepeatTracker.buildAbortMessage({
        providerLabel: 'llama.cpp',
        toolName: tool,
        args: tool === 'write_file' ? { path: 'index.html' } : undefined,
        count: 5,
        registeredTools: [tool, 'message_gezel'],
      });
      expect(msg, `${tool} should hit write-loop branch`).toContain('already written');
      expect(msg, `${tool} should drop "Stop re-reading"`).not.toContain('Stop re-reading');
    }
  });

  it('routes source write_file + replace_in_file loops to a full-source corrective', () => {
    for (const tool of ['write_file', 'replace_in_file']) {
      const msg = ToolRepeatTracker.buildAbortMessage({
        providerLabel: 'llama.cpp',
        toolName: tool,
        args: { path: 'index.html' },
        count: 5,
        registeredTools: [tool, 'write_file', 'ask_user_question'],
      });
      expect(msg, `${tool} should hit source-edit branch`).toContain(
        'entire corrected source file',
      );
      expect(msg, `${tool} should not use generic write-loop branch`).not.toContain(
        'already written',
      );
    }
  });

  it('names the repeated write_file path in the hard-abort message', () => {
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'Mac AI',
      toolName: 'write_file',
      args: { path: 'script.js', content: 'latest' },
      count: 5,
      registeredTools: ['write_file', 'replace_in_file', 'read_file'],
    });
    expect(msg).toContain('same path `script.js` 5 times');
    expect(msg).toContain('Stop emitting fragments');
    expect(msg).not.toContain('same arguments 5 times');
  });

  it('uses a full-source corrective for repeated source edit loops', () => {
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'replace_in_file',
      args: { path: 'index.html', find: 'bad', replace: 'good' },
      count: 5,
      registeredTools: ['read_file', 'write_file', 'replace_in_file', 'ask_user_question'],
    });
    expect(msg).toContain('same path `index.html` 5 times');
    expect(msg).toContain('Stop emitting fragments');
    expect(msg).toContain('entire corrected source file');
    expect(msg).toContain('write_file({ path, content })');
    expect(msg).not.toContain('already written');
  });

  it('lets a named missing deliverable path take precedence over a source-edit loop', () => {
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'llama.cpp',
      toolName: 'replace_in_file',
      args: { path: 'server.mjs', find: 'bad', replace: 'good' },
      count: 5,
      registeredTools: ['read_file', 'write_file', 'replace_in_file', 'ask_user_question'],
    });
    expect(msg).toContain('different missing deliverable path');
    expect(msg).toContain('for that exact path');
    expect(msg).toContain('Otherwise');
    expect(msg).toContain('this same path');
  });

  it('falls back to the full suggestion list when the registered set is empty', () => {
    // Defensive: never collapse to zero suggestions.
    const msg = ToolRepeatTracker.buildAbortMessage({
      providerLabel: 'ollama',
      toolName: 'get_task',
      count: 5,
      registeredTools: [],
    });
    expect(msg).toMatch(/write_artifact|write_file/);
    expect(msg).toContain('message_gezel');
  });

  it('dedups `ensure_gezel` by jobTitle, ignoring other arg variations', () => {
    // Wild-caught (qwen3.6 27B tankcombat voorman): six calls
    // of `ensure_gezel` for "developer" in one turn, each varying a
    // free-text rationale (the since-removed `whyYouNeed` arg), so the
    // count per unique blurb stayed at 1 and the hard-abort never fired.
    // `whyYouNeed` is gone now, but the jobTitle-only key must still
    // collapse any remaining varying arg (here `preferredName`).
    const t = new ToolRepeatTracker();
    t.recordCall('ensure_gezel', { jobTitle: 'developer', preferredName: 'Ada' }, 'ok');
    t.recordCall('ensure_gezel', { jobTitle: 'developer', preferredName: 'Linus' }, 'ok');
    const soft = t.recordCall(
      'ensure_gezel',
      { jobTitle: 'developer', preferredName: 'Grace' },
      'ok',
    );
    expect(soft.count).toBe(3);
    expect(soft.output).toContain('3 times this turn');
    t.recordCall('ensure_gezel', { jobTitle: 'developer', preferredName: 'Alan' }, 'ok');
    const hard = t.recordCall(
      'ensure_gezel',
      { jobTitle: 'developer', preferredName: 'Edsger' },
      'ok',
    );
    expect(hard.count).toBe(5);
    expect(hard.shouldAbort).toBe(true);
  });

  it('treats different `ensure_gezel` jobTitles as distinct fingerprints', () => {
    // The normalizer must still see "designer" and "developer" as
    // separate calls — we don't want to abort a voorman who legitimately
    // needs two different roles back-to-back.
    const t = new ToolRepeatTracker();
    t.recordCall('ensure_gezel', { jobTitle: 'designer' }, 'ok');
    t.recordCall('ensure_gezel', { jobTitle: 'designer' }, 'ok');
    const r = t.recordCall('ensure_gezel', { jobTitle: 'developer' }, 'ok');
    expect(r.count).toBe(1);
    expect(r.shouldAbort).toBe(false);
  });

  it('buildUserMessage is plain — no provider prefix, no tool names, no "next message" imperatives', () => {
    const msg = ToolRepeatTracker.buildUserMessage();
    expect(msg).not.toContain('[');
    expect(msg).not.toContain('`');
    expect(msg).not.toMatch(/your next message/i);
    expect(msg.toLowerCase()).toContain('repeating');
  });

  it('buildAbort carries the model corrective on message and the user summary on userMessage', () => {
    const err = ToolRepeatTracker.buildAbort({
      providerLabel: 'ollama',
      toolName: 'read_task_notes',
      count: 5,
      registeredTools: [],
    });
    expect(err).toBeInstanceOf(TurnAbortError);
    expect(err.message).toContain('[ollama]');
    expect(err.message).toContain('read_task_notes');
    expect(err.userMessage).not.toContain('[ollama]');
    expect(err.userMessage).not.toContain('read_task_notes');
  });
});
