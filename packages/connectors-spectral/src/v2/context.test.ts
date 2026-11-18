import { describe, expect, it } from 'vitest';
import { basePayload, makeRunContext } from './context.js';

type Logger = Record<'info' | 'log' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void>;

describe('makeRunContext', () => {
  it('keeps scrubbed, bounded log lines and drops debug output', () => {
    const run = makeRunContext({ secrets: ['sk-1234567890'] });
    const logger = run.context.logger as Logger;
    logger.info('using', 'sk-1234567890');
    logger.warn({ n: 1 });
    logger.debug('not kept');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.error(circular);
    logger.log('x'.repeat(600));
    expect(run.logs.slice(0, 3)).toEqual([
      'info: using [secret]',
      'warn: {"n":1}',
      'error: [object Object]',
    ]);
    expect(run.logs[3]).toHaveLength('info: '.length + 500);
    for (let i = 0; i < 60; i++) logger.info(`line ${i}`);
    expect(run.logs).toHaveLength(50);
  });

  it('hands a polling trigger its last position and reads back the new one', () => {
    const fresh = makeRunContext({ secrets: [] });
    expect(fresh.pollingState()).toBeNull();
    expect(fresh.context.instanceState).toEqual({});

    const resumed = makeRunContext({ state: { since: '3' }, secrets: [] });
    expect(resumed.pollingState()).toEqual({ since: '3' });
    const internal = (resumed.context.instanceState as Record<string, { polling: unknown }>)
      .__prismaticInternal;
    if (!internal) throw new Error('no polling state handed to the trigger');
    internal.polling = { since: '9' };
    expect(resumed.pollingState()).toEqual({ since: '9' });
  });

  it('turns batching on only when the trigger declares a batch size', () => {
    expect(makeRunContext({ secrets: [] }).context.batch).toEqual({ enabled: false });
    expect(makeRunContext({ batchSize: 2, secrets: [] }).context.batch).toEqual({
      enabled: true,
      batchSize: 2,
    });
  });

  it('refuses to invoke flows', async () => {
    const invoke = makeRunContext({ secrets: [] }).context.invokeFlow as () => Promise<unknown>;
    await expect(invoke()).rejects.toThrow(/cannot invoke flows/);
  });
});

describe('basePayload', () => {
  it('carries a pagination state only when there is one', () => {
    expect(basePayload()).not.toHaveProperty('paginationState');
    expect(basePayload(null)).not.toHaveProperty('paginationState');
    expect(basePayload({ cursor: '2' })).toMatchObject({ paginationState: { cursor: '2' } });
  });
});
