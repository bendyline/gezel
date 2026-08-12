import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVALID_MODEL_ID_CODE,
  InvalidModelIdError,
  isSafeModelId,
  resolveModelDirectory,
} from './model-id.js';

describe('model id safety', () => {
  it.each(['gemma4-e4b-q4', 'whisper-tiny.en', '@vendor_model-1'])(
    'accepts the portable model id %s',
    (id) => {
      expect(isSafeModelId(id)).toBe(true);
      expect(resolveModelDirectory('/var/lib/gezel/models', id)).toBe(
        join('/var/lib/gezel/models', id),
      );
    },
  );

  it.each([
    '',
    '.',
    '..',
    '../outside',
    '..\\outside',
    '/absolute',
    'C:\\outside',
    'nested/model',
    'nested\\model',
    '.hidden',
    'CON',
    'model:',
    'model%2Foutside',
    ' model',
    'model ',
    'x'.repeat(201),
  ])('rejects the path-like or non-portable model id %s', (id) => {
    expect(isSafeModelId(id)).toBe(false);
    expect(() => resolveModelDirectory('/var/lib/gezel/models', id)).toThrow(InvalidModelIdError);
    try {
      resolveModelDirectory('/var/lib/gezel/models', id);
    } catch (err) {
      expect(err).toMatchObject({ code: INVALID_MODEL_ID_CODE });
    }
  });
});
