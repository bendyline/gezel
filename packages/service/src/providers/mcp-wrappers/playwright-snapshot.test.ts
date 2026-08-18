import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlaywrightSnapshotInliner } from './playwright-snapshot.js';
import type { McpToolWrapperContext } from './types.js';

describe('PlaywrightSnapshotInliner', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), 'playwright-snapshot-'));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function ctx(): McpToolWrapperContext {
    return {
      spec: { command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
      cwd: workDir,
      modelTier: 'large',
      isMeester: false,
      hasTool: () => false,
      callTool: async () => ({ text: '', images: [] }),
    };
  }

  it('matches @playwright/mcp servers', () => {
    expect(
      PlaywrightSnapshotInliner.matches({
        command: 'npx',
        args: ['@playwright/mcp@0.0.78'],
        env: {},
      }),
    ).toBe(true);
    expect(
      PlaywrightSnapshotInliner.matches({
        command: 'node',
        args: ['/path/to/playwright-mcp/dist/index.js'],
        env: {},
      }),
    ).toBe(true);
  });

  // Isolates the identity path: nothing in this command line hints at
  // Playwright, so only the stamped `toolsetId` can carry the match. Guards
  // the wrappers against any future change to the install-dir scheme.
  it('matches on the stamped toolset id when the command line has no hint', () => {
    expect(
      PlaywrightSnapshotInliner.matches({
        toolsetId: '@playwright/mcp',
        command: 'node',
        args: ['/opt/gezel/system-toolsets/browser/cli.js', '--headless'],
        env: {},
      }),
    ).toBe(true);
  });

  it('matches the slugified install path on an unstamped spec', () => {
    expect(
      PlaywrightSnapshotInliner.matches({
        command: 'node',
        args: ['/home/u/.gezel/system-toolsets/@playwright__mcp@0.0.78/package/cli.js'],
        env: {},
      }),
    ).toBe(true);
  });

  it('does not match non-playwright servers', () => {
    expect(
      PlaywrightSnapshotInliner.matches({
        command: 'node',
        args: ['some-other-mcp.js'],
        env: {},
      }),
    ).toBe(false);
    expect(
      PlaywrightSnapshotInliner.matches({
        toolsetId: 'docblocks',
        kind: 'http',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {},
      }),
    ).toBe(false);
  });

  it('inlines the snapshot file and DROPS the raw .playwright-mcp/ link', async () => {
    // The raw `[Snapshot](.playwright-mcp/...)` link used to be
    // preserved alongside the inlined YAML. The OutboardStorage
    // wrapper running after this one re-saves the inlined output to
    // a stable `auto/<tool>/...` path under the project's artifacts
    // root and surfaces THAT path in its summary. Keeping the raw
    // .playwright-mcp/ reference means the model sees TWO paths and
    // sometimes picks the wrong one for `grep_artifact` (which then
    // fails because that's not under the project's artifacts root).
    await fs.mkdir(join(workDir, '.playwright-mcp'), { recursive: true });
    const snapshotYaml = '- generic [ref=e1]:\n  - heading "Hello" [level=1] [ref=e2]';
    await fs.writeFile(join(workDir, '.playwright-mcp', 'page-1.yml'), snapshotYaml, 'utf-8');

    const text =
      '### Result\n- Navigated to https://example.com\n\n### Page\n- Page URL: https://example.com\n\n### Snapshot\n- [Snapshot](.playwright-mcp/page-1.yml)';
    const result = await PlaywrightSnapshotInliner.postProcess!(
      'browser_navigate',
      { url: 'https://example.com' },
      { text, images: [] },
      ctx(),
    );

    expect(result.text).not.toContain('.playwright-mcp/');
    expect(result.text).toContain('```yaml');
    expect(result.text).toContain('heading "Hello"');
    expect(result.text).toContain('```');
  });

  it('leaves the link untouched if the file does not exist', async () => {
    const text = '### Snapshot\n- [Snapshot](.playwright-mcp/missing.yml)';
    const result = await PlaywrightSnapshotInliner.postProcess!(
      'browser_navigate',
      {},
      { text, images: [] },
      ctx(),
    );
    expect(result.text).toBe(text);
  });

  it('truncates large snapshots and notes the truncation', async () => {
    await fs.mkdir(join(workDir, '.playwright-mcp'), { recursive: true });
    const big = 'a'.repeat(80_000);
    await fs.writeFile(join(workDir, '.playwright-mcp', 'page-2.yml'), big, 'utf-8');

    const text = '### Snapshot\n- [Snapshot](.playwright-mcp/page-2.yml)';
    const result = await PlaywrightSnapshotInliner.postProcess!(
      'browser_navigate',
      {},
      { text, images: [] },
      ctx(),
    );

    expect(result.text).toContain('snapshot truncated');
    expect(result.text.length).toBeLessThan(80_000);
  });

  it('is a no-op when the result has no snapshot link', async () => {
    const text = '### Result\n- Clicked the button';
    const result = await PlaywrightSnapshotInliner.postProcess!(
      'browser_click',
      {},
      { text, images: [] },
      ctx(),
    );
    expect(result.text).toBe(text);
  });

  it('handles multiple snapshot links in one response', async () => {
    await fs.mkdir(join(workDir, '.playwright-mcp'), { recursive: true });
    await fs.writeFile(join(workDir, '.playwright-mcp', 'a.yml'), 'first content', 'utf-8');
    await fs.writeFile(join(workDir, '.playwright-mcp', 'b.yml'), 'second content', 'utf-8');

    const text =
      '### Snapshot\n- [Snapshot](.playwright-mcp/a.yml)\n\n### Snapshot\n- [Snapshot](.playwright-mcp/b.yml)';
    const result = await PlaywrightSnapshotInliner.postProcess!(
      'browser_snapshot',
      {},
      { text, images: [] },
      ctx(),
    );
    expect(result.text).toContain('first content');
    expect(result.text).toContain('second content');
  });

  it('resolves absolute paths', async () => {
    const abs = join(workDir, 'absolute.yml');
    await fs.writeFile(abs, 'absolute snapshot', 'utf-8');
    const text = `### Snapshot\n- [Snapshot](${abs})`;
    const result = await PlaywrightSnapshotInliner.postProcess!(
      'browser_navigate',
      {},
      { text, images: [] },
      ctx(),
    );
    expect(result.text).toContain('absolute snapshot');
  });

  it('prepends interactive-element index and URL list before the aria tree', async () => {
    await fs.mkdir(join(workDir, '.playwright-mcp'), { recursive: true });
    const yaml = `- generic [ref=e1]:
  - link "Home" [ref=e10] [cursor=pointer]:
    - /url: https://example.com/
  - button "Search" [ref=e11] [cursor=pointer]
`;
    await fs.writeFile(join(workDir, '.playwright-mcp', 'page.yml'), yaml, 'utf-8');

    const text = '### Snapshot\n- [Snapshot](.playwright-mcp/page.yml)';
    const result = await PlaywrightSnapshotInliner.postProcess!(
      'browser_navigate',
      {},
      { text, images: [] },
      ctx(),
    );

    expect(result.text).toContain('#### Interactive elements (2)');
    expect(result.text).toContain('- link [e10] "Home"');
    expect(result.text).toContain('- button [e11] "Search"');
    expect(result.text).toContain('#### Links on this page (1)');
    expect(result.text).toContain('"Home" → https://example.com/ [e10]');
    expect(result.text).toContain('#### Aria tree');
    // Noise stripped from inlined yaml
    expect(result.text).not.toContain('[cursor=pointer]');
    // Order: interactive index → urls → aria tree
    const idxPos = result.text.indexOf('#### Interactive elements');
    const urlPos = result.text.indexOf('#### Links on this page');
    const treePos = result.text.indexOf('#### Aria tree');
    expect(idxPos).toBeGreaterThan(-1);
    expect(urlPos).toBeGreaterThan(idxPos);
    expect(treePos).toBeGreaterThan(urlPos);
  });

  it('omits the URL section when no urls are present', async () => {
    await fs.mkdir(join(workDir, '.playwright-mcp'), { recursive: true });
    await fs.writeFile(
      join(workDir, '.playwright-mcp', 'plain.yml'),
      '- heading "Hello" [level=1] [ref=e2]',
      'utf-8',
    );
    const text = '### Snapshot\n- [Snapshot](.playwright-mcp/plain.yml)';
    const result = await PlaywrightSnapshotInliner.postProcess!(
      'browser_navigate',
      {},
      { text, images: [] },
      ctx(),
    );
    expect(result.text).not.toContain('#### Links on this page');
    expect(result.text).not.toContain('#### Interactive elements');
    expect(result.text).toContain('#### Aria tree');
  });

  it('preserves images unchanged', async () => {
    const text = '### Result\nNo snapshot';
    const images = [{ base64: 'AAAA', mimeType: 'image/png' }];
    const result = await PlaywrightSnapshotInliner.postProcess!(
      'browser_take_screenshot',
      {},
      { text, images },
      ctx(),
    );
    expect(result.images).toEqual(images);
  });
});
