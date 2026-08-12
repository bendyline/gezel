import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  type ProcessErrorEventTarget,
  errorFromUnknown,
  installProcessErrorHandlers,
} from './process-errors.js';

describe('process error handlers', () => {
  it('normalizes values that were thrown without Error objects', () => {
    expect(errorFromUnknown('plain failure').message).toBe('plain failure');
    expect(errorFromUnknown({ code: 'BROKEN' }).message).toBe('{"code":"BROKEN"}');
  });

  it('routes uncaught exceptions and unhandled rejections through one handler', () => {
    const target = new EventEmitter() as ProcessErrorEventTarget & EventEmitter;
    const handler = vi.fn();
    const remove = installProcessErrorHandlers(target, handler);

    const exception = new Error('timer failed');
    target.emit('uncaughtException', exception);
    target.emit('unhandledRejection', 'promise failed');

    expect(handler).toHaveBeenNthCalledWith(1, exception, 'uncaughtException');
    expect(handler).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: 'promise failed' }),
      'unhandledRejection',
    );

    remove();
    target.emit('uncaughtException', new Error('ignored'));
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
