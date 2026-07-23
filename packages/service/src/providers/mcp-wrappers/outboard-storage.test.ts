import { describe, expect, it, vi } from 'vitest';
import { OutboardStorage, buildOutboardSummary } from './outboard-storage.js';
import type { McpToolResult, McpToolWrapperContext } from './types.js';

function makeCtx(opts?: {
  writeArtifact?: McpToolWrapperContext['writeArtifact'];
}): McpToolWrapperContext {
  return {
    spec: { command: 'node', args: [], env: {} },
    cwd: '/tmp',
    modelTier: 'medium',
    isMeester: false,
    hasTool: () => false,
    callTool: async () => ({ text: '', images: [] }),
    ...(opts?.writeArtifact ? { writeArtifact: opts.writeArtifact } : {}),
  };
}

const SMALL = 'short result';
// 5K of content — well above the MIN_OUTBOARD_BYTES (2K) gate.
const LARGE = 'page-root\n  '.repeat(500);

describe('OutboardStorage — gating', () => {
  it('skips tools not in the allowlist', async () => {
    const writeArtifact = vi.fn();
    const result: McpToolResult = { text: LARGE, images: [] };
    const out = await OutboardStorage.postProcess!(
      'list_projects',
      {},
      result,
      makeCtx({ writeArtifact }),
    );
    expect(out).toBe(result);
    expect(writeArtifact).not.toHaveBeenCalled();
  });

  it('skips when output is below MIN_OUTBOARD_BYTES', async () => {
    const writeArtifact = vi.fn();
    const result: McpToolResult = { text: SMALL, images: [] };
    const out = await OutboardStorage.postProcess!(
      'browser_snapshot',
      {},
      result,
      makeCtx({ writeArtifact }),
    );
    expect(out).toBe(result);
    expect(writeArtifact).not.toHaveBeenCalled();
  });

  it('skips when ctx.writeArtifact is not provided (degrades to passthrough)', async () => {
    const result: McpToolResult = { text: LARGE, images: [] };
    const out = await OutboardStorage.postProcess!('browser_snapshot', {}, result, makeCtx());
    expect(out).toBe(result);
  });

  it('passes through unchanged when persister throws', async () => {
    const writeArtifact = vi.fn(async () => {
      throw new Error('disk full');
    });
    const result: McpToolResult = { text: LARGE, images: [] };
    const out = await OutboardStorage.postProcess!(
      'browser_snapshot',
      {},
      result,
      makeCtx({ writeArtifact }),
    );
    expect(writeArtifact).toHaveBeenCalledOnce();
    expect(out).toBe(result);
  });
});

describe('OutboardStorage — successful persistence', () => {
  it('writes the full payload and returns a summary + path', async () => {
    let savedPath = '';
    let savedContent = '';
    const writeArtifact = vi.fn(async (path: string, content: string) => {
      savedPath = path;
      savedContent = content;
    });
    const result: McpToolResult = { text: LARGE, images: [] };
    const out = await OutboardStorage.postProcess!(
      'browser_snapshot',
      {},
      result,
      makeCtx({ writeArtifact }),
    );
    expect(savedContent).toBe(LARGE);
    expect(savedPath).toMatch(
      /^auto\/browser_snapshot\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}-[0-9a-f]{6}\.yaml$/,
    );
    expect(out.text).toContain('Stored full browser_snapshot output at:');
    expect(out.text).toContain(savedPath);
    expect(out.text).toContain('read_artifact');
    expect(out.text).toContain('grep_artifact');
    // Summary should be MUCH shorter than the original.
    expect(out.text.length).toBeLessThan(LARGE.length / 2);
  });

  it('preserves images in the result (vision channel is independent)', async () => {
    const writeArtifact = vi.fn(async () => {});
    const result: McpToolResult = {
      text: LARGE,
      images: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }],
    };
    const out = await OutboardStorage.postProcess!(
      'browser_snapshot',
      {},
      result,
      makeCtx({ writeArtifact }),
    );
    expect(out.images).toEqual(result.images);
  });

  it('routes per-tool extensions correctly', async () => {
    const cases: Array<{ tool: string; ext: string }> = [
      { tool: 'browser_snapshot', ext: 'yaml' },
      { tool: 'browser_evaluate', ext: 'json' },
      { tool: 'web_search', ext: 'json' },
      { tool: 'browser_console_messages', ext: 'txt' },
      { tool: 'run_playwright_script', ext: 'txt' },
      { tool: 'run_nodejs_script', ext: 'txt' },
    ];
    for (const c of cases) {
      let savedPath = '';
      const writeArtifact = vi.fn(async (path: string) => {
        savedPath = path;
      });
      const result: McpToolResult = { text: LARGE, images: [] };
      await OutboardStorage.postProcess!(c.tool, {}, result, makeCtx({ writeArtifact }));
      expect(savedPath.endsWith(`.${c.ext}`)).toBe(true);
    }
  });

  it('sniffs fetch_url content to pick HTML / JSON / TXT', async () => {
    let savedPath = '';
    const writeArtifact = vi.fn(async (path: string) => {
      savedPath = path;
    });
    const ctx = makeCtx({ writeArtifact });

    await OutboardStorage.postProcess!(
      'fetch_url',
      {},
      { text: `${'<!DOCTYPE html>'}${'<html><body>'.repeat(500)}`, images: [] },
      ctx,
    );
    expect(savedPath.endsWith('.html')).toBe(true);

    await OutboardStorage.postProcess!(
      'fetch_url',
      {},
      { text: `${'{"items":['}${'1,'.repeat(2000)}`, images: [] },
      ctx,
    );
    expect(savedPath.endsWith('.json')).toBe(true);

    await OutboardStorage.postProcess!(
      'fetch_url',
      {},
      { text: 'Plain text response without any markup. '.repeat(80), images: [] },
      ctx,
    );
    expect(savedPath.endsWith('.txt')).toBe(true);
  });
});

describe('buildOutboardSummary', () => {
  it('caps the preview at 600 chars', () => {
    const big = 'x'.repeat(10_000);
    const summary = buildOutboardSummary({
      toolName: 'browser_snapshot',
      artifactPath: 'auto/browser_snapshot/2026-05-02/12-00-00-aaaaaa.yaml',
      content: big,
    });
    expect(summary).toContain('Total: 10,000 chars (~2,500 tokens)');
    // Should mention "+9,400 more chars" in the preview suffix.
    expect(summary).toContain('+9,400 more chars');
    // The preview itself should be exactly 600 'x' chars on one line.
    const previewMatch = summary.match(/Preview \(first 600 chars\):\n(x+)/);
    expect(previewMatch).not.toBeNull();
    expect(previewMatch![1]!.length).toBe(600);
  });

  it('omits the "more chars" suffix when content fits in the preview', () => {
    const small = 'one line of content'.repeat(10);
    const summary = buildOutboardSummary({
      toolName: 'browser_snapshot',
      artifactPath: 'auto/browser_snapshot/2026-05-02/12-00-00-aaaaaa.yaml',
      content: small,
    });
    expect(summary).not.toContain('more chars');
  });

  it('always names both navigation tools', () => {
    const summary = buildOutboardSummary({
      toolName: 'fetch_url',
      artifactPath: 'auto/fetch_url/2026-05-02/12-00-00-aaaaaa.txt',
      content: 'whatever',
    });
    expect(summary).toContain('read_artifact');
    expect(summary).toContain('grep_artifact');
    expect(summary).toContain('lines: { start, count }');
  });
});
