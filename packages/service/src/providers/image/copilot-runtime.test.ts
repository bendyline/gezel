import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCopilotImageClient } from './copilot-runtime.js';

const { construct } = vi.hoisted(() => ({ construct: vi.fn() }));
vi.mock('../../system-toolsets/resolve.js', () => ({
  resolveInstalledSystemLibrary: vi.fn(async () => null),
}));
vi.mock('../copilot-cli.js', () => ({
  resolveCopilotCliPath: () => ({ path: '/test/copilot', source: 'path' }),
}));
vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class {
    constructor(options: unknown) {
      construct(options);
    }
  },
}));

describe('Copilot image authentication', () => {
  beforeEach(() => construct.mockClear());
  it('lets the SDK use the existing sign-in when no token is configured', async () => {
    await createCopilotImageClient({ home: '/unused', env: { PATH: '/bin', UNSET: undefined } });
    expect(construct).toHaveBeenCalledWith({
      env: { PATH: '/bin', COPILOT_CLI_PATH: '/test/copilot' },
    });
  });
  it('passes an explicit token using the SDK option spelling', async () => {
    await createCopilotImageClient({ home: '/unused', env: {}, githubToken: 'test-token' });
    expect(construct).toHaveBeenCalledWith({
      gitHubToken: 'test-token',
      env: { COPILOT_CLI_PATH: '/test/copilot' },
    });
  });
});
