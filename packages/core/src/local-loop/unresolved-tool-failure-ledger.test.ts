import { describe, expect, it } from 'vitest';
import {
  UnresolvedToolFailureLedger,
  isValidationFailure,
} from './unresolved-tool-failure-ledger.js';

/** The exact model-facing text from the incident, post error-translation. */
const CONVERT_REJECTION =
  'ERROR: `convert_document` rejected by validator. Wrong type: `source` (got string, expected object), ' +
  '`targets` (got string, expected array). Retry the call with all listed fields supplied.';

describe('isValidationFailure', () => {
  it('recognizes argument rejections in both raw and translated form', () => {
    expect(isValidationFailure(CONVERT_REJECTION)).toBe(true);
    expect(
      isValidationFailure(
        'MCP error -32602: Input validation error: Invalid arguments for tool x: []',
      ),
    ).toBe(true);
    expect(
      isValidationFailure(
        'ERROR: `convert_document` received `source` as JSON text instead of a real object/array.',
      ),
    ).toBe(true);
  });

  it("ignores failures that are not the model's to fix", () => {
    // Blocking on these would wedge legitimate work: none of them mean
    // "your arguments were wrong".
    expect(isValidationFailure('MCP error -32001: Request timed out')).toBe(false);
    expect(isValidationFailure('Write failed: fetch failed')).toBe(false);
    expect(isValidationFailure('ERROR: permission denied for path /etc/passwd')).toBe(false);
  });
});

describe('UnresolvedToolFailureLedger', () => {
  it('blocks advance_task_step after a repeated identical validation failure', () => {
    const ledger = new UnresolvedToolFailureLedger();
    // One failure is a mistake; advancing is still allowed.
    ledger.record('convert_document', CONVERT_REJECTION, true);
    expect(ledger.blockReason('advance_task_step')).toBeNull();

    // The second identical rejection means the correction changed nothing.
    ledger.record('convert_document', CONVERT_REJECTION, true);
    const reason = ledger.blockReason('advance_task_step');
    expect(reason).toContain('`convert_document` (2× identical)');
    expect(reason).toContain('EARLIER attempt does not satisfy this step');
    // Both legal exits are spelled out, so the model is not left stuck.
    expect(reason).toContain('Fix the failing call');
    expect(reason).toContain('record the blocker with `write_task_note`');
    expect(reason).toContain('end your turn');
    // Never steer a step session to pause itself: it cannot resume its own
    // paused task, and advance_task_step refuses a paused one.
    expect(reason).not.toContain('set_task_status');
    expect(reason).not.toMatch(/\bpause/i);
  });

  it('names the note tool only when the session can call it', () => {
    const noNotes = new UnresolvedToolFailureLedger({
      hasTool: (name) => name !== 'write_task_note',
    });
    noNotes.record('convert_document', CONVERT_REJECTION, true);
    noNotes.record('convert_document', CONVERT_REJECTION, true);
    const reason = noNotes.blockReason('advance_task_step');
    expect(reason).not.toContain('write_task_note');
    expect(reason).toContain('state the blocker in your reply');
    expect(reason).toContain('end your turn');

    const withNotes = new UnresolvedToolFailureLedger({ hasTool: () => true });
    withNotes.record('convert_document', CONVERT_REJECTION, true);
    withNotes.record('convert_document', CONVERT_REJECTION, true);
    expect(withNotes.blockReason('advance_task_step')).toContain('`write_task_note`');
  });

  it('unblocks as soon as the tool actually succeeds', () => {
    const ledger = new UnresolvedToolFailureLedger();
    ledger.record('convert_document', CONVERT_REJECTION, true);
    ledger.record('convert_document', CONVERT_REJECTION, true);
    expect(ledger.blockReason('advance_task_step')).not.toBeNull();

    ledger.record('convert_document', 'docblocks://artifacts/f7c561a6', false);
    expect(ledger.blockReason('advance_task_step')).toBeNull();
    expect(ledger.unresolved()).toEqual([]);
  });

  it('restarts the count when the model produces a DIFFERENT validation error', () => {
    // Changing the error is progress — the model altered something real.
    // Accumulating across distinct problems would block a gezel that is
    // actively working through a multi-field schema.
    const ledger = new UnresolvedToolFailureLedger();
    ledger.record('convert_document', CONVERT_REJECTION, true);
    ledger.record(
      'convert_document',
      'ERROR: `convert_document` rejected by validator. Missing required fields: `targets`.',
      true,
    );
    expect(ledger.blockReason('advance_task_step')).toBeNull();
  });

  it('does not block on transport faults, however many times they repeat', () => {
    const ledger = new UnresolvedToolFailureLedger();
    for (let i = 0; i < 5; i++) {
      ledger.record('convert_document', 'MCP error -32001: Request timed out', true);
    }
    expect(ledger.blockReason('advance_task_step')).toBeNull();
  });

  it('only gates step completion — never the honest exits', () => {
    const ledger = new UnresolvedToolFailureLedger();
    ledger.record('convert_document', CONVERT_REJECTION, true);
    ledger.record('convert_document', CONVERT_REJECTION, true);
    // A gezel that cannot make a tool work must still be able to explain
    // itself, and the user or a coordinator must still be able to pause.
    expect(ledger.blockReason('write_task_note')).toBeNull();
    expect(ledger.blockReason('set_task_status')).toBeNull();
    expect(ledger.blockReason('read_task_notes')).toBeNull();
    expect(ledger.blockReason('convert_document')).toBeNull();
  });

  it('tracks each tool separately', () => {
    const ledger = new UnresolvedToolFailureLedger();
    ledger.record('convert_document', CONVERT_REJECTION, true);
    ledger.record(
      'save_artifact',
      'ERROR: `save_artifact` rejected by validator. Wrong type: `destination`.',
      true,
    );
    expect(ledger.blockReason('advance_task_step')).toBeNull();
    ledger.record(
      'save_artifact',
      'ERROR: `save_artifact` rejected by validator. Wrong type: `destination`.',
      true,
    );
    expect(ledger.blockReason('advance_task_step')).toContain('`save_artifact`');
  });

  it('honors a custom threshold and gated-tool set', () => {
    const ledger = new UnresolvedToolFailureLedger({
      repeatThreshold: 3,
      gatedTools: ['set_task_status'],
    });
    ledger.record('convert_document', CONVERT_REJECTION, true);
    ledger.record('convert_document', CONVERT_REJECTION, true);
    expect(ledger.blockReason('set_task_status')).toBeNull();
    ledger.record('convert_document', CONVERT_REJECTION, true);
    expect(ledger.blockReason('set_task_status')).not.toBeNull();
    expect(ledger.blockReason('advance_task_step')).toBeNull();
  });
});

