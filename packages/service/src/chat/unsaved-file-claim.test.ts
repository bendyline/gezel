import { describe, expect, it } from 'vitest';
import { detectUnsavedFileClaim } from './unsaved-file-claim.js';

describe('detectUnsavedFileClaim — completion, modify, and draft-save claims', () => {
  // The exact phrasings Laxmi used that the write-verb patterns missed.
  it('catches "The deliverable `workspace/index.html` is in place"', () => {
    const r = detectUnsavedFileClaim(
      'The deliverable `workspace/index.html` is in place and fully playable.',
      [],
    );
    expect(r).toEqual({ claimedPath: 'workspace/index.html', kind: 'exists' });
  });

  it('catches "`index.html` exists and meets all mission objectives"', () => {
    const r = detectUnsavedFileClaim('`index.html` exists and meets all mission objectives.', []);
    expect(r?.kind).toBe('exists');
    expect(r?.claimedPath).toBe('index.html');
  });

  it('catches "delivered `index.html`"', () => {
    const r = detectUnsavedFileClaim('I have delivered `index.html` to the workspace.', []);
    expect(r?.claimedPath).toBe('index.html');
  });

  it('still catches the original write-verb claims as kind "wrote"', () => {
    const r = detectUnsavedFileClaim('I saved the report to `review.md` just now.', []);
    expect(r).toEqual({ claimedPath: 'review.md', kind: 'wrote' });
  });

  it('does NOT fire on a retraction ("the file was NOT created")', () => {
    expect(
      detectUnsavedFileClaim('The file `index.html` was NOT created — I could not write it.', []),
    ).toBeNull();
  });

  it('does NOT fire when a successful write_file landed this turn', () => {
    expect(
      detectUnsavedFileClaim('`index.html` is complete and ready.', [
        { id: '1', name: 'write_file', success: true } as never,
      ]),
    ).toBeNull();
  });

  it('does NOT fire when a Codex native shell edit landed this turn', () => {
    expect(
      detectUnsavedFileClaim('Updated `index.html` for Phase 2.', [
        { id: '1', name: 'shell', success: true } as never,
      ]),
    ).toBeNull();
  });

  it('does NOT fire when write_file saved an invalid first draft for repair', () => {
    expect(
      detectUnsavedFileClaim('I wrote `index.html` to the workspace.', [
        {
          name: 'write_file',
          durationMs: 12,
          success: false,
          errorMessage:
            'inline JS does not parse (Unexpected token ]).\n\nInvalid first draft index.html was saved anyway so you can continue with read_file({ path: "index.html" }) and then repair it with replace_in_file(...) instead of starting over.',
        } as never,
      ]),
    ).toBeNull();
  });

  it('does not match bare completion prose without a quoted file path', () => {
    expect(detectUnsavedFileClaim('The project is complete and ready to play.', [])).toBeNull();
  });

  // Modify/edit claims — the family save + completion patterns miss. The
  // load-bearing case (qwen3.6 developer "Space Shooter Arcade"):
  // "I have updated the game logic in `index.html`" after only a read_file.
  it('catches "I have updated the game logic in `workspace/index.html`" as kind "modified"', () => {
    const r = detectUnsavedFileClaim(
      'I have updated the game logic in `workspace/index.html`.\n\nThe file is located at `workspace/index.html`.',
      [{ id: '1', name: 'read_file', success: true } as never],
    );
    expect(r).toEqual({ claimedPath: 'workspace/index.html', kind: 'modified' });
  });

  it('catches "applied the change to `index.html`" as kind "modified"', () => {
    const r = detectUnsavedFileClaim('I applied the change to `index.html` as requested.', []);
    expect(r?.kind).toBe('modified');
    expect(r?.claimedPath).toBe('index.html');
  });

  it('does NOT fire on a modify claim backed by a successful replace_in_file', () => {
    expect(
      detectUnsavedFileClaim('I modified the scoring logic in `index.html`.', [
        { id: '1', name: 'replace_in_file', success: true } as never,
      ]),
    ).toBeNull();
  });

  it('DOES fire on a modify claim when the replace_in_file FAILED', () => {
    const r = detectUnsavedFileClaim('I updated `index.html` with the new penalty.', [
      { id: '1', name: 'replace_in_file', success: false } as never,
    ]);
    expect(r?.kind).toBe('modified');
  });

  it('does NOT fire on a modify retraction ("could not apply the change")', () => {
    expect(
      detectUnsavedFileClaim(
        'I was unable to update `index.html` — the snippet to replace was not found.',
        [],
      ),
    ).toBeNull();
  });
});
