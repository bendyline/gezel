import { describe, expect, it } from 'vitest';
import { CAP, PartialEditRegistry } from './partial-edits.js';

describe('PartialEditRegistry', () => {
  it('opens a draft on the first provisional edit and keeps that snapshot', () => {
    const reg = new PartialEditRegistry();
    const first = reg.record('index.html', '<html>good</html>');
    expect(first.edits).toBe(1);
    expect(first.snapshot).toBe('<html>good</html>');

    const second = reg.record('index.html', '<html>half-written</html>');
    expect(second.edits).toBe(2);
    // The snapshot is the pre-sequence state, never the previous
    // provisional step — restoring to a broken draft is not a recovery.
    expect(second.snapshot).toBe('<html>good</html>');
  });

  it('tracks drafts per path', () => {
    const reg = new PartialEditRegistry();
    reg.record('a.html', 'a');
    reg.record('b.js', 'b');
    expect(reg.openPaths()).toEqual(['a.html', 'b.js']);
    expect(reg.isOpen('a.html')).toBe(true);
    expect(reg.isOpen('c.css')).toBe(false);
  });

  it('closes a draft and returns it', () => {
    const reg = new PartialEditRegistry();
    reg.record('index.html', 'original');
    const closed = reg.close('index.html');
    expect(closed?.snapshot).toBe('original');
    expect(reg.isOpen('index.html')).toBe(false);
    expect(reg.close('index.html')).toBeUndefined();
  });

  describe('blockReason', () => {
    it('is null when nothing is in draft', () => {
      const reg = new PartialEditRegistry();
      expect(reg.blockReason('advance_task_step')).toBeNull();
    });

    it('blocks advance_task_step and verify_outcome while a draft is open', () => {
      const reg = new PartialEditRegistry();
      reg.record('index.html', 'x');
      expect(reg.blockReason('advance_task_step')).toContain('index.html');
      expect(reg.blockReason('verify_outcome')).toContain('index.html');
    });

    it('leaves set_task_status open so a stuck gezel can still pause', () => {
      const reg = new PartialEditRegistry();
      reg.record('index.html', 'x');
      expect(reg.blockReason('set_task_status')).toBeNull();
      expect(reg.blockReason('write_task_note')).toBeNull();
      expect(reg.blockReason('validate')).toBeNull();
    });

    it('names every open path and how to close the sequence', () => {
      const reg = new PartialEditRegistry();
      reg.record('index.html', 'x');
      reg.record('game.js', 'y');
      const reason = reg.blockReason('advance_task_step')!;
      expect(reason).toContain('`game.js`');
      expect(reason).toContain('`index.html`');
      expect(reason).toMatch(/omits `partial`/);
      expect(reason).toContain('write_file');
    });

    it('stops blocking once the draft closes', () => {
      const reg = new PartialEditRegistry();
      reg.record('index.html', 'x');
      reg.close('index.html');
      expect(reg.blockReason('advance_task_step')).toBeNull();
    });
  });

  describe('noticeFor', () => {
    it('states the edit count and how to close', () => {
      const reg = new PartialEditRegistry();
      const notice = reg.noticeFor(reg.record('index.html', 'x'));
      expect(notice).toContain(`1 of at most ${CAP}`);
      expect(notice).toContain('was NOT syntax-checked');
      expect(notice).toContain('validate({ path: "index.html" })');
    });

    it('warns as the cap approaches', () => {
      const reg = new PartialEditRegistry();
      let draft = reg.record('index.html', 'x');
      for (let i = 1; i < CAP - 2; i++) draft = reg.record('index.html', 'x');
      expect(reg.noticeFor(draft)).toMatch(/Only \d+ provisional edit\(s\) remain/);
    });

    it('says nothing about the cap while there is room', () => {
      const reg = new PartialEditRegistry();
      expect(reg.noticeFor(reg.record('index.html', 'x'))).not.toMatch(/remain/);
    });
  });
});
