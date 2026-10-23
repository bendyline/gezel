/** Verify the shipped CLI really exposes conversion tools without a catalog installation. */
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { McpBridge } from '../providers/mcp-bridge.js';
import { bundledDocblocksToolset } from './bundled-docblocks.js';

it('starts the included MCP runtime and lists its document formats', async () => {
  const toolset = bundledDocblocksToolset();
  const bridge = new McpBridge();
  try {
    await bridge.start({
      command: process.execPath,
      args: [join(toolset.installPath!, 'dist/bin.js'), 'mcp'],
      env: {},
    });
    const result = await bridge.callToolRich('list_formats', {});
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('pptx');
    expect(result.text).toContain('mp4');
  } finally {
    await bridge.stop();
  }
}, 30_000);
