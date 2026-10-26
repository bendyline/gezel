import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { killProcessTree } from '../../utils/kill-process-tree.js';
import { type RpcRecord, createCodexImageClient } from './codex-image-client.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../codex-cli/binary.js', () => ({
  resolveCodexBinary: vi.fn(async () => ({ path: '/usr/bin/codex' })),
}));
vi.mock('../../utils/kill-process-tree.js', () => ({ killProcessTree: vi.fn() }));

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const messages: RpcRecord[] = [];
  let autoInitialize = true;
  const reply = (message: RpcRecord) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on('data', (chunk) => {
    const message = JSON.parse(String(chunk));
    messages.push(message);
    if (autoInitialize && message.method === 'initialize')
      queueMicrotask(() => reply({ id: message.id, result: {} }));
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  vi.mocked(killProcessTree).mockImplementation(() => {
    queueMicrotask(() => child.emit('close', null));
  });
  return {
    child,
    messages,
    reply,
    delayInitialize: () => {
      autoInitialize = false;
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('Codex image app-server transport', () => {
  it('uses a separate process, preserves credential environment, and correlates split JSON responses', async () => {
    const f = processFixture();
    const env = { PATH: '/usr/bin', CODEX_HOME: '/existing/codex' };
    const client = await createCodexImageClient({
      cwd: '/image-work',
      env,
      signal: new AbortController().signal,
    });
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/codex',
      expect.arrayContaining([
        '--no-daemon',
        'app-server',
        '--stdio',
        'features.hooks=false',
        'features.shell_tool=false',
      ]),
      expect.objectContaining({ cwd: '/image-work', env }),
    );
    expect(f.messages[1]).toMatchObject({ method: 'initialized' });
    const first = client.request('account/read');
    const second = client.request('modelProvider/capabilities/read');
    f.reply({ id: f.messages[3]!.id, result: { imageGeneration: true } });
    const line = JSON.stringify({
      id: f.messages[2]!.id,
      result: { account: { type: 'chatgpt' } },
    });
    f.child.stdout.write(line.slice(0, 10));
    f.child.stdout.write(`${line.slice(10)}\n`);
    expect(await first).toEqual({ account: { type: 'chatgpt' } });
    expect(await second).toEqual({ imageGeneration: true });
    const notification = vi.fn();
    client.onNotification(notification);
    f.reply({
      method: 'item/completed',
      params: { item: { type: 'imageGeneration', result: 'bytes' } },
    });
    expect(notification).toHaveBeenCalledWith(
      'item/completed',
      expect.objectContaining({ item: { type: 'imageGeneration', result: 'bytes' } }),
    );
    await client.stop();
    expect(killProcessTree).toHaveBeenCalledOnce();
  });

  it('denies server requests instead of automatically granting permissions or executing tools', async () => {
    const f = processFixture();
    const client = await createCodexImageClient({
      cwd: '/image-work',
      signal: new AbortController().signal,
    });
    const turn = client.request('turn/start');
    f.reply({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
    await expect(turn).rejects.toThrow('unsupported tool or approval');
    expect(f.messages.at(-1)).toMatchObject({ id: 'approval', error: { code: -32601 } });
    await client.stop();
  });

  it('cancels a pending initialization and terminates the owned process tree', async () => {
    const f = processFixture();
    f.delayInitialize();
    const controller = new AbortController();
    const connecting = createCodexImageClient({ cwd: '/image-work', signal: controller.signal });
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    controller.abort(new Error('cancelled by user'));
    await expect(connecting).rejects.toThrow('cancelled by user');
    expect(killProcessTree).toHaveBeenCalledOnce();
  });

  it.each(['invalid-json', 'exit'] as const)('fails pending requests on %s', async (failure) => {
    const f = processFixture();
    const client = await createCodexImageClient({
      cwd: '/image-work',
      signal: new AbortController().signal,
    });
    const pending = client.request('account/read');
    if (failure === 'invalid-json') f.child.stdout.write('invalid\n');
    else f.child.emit('close', 1);
    await expect(pending).rejects.toThrow(failure === 'exit' ? 'exited' : 'invalid');
    await client.stop();
  });
});
