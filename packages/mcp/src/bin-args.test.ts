import { HarnessClientIdSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { GEZEL_MCP_HELP, parseGezelMcpArgs } from './bin-args.js';

describe('parseGezelMcpArgs', () => {
  it('answers help and version without loading a server', () => {
    expect(parseGezelMcpArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseGezelMcpArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseGezelMcpArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseGezelMcpArgs(['-V'])).toEqual({ kind: 'version' });
    expect(parseGezelMcpArgs(['-v'])).toEqual({ kind: 'version' });
  });

  it('lets help win, including after --harness', () => {
    expect(parseGezelMcpArgs(['--version', '--help'])).toEqual({ kind: 'help' });
    expect(parseGezelMcpArgs(['--harness', 'codex', '--help'])).toEqual({ kind: 'help' });
  });

  it('runs a server for the arguments Gezel and the harness setups pass', () => {
    expect(parseGezelMcpArgs([])).toEqual({ kind: 'run' });
    expect(parseGezelMcpArgs(['--harness', 'claude-code'])).toEqual({ kind: 'run' });
  });

  it('names every app the harness accepts', () => {
    for (const client of HarnessClientIdSchema.options) expect(GEZEL_MCP_HELP).toContain(client);
  });
});
