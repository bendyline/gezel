import { describe, expect, it } from 'vitest';
import { portableContentPlugin } from '../scripts/portable-content.js';

describe('bundled offline catalog', () => {
  it('ships canonical crew and text workflows without offering unavailable media or integrations', async () => {
    const plugin = portableContentPlugin();
    const load = typeof plugin.load === 'function' ? plugin.load : plugin.load!.handler;
    const raw = await load.call({} as never, '\0virtual:gezel-portable-content');
    const content = JSON.parse(
      String(raw)
        .replace(/^export default /, '')
        .replace(/;$/, ''),
    );
    expect(content.models.length).toBeGreaterThan(0);
    for (const model of content.models) {
      expect(model.source.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(model.source.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(model.approxSizeBytes).toBeLessThanOrEqual(4 * 1024 ** 3);
      expect(model.source).not.toHaveProperty('sizeBytes');
    }
    expect(content.templates.length).toBeGreaterThan(0);
    const ids = content.craftbooks.map((item: { book: { id: string } }) => item.book.id);
    expect(ids).toContain('tone-rewrite');
    expect(ids).not.toContain('audio-ad-spot');
    expect(ids).not.toContain('thumbnail-generator');
    expect(ids).not.toContain('booking-automation');
    expect(ids).not.toContain('dockerize-app');
  });
});
