import { describe, expect, it } from 'vitest';
import { SAVE_COPY_NAME_MAX_LENGTH, saveCopyFileName } from './save-copy-name.js';

describe('saveCopyFileName', () => {
  it("names the copy by the work's title, with the file's own extension", () => {
    expect(
      saveCopyFileName(
        "One-page catering proposal for Harbor Books' holiday party",
        'tasks/2/report.docx',
      ),
    ).toBe("One-page catering proposal for Harbor Books' holiday party.docx");
  });

  it('takes out what a file name cannot carry', () => {
    expect(saveCopyFileName('Q3: plan/review "final" <v2>?', 'tasks/4/report.pdf')).toBe(
      'Q3 plan review final v2.pdf',
    );
    expect(saveCopyFileName('Notes for Mr. Ito. ', 'notes.md')).toBe('Notes for Mr. Ito.md');
  });

  it('keeps the title to 80 characters and never ends it on a dot or a space', () => {
    const name = saveCopyFileName(`${'A long title '.repeat(10)}`, 'tasks/1/deck.pptx')!;
    const stem = name.slice(0, -'.pptx'.length);
    expect(stem.length).toBeLessThanOrEqual(SAVE_COPY_NAME_MAX_LENGTH);
    expect(stem).not.toMatch(/[. ]$/);
    expect(name.endsWith('.pptx')).toBe(true);
  });

  it('gives the same name when run again on its own result', () => {
    const once = saveCopyFileName('Price list as a PDF', 'tasks/2/report.pdf')!;
    expect(once).toBe('Price list as a PDF.pdf');
    expect(saveCopyFileName(once, 'tasks/2/report.pdf')).toBe(once);
    // A Windows path from the desktop shell reads the same.
    expect(saveCopyFileName(once, 'tasks\\2\\report.pdf')).toBe(once);
  });

  it('leaves the base name to the caller when nothing nameable is left', () => {
    expect(saveCopyFileName(undefined, 'tasks/2/report.pdf')).toBeUndefined();
    expect(saveCopyFileName(' ..:/ ', 'tasks/2/report.pdf')).toBeUndefined();
  });
});
