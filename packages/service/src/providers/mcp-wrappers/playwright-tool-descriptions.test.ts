import { describe, expect, it } from 'vitest';
import type { OpenAIFunctionTool } from '../mcp-bridge.js';
import { PlaywrightToolDescriptions } from './playwright-tool-descriptions.js';
import type { McpToolWrapperContext } from './types.js';

const ctx: McpToolWrapperContext = {
  spec: { command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
  cwd: '/tmp',
  modelTier: 'large',
  isMeester: false,
  hasTool: () => false,
  callTool: async () => ({ text: '', images: [] }),
};

const STOCK_TOOLS: OpenAIFunctionTool[] = [
  {
    type: 'function',
    name: 'browser_navigate',
    description: 'Navigate to a URL',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
  },
  {
    type: 'function',
    name: 'browser_click',
    description: 'Click an element',
    parameters: { type: 'object' },
  },
  {
    type: 'function',
    name: 'browser_console_messages',
    description: 'Read console messages',
    parameters: { type: 'object' },
  },
];

describe('PlaywrightToolDescriptions', () => {
  it('matches @playwright/mcp servers', () => {
    expect(
      PlaywrightToolDescriptions.matches({
        command: 'npx',
        args: ['@playwright/mcp@latest'],
        env: {},
      }),
    ).toBe(true);
  });

  it('overrides the browser_navigate description with explicit URL guidance', () => {
    const out = PlaywrightToolDescriptions.decorateTools!(STOCK_TOOLS, ctx);
    const nav = out.find((t) => t.name === 'browser_navigate');
    expect(nav).toBeDefined();
    expect(nav!.description).toContain('https://');
    expect(nav!.description).toContain('Search queries');
    expect(nav!.description).toContain('NOT valid URLs');
  });

  it('preserves the JSON schema', () => {
    const out = PlaywrightToolDescriptions.decorateTools!(STOCK_TOOLS, ctx);
    const nav = out.find((t) => t.name === 'browser_navigate');
    expect(nav!.parameters).toEqual(STOCK_TOOLS[0]!.parameters);
  });

  it('overrides browser_click and browser_take_screenshot too', () => {
    const tools: OpenAIFunctionTool[] = [
      ...STOCK_TOOLS,
      {
        type: 'function',
        name: 'browser_take_screenshot',
        description: 'Take a screenshot',
        parameters: { type: 'object' },
      },
    ];
    const out = PlaywrightToolDescriptions.decorateTools!(tools, ctx);
    expect(out.find((t) => t.name === 'browser_click')!.description).toContain('[ref=eN]');
    expect(out.find((t) => t.name === 'browser_take_screenshot')!.description).toContain(
      'fullPage',
    );
  });

  it('leaves untouched any tool not in the override map', () => {
    const out = PlaywrightToolDescriptions.decorateTools!(STOCK_TOOLS, ctx);
    const console = out.find((t) => t.name === 'browser_console_messages');
    expect(console!.description).toBe('Read console messages');
  });

  it('returns the same length list (no add/drop)', () => {
    const out = PlaywrightToolDescriptions.decorateTools!(STOCK_TOOLS, ctx);
    expect(out).toHaveLength(STOCK_TOOLS.length);
  });
});
