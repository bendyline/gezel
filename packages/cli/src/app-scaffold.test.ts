import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProjectTypeVersionManifestSchema,
  pageComponentsSource,
  projectTypeModelTools,
  projectTypePageReads,
  projectTypePageTools,
} from '@bendyline/gezel';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import { PAGE_DEMO_STUB } from './app-scaffold-demo.js';
import { scaffoldGezappSource } from './app-scaffold.js';

describe('app scaffold platform contracts', () => {
  it.each([false, true])('keeps the keeper tool model-visible (withPage=%s)', (withPage) => {
    const files = new Map(scaffoldGezappSource('field-notes', { withPage }));
    const root = 'items/project-types/fi/field-notes/versions/1.0.0';
    const manifest = ProjectTypeVersionManifestSchema.parse(
      JSON.parse(files.get(`${root}/manifest.json`)!),
    );
    expect(projectTypeModelTools(manifest).map((tool) => tool.name)).toEqual(['add_record']);
    expect(projectTypePageTools(manifest).map((tool) => tool.name)).toEqual(
      withPage ? ['page_add_record'] : [],
    );
    expect(projectTypePageReads(manifest)).toEqual(
      withPage ? [{ source: 'workspace', path: 'data.json', subtree: false }] : [],
    );
    if (withPage) {
      const [model, page] = manifest.tools!;
      expect(page).toEqual({ ...model, name: 'page_add_record' });
    }
    expect(
      files.get('items/gezel-templates/fi/field-notes-lead/versions/1.0.0/about.md'),
    ).toContain('add_record tool');
  });

  it('bundles the canonical Gilde demo stub without needing it at CLI runtime', async () => {
    // Gilde ships authoring/ in its published package, beside data/. No sibling checkout needed.
    const canonical = await readFile(
      join(gildeDataDir(), '../authoring/page-demo-stub.js'),
      'utf8',
    );
    expect(PAGE_DEMO_STUB).toBe(canonical.replace(/\r\n/g, '\n'));
    const files = scaffoldGezappSource('field-notes', { withPage: true });
    const html = files.find(([path]) => path.endsWith('/pages/dashboard/index.html'))![1];
    expect(html).toContain(`<script>\n${PAGE_DEMO_STUB}</script>`);
    expect(html).toContain(pageComponentsSource());
    expect(html).toContain('name="gezel-demo" content="standalone"');
    expect(files.some(([path]) => /\.(woff2?|ttf|otf)$/.test(path))).toBe(false);
  });
});
