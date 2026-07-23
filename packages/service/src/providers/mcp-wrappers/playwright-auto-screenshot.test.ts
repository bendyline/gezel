import { describe, expect, it, vi } from 'vitest';
import { PlaywrightAutoScreenshot } from './playwright-auto-screenshot.js';
import type { McpToolWrapperContext } from './types.js';

function ctx(overrides: Partial<McpToolWrapperContext>): McpToolWrapperContext {
  return {
    spec: { command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
    cwd: '/tmp',
    modelTier: 'large',
    isMeester: false,
    hasTool: () => true,
    callTool: vi.fn(async () => ({ text: 'shot taken', images: [] })),
    ...overrides,
  };
}

describe('PlaywrightAutoScreenshot', () => {
  it('matches @playwright/mcp servers', () => {
    expect(
      PlaywrightAutoScreenshot.matches({
        command: 'npx',
        args: ['@playwright/mcp@latest'],
        env: {},
      }),
    ).toBe(true);
  });

  it('chains browser_take_screenshot after browser_navigate and appends images', async () => {
    const callTool = vi.fn(async () => ({
      text: 'screenshot ok',
      images: [{ base64: 'IMG', mimeType: 'image/jpeg' }],
    }));
    const result = await PlaywrightAutoScreenshot.postProcess!(
      'browser_navigate',
      { url: 'https://example.com' },
      { text: '### Result\nNavigated', images: [] },
      ctx({ callTool }),
    );
    expect(callTool).toHaveBeenCalledWith('browser_take_screenshot', {});
    expect(result.images).toEqual([{ base64: 'IMG', mimeType: 'image/jpeg' }]);
    expect(result.text).toContain('Auto-attached screenshot');
  });

  it('skips for non-page-changing tools', async () => {
    const callTool = vi.fn(async () => ({ text: '', images: [] }));
    const result = await PlaywrightAutoScreenshot.postProcess!(
      'browser_console_messages',
      {},
      { text: 'logs', images: [] },
      ctx({ callTool }),
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(result.text).toBe('logs');
  });

  it('skips when the bridge does not expose browser_take_screenshot', async () => {
    const callTool = vi.fn(async () => ({ text: '', images: [] }));
    const result = await PlaywrightAutoScreenshot.postProcess!(
      'browser_navigate',
      { url: 'https://example.com' },
      { text: 'navigated', images: [] },
      ctx({ hasTool: () => false, callTool }),
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(result.text).toBe('navigated');
  });

  it('falls back silently when the screenshot call throws', async () => {
    const callTool = vi.fn(async () => {
      throw new Error('screenshot tool errored');
    });
    const original = { text: 'navigated', images: [] };
    const result = await PlaywrightAutoScreenshot.postProcess!(
      'browser_navigate',
      { url: 'https://example.com' },
      original,
      ctx({ callTool }),
    );
    expect(result).toBe(original);
  });

  it('passes through unchanged when the screenshot returns no images', async () => {
    const callTool = vi.fn(async () => ({ text: 'shot saved', images: [] }));
    const original = { text: 'navigated', images: [] };
    const result = await PlaywrightAutoScreenshot.postProcess!(
      'browser_navigate',
      {},
      original,
      ctx({ callTool }),
    );
    expect(result).toBe(original);
  });

  it('also fires for browser_click and browser_press_key', async () => {
    for (const tool of ['browser_click', 'browser_press_key']) {
      const callTool = vi.fn(async () => ({
        text: '',
        images: [{ base64: 'X', mimeType: 'image/png' }],
      }));
      const result = await PlaywrightAutoScreenshot.postProcess!(
        tool,
        {},
        { text: '', images: [] },
        ctx({ callTool }),
      );
      expect(callTool).toHaveBeenCalledWith('browser_take_screenshot', {});
      expect(result.images).toHaveLength(1);
    }
  });
});
