import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { describe, expect, it } from 'vitest';
import {
  chooseOutsideInSource,
  importOutsideInDocument,
  isOutsideInMarkdownEditingEnabled,
  renderOutsideInDocument,
  resolveOutsideInLayout,
  withOutsideInMarkdownEditing,
} from './outside-in.js';

describe('outside-in project documents', () => {
  it('maps a rendered filename to its hidden editable companion', () => {
    const layout = resolveOutsideInLayout('decks/Tucson.pptx');
    expect(layout).toMatchObject({
      targetPath: 'decks/Tucson.pptx',
      format: 'pptx',
      companionDirectory: 'decks/Tucson_files',
      markdownPath: 'decks/Tucson_files/tucson.md',
      backupPath: 'decks/Tucson_files/.original/original.pptx',
    });
    expect(chooseOutsideInSource(layout!, ['decks/Tucson_files/hand-authored.md'])).toBe(
      'decks/Tucson_files/hand-authored.md',
    );
  });

  it('imports HTML into linked Markdown and exports against the shared player', async () => {
    const layout = resolveOutsideInLayout('history/battle-of-britain.html')!;
    const imported = await importOutsideInDocument(
      new TextEncoder().encode('<h1>Battle of Britain</h1>'),
      layout,
    );
    expect(imported.markdown).toContain('squisq-output: ../battle-of-britain.html');
    expect(imported.markdown).toContain('# Battle of Britain');
    expect(isOutsideInMarkdownEditingEnabled(imported.markdown)).toBe(false);

    const rendered = await renderOutsideInDocument(
      withOutsideInMarkdownEditing(`${imported.markdown}\n\n![Map](map.png)\n`, layout),
      layout,
      new MemoryContentContainer(),
      '../_squisq/squisq-player.js',
    );
    const html = new TextDecoder().decode(rendered.bytes);
    expect(html).toContain('<script src="../_squisq/squisq-player.js"></script>');
    expect(html).toContain('battle-of-britain_files/map.png');
  });
});
