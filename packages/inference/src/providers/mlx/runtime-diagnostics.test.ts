import { describe, expect, it } from 'vitest';
import { UnsupportedResponseFormatError, mlxHttpError } from './runtime-diagnostics.js';

const sidecar = (detail: string) => JSON.stringify({ detail });

describe('mlxHttpError', () => {
  // A schema the sidecar's JSON grammar refuses came back as a 500
  // `server_error`, which OpenAI SDKs retry, worded in compiler options
  // ("Enable 'coerce_one_of' option") that a caller cannot set.
  it('makes a refused response_format the caller’s error, in the sidecar’s words', () => {
    const detail = "The response format's schema cannot be enforced: Invalid type: bogus";
    const err = mlxHttpError(422, 'Unprocessable Entity', sidecar(detail));
    expect(err).toBeInstanceOf(UnsupportedResponseFormatError);
    expect(err.message).toBe(detail);
    expect((err as UnsupportedResponseFormatError).code).toBe('unsupported_response_format');
    expect(
      mlxHttpError(422, 'Unprocessable Entity', sidecar("Unsupported response_format type: 'xml'")),
    ).toBeInstanceOf(UnsupportedResponseFormatError);
  });

  it('keeps a long refusal whole enough to name what the schema lacks', () => {
    const detail = `The response format's schema cannot be enforced: ${'x'.repeat(400)} the part`;
    expect(mlxHttpError(422, 'Unprocessable Entity', sidecar(detail)).message).toBe(detail);
  });

  it('leaves every other failure an engine error', () => {
    for (const [status, body] of [
      [422, sidecar('This MLX engine has no enabled vision tower')],
      [422, sidecar('Invalid image input: not base64')],
      [422, 'not json, mentions response_format'],
      [500, sidecar("The response format's schema cannot be enforced: matcher fault")],
    ] as const) {
      const err = mlxHttpError(status, 'Error', body);
      expect(err).not.toBeInstanceOf(UnsupportedResponseFormatError);
      expect(err.message).toMatch(/^\[Mac AI\] engine returned/);
    }
  });
});
