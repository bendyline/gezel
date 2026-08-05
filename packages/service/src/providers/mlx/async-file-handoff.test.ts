import { describe, expect, it } from 'vitest';
import { isSuccessfulAsyncFileHandoff } from './provider.js';

describe('isSuccessfulAsyncFileHandoff', () => {
  const file = { expectedDeliverable: { kind: 'file', filePath: 'artifacts/deck.pptx' } };

  it('terminates after a successful role-typed delegate file handoff', () => {
    expect(isSuccessfulAsyncFileHandoff('delegate_builder', file, 'Hieu is on it.')).toBe(true);
  });

  it('keeps message_gezel file handoffs terminal', () => {
    expect(isSuccessfulAsyncFileHandoff('message_gezel', file, 'Queued for Hieu.')).toBe(true);
  });

  it('does not terminate for consultations, non-file work, or failed calls', () => {
    expect(isSuccessfulAsyncFileHandoff('consult_builder', file, 'Answer follows.')).toBe(false);
    expect(
      isSuccessfulAsyncFileHandoff(
        'delegate_builder',
        { expectedDeliverable: { kind: 'message' } },
        'Hieu is on it.',
      ),
    ).toBe(false);
    expect(isSuccessfulAsyncFileHandoff('delegate_builder', file, 'ERROR: no recipient')).toBe(
      false,
    );
  });

  it('accepts the stringified deliverable shape emitted by smaller models', () => {
    expect(
      isSuccessfulAsyncFileHandoff(
        'delegate_builder',
        { expectedDeliverable: JSON.stringify(file.expectedDeliverable) },
        'Hieu is on it.',
      ),
    ).toBe(true);
  });
});