describe('UnresolvedToolFailureLedger: a failed save holds the advance behind it', () => {
  // squisq/38, 2026-11-09: the factual-writing check refused the step's
  // write_artifact, and the advance queued behind it in the same batch spent
  // a gate attempt on a file that was never written.
  const REFUSAL =
    'Not saved: 6 sentences state facts that no evidence in this conversation shows.\n- "**Current State**: …" cites nothing.';
  const audit = { path: 'tasks/38/audit.md', content: '# Audit' };

  it('holds one advance, naming the save and why it failed', () => {
    const ledger = new UnresolvedToolFailureLedger();
    ledger.record('write_artifact', REFUSAL, true, audit);
    const held = ledger.blockReason('advance_task_step');
    expect(held).toContain('`advance_task_step` was not run');
    expect(held).toContain(
      '- `write_artifact` of `tasks/38/audit.md`: Not saved: 6 sentences state facts',
    );
    expect(held).not.toContain('Current State');
    expect(ledger.blockReason('write_task_note')).toBeNull();
    // Seen once, the choice is the model's: the step gate judges the next one.
    expect(ledger.blockReason('advance_task_step')).toBeNull();
  });

  it('lets the advance through once the same target saves', () => {
    const ledger = new UnresolvedToolFailureLedger();
    ledger.record('write_artifact', REFUSAL, true, audit);
    ledger.record('write_artifact', 'Saved tasks/38/audit.md', false, audit);
    expect(ledger.blockReason('advance_task_step')).toBeNull();
  });

  it('keeps the hold when only a different file saved', () => {
    const ledger = new UnresolvedToolFailureLedger();
    ledger.record('write_artifact', REFUSAL, true, audit);
    ledger.record('write_artifact', 'Saved', false, { path: 'tasks/38/notes.md' });
    expect(ledger.blockReason('advance_task_step')).toContain('`tasks/38/audit.md`');
  });

  it('holds once per target until it saves, so a save that cannot work never traps the step', () => {
    const ledger = new UnresolvedToolFailureLedger();
    const denied = 'ERROR: this project does not allow workspace writes';
    ledger.record('write_file', denied, true, { path: 'notes.md' });
    expect(ledger.blockReason('advance_task_step')).not.toBeNull();
    ledger.record('write_file', denied, true, { path: 'notes.md' });
    expect(ledger.blockReason('advance_task_step')).toBeNull();
    // A success re-arms it: the next failure there is news again.
    ledger.record('write_file', 'Wrote notes.md', false, { path: 'notes.md' });
    ledger.record('write_file', denied, true, { path: 'notes.md' });
    expect(ledger.blockReason('advance_task_step')).not.toBeNull();
  });

  it('names a save with no path by its tool, and ignores failures of tools that save nothing', () => {
    const ledger = new UnresolvedToolFailureLedger();
    ledger.record('read_file', 'ERROR: file not found', true, { path: 'a.md' });
    expect(ledger.blockReason('advance_task_step')).toBeNull();
    ledger.record('write_task_note', 'ERROR: stale step', true, { ref: 'p/1', text: 'x' });
    expect(ledger.blockReason('advance_task_step')).toContain('- `write_task_note`: ERROR: stale');
  });

  it('puts the repeated-failure block first and keeps the hold for later', () => {
    const ledger = new UnresolvedToolFailureLedger();
    ledger.record('write_artifact', REFUSAL, true, audit);
    ledger.record('convert_document', CONVERT_REJECTION, true);
    ledger.record('convert_document', CONVERT_REJECTION, true);
    expect(ledger.blockReason('advance_task_step')).toContain('unresolved tool failure');
    ledger.record('convert_document', 'docblocks://artifacts/1', false);
    expect(ledger.blockReason('advance_task_step')).toContain('`tasks/38/audit.md`');
  });
});
