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
    expect(reason).toContain('paused');
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
    // itself and pause. Blocking these would leave it no legal move.
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
