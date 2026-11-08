import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderAppGuide } from './app-guide.js';

const contentDir = fileURLToPath(new URL('../../../docs/handboek', import.meta.url));

describe('renderAppGuide', () => {
  it('prints the loop, the rules and the four guides in full', async () => {
    const guide = await renderAppGuide({ contentDir });
    expect(guide.startsWith('# Build a Gezel app: the complete guide\n')).toBe(true);
    expect(guide).toContain('gezel app validate <folder> --json');
    for (const title of [
      'Building AI Apps inside Gezel',
      'Using the Gezel page APIs',
      'Gezel app page style guide',
      'Gezel app UX guide',
    ]) {
      expect(guide).toContain(`\n## ${title}\n`);
    }
  });

  it('points every Handboek link at gezel.com, since it is read away from the site', async () => {
    const guide = await renderAppGuide({ contentDir });
    expect(guide).toContain('](https://gezel.com/docs/gezel-page-apis/');
    expect(guide).not.toMatch(/\]\((?!https?:|#)[^)]*\.md[#)]/);
  });
});
