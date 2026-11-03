import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { inspectMachineRuntime } from './inspect-runtime.js';

async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('inspectMachineRuntime', () => {
  it('names the machine engine and the refusal when nothing answers', async () => {
    const port = await closedLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const failure = await inspectMachineRuntime({
      port,
      baseUrl,
      cert: null,
      home: '/machine/gezel',
      token: 'engine-token',
      serviceRole: 'machine-engine',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      new RegExp(`^Gezel's machine engine at ${baseUrl} isn't answering \\(.*ECONNREFUSED`),
    );
    expect((failure as Error).cause).toBeInstanceOf(TypeError);
  });
});
