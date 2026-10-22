import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { siteDeviceInfo } from './device.js';
import { createHandboekEngine } from './engine.js';
import { handboekKnowledgeSource, rewriteHandboekKnowledgeLinks } from './knowledge-source.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Handboek knowledge source', () => {
  it('bundles media while linking website-only downloads to their published URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-handboek-knowledge-'));
    roots.push(root);
    const files = {
      'technical/report.md': [
        '# Report',
        '![Chart](../assets/results/chart.PNG)',
        '[Recording](../assets/results/recording.mp3)',
        '[Data](../assets/results/manifest.json?download=1#results)',
        '[Notes](../assets/results/README.md)',
        '[Guide](guide.md#details)',
      ].join('\n\n'),
      'technical/guide.md': '# Guide\n\n## Details\n',
      'assets/results/chart.PNG': 'image bytes',
      'assets/results/recording.mp3': 'audio bytes',
      'assets/results/manifest.json': '{}',
      'assets/results/README.md': '# Download notes',
      'assets/.DS_Store': 'metadata',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const engine = createHandboekEngine({
      contentDir: root,
      catalog: { list: async () => [], get: async () => null },
      device: siteDeviceInfo,
    });
    const source = await handboekKnowledgeSource(engine, root);

    expect(source.assets.map((asset) => asset.path)).toEqual([
      'assets/results/chart.PNG',
      'assets/results/recording.mp3',
    ]);
    expect(source.assets.every((asset) => asset.absPath === join(root, asset.path))).toBe(true);
    const report = source.documents.find((document) => document.id === 'report')!;
    expect(report.markdown).toContain('![Chart](assets/results/chart.PNG)');
    expect(report.markdown).toContain('[Recording](assets/results/recording.mp3)');
    expect(report.markdown).toContain(
      '[Data](https://gezel.com/docs/assets/results/manifest.json?download=1#results)',
    );
    expect(report.markdown).toContain('[Notes](https://gezel.com/docs/assets/results/README.md)');
    expect(report.markdown).toContain('[Guide](knowledge://bendyline/handboek/guide#details)');
  });

  it('leaves external links, anchors, and fenced examples untouched', () => {
    const markdown = [
      '[External](https://example.com/assets/data.json)',
      '[CDN](//example.com/assets/chart.png)',
      '[Section](#details)',
      '```markdown',
      '[Data](../assets/results/manifest.json)',
      '![Chart](../assets/results/chart.png)',
      '```',
    ].join('\n');
    expect(
      rewriteHandboekKnowledgeLinks(markdown, 'technical', new Set(), new Map(), new Map()),
    ).toBe(markdown);
  });
});
