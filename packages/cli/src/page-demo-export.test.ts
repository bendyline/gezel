import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectPageDemo, pageDemoBootstrapSource } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { runAppDemo, runAppNew } from './app-author-command.js';
import { PAGE_DEMO_STUB } from './app-scaffold-demo.js';
import { writePageDemo, writePageDemoAssets } from './page-demo-export.js';

describe('generated page demos', () => {
  it('injects before app scripts, preserves charset, escapes configuration and removes the legacy adapter', () => {
    const html = `<html><head><meta charset="utf-8"><script>${PAGE_DEMO_STUB}</script><script>makeDemoGezel({})</script></head></html>`;
    const result = injectPageDemo(
      html,
      { imports: [{ id: 'test', source: 'workspace', path: '</script><script>bad()</script>' }] },
      { scriptUrl: '../bootstrap.js', styleUrl: '../fonts.css' },
    );
    expect(result).not.toContain(PAGE_DEMO_STUB);
    expect(result.indexOf('charset=')).toBeLessThan(result.indexOf('data-gezel-typography'));
    expect(result.indexOf('src="../bootstrap.js"')).toBeLessThan(result.indexOf('makeDemoGezel'));
    expect(result).not.toContain('<script>bad()');
    expect(() => injectPageDemo(result, {}, { scriptUrl: '', styleUrl: '' })).toThrow(
      'already bootstrapped',
    );
  });

  it('shares hashed assets across nested site pages and preserves app bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-demo-site-'));
    try {
      const shared = {
        directory: join(dir, '_gezel-demo'),
        assets: await writePageDemoAssets(join(dir, '_gezel-demo')),
      };
      const files = [
        { path: 'nested/index.html', bytes: Buffer.from('<head></head>') },
        { path: 'app.js', bytes: Buffer.from('app code') },
      ];
      await writePageDemo(join(dir, 'project-type/a/demo'), files, {}, shared);
      await writePageDemo(join(dir, 'project-type/b/demo'), files, {}, shared);
      const html = await readFile(join(dir, 'project-type/a/demo/nested/index.html'), 'utf8');
      expect(html).toMatch(/\.\.\/\.\.\/\.\.\/\.\.\/_gezel-demo\/bootstrap-[a-f0-9]{16}\.js/);
      expect(await readFile(join(dir, 'project-type/a/demo/app.js'), 'utf8')).toBe('app code');
      expect(shared.assets[0]!.bytes.toString()).toBe(pageDemoBootstrapSource());
      expect(shared.assets[1]!.bytes.toString()).toContain('data:font/woff2;base64,');
      await expect(
        writePageDemo(dir, [{ path: '../escape', bytes: Buffer.from('') }], {}, shared),
      ).rejects.toThrow('Unsafe');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports a private app without modifying its source or overwriting a destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-demo-app-'));
    try {
      await runAppNew('field-notes', { dir, withPage: true });
      const source = join(dir, 'field-notes');
      const entry = join(
        source,
        'items/project-types/fi/field-notes/versions/1.0.0/pages/dashboard/index.html',
      );
      const before = await readFile(entry, 'utf8');
      await runAppDemo(source, { out: join(dir, 'demo') });
      expect(await readFile(entry, 'utf8')).toBe(before);
      const output = await readFile(join(dir, 'demo/pages/dashboard/index.html'), 'utf8');
      expect(output).toContain('id="gezel-demo-config"');
      expect(output).toContain('../../_gezel-demo/bootstrap-');
      await expect(runAppDemo(source, { out: source })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
