/**
 * An engine this computer can never run: MLX or Apple's on-device model
 * anywhere but an Apple-silicon Mac.
 *
 * It is not a fault and not a wait, so it carries a code of its own. Without
 * one the OpenAI-compatible routes filed it as an unknown provider failure,
 * a 500, and the service's opaque-error middleware replaced its plain message
 * with `internal_error`: asking a Windows install for `"model": "mlx"` told the
 * caller nothing (2026-11-10). The routes map this code to a 400 the caller
 * can read and no client retries.
 */
export const ENGINE_UNSUPPORTED_CODE = 'engine-unsupported';

/** `message` is shown to people and to API callers: say which computers the engine runs on. */
export function engineUnsupportedError(message: string): Error {
  const err = new Error(message) as Error & {
    isActionable: boolean;
    code: typeof ENGINE_UNSUPPORTED_CODE;
  };
  err.isActionable = true;
  err.code = ENGINE_UNSUPPORTED_CODE;
  return err;
}
