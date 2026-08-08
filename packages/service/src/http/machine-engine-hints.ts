/**
 * Friendly dead-ends on the machine engine for the classic third-party
 * OpenAI/Ollama paths. On machine installs the broker holds canonical port
 * 6228, so an app configured with the once-stable
 * `https://127.0.0.1:6228/v1` base URL reaches the broker — which serves no
 * product API — and would otherwise get a bare 404 with nothing to act on.
 * These handlers stay 404 (the endpoint genuinely is not here) but carry an
 * OpenAI-style error envelope, because that is the one shape OpenAI SDKs
 * surface to the user verbatim.
 *
 * Static and context-free on purpose: no auth, no config reads, nothing
 * echoed from the request — the hint must not widen broker authority.
 */

import type { Hono } from 'hono';

const HINT_MESSAGE =
  'This is the Gezel machine engine (a compute broker), not the product /v1 API. ' +
  'The per-user Gezel daemon serves /v1 on a per-launch port published in ' +
  '~/.gezel/runtime/port (HTTPS; pin the cert from runtime/cert.pem). If Ollama ' +
  'emulation is enabled in Settings → Connected Apps, http://127.0.0.1:11434 also works.';

const HINTED_PATHS = [
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/models',
  '/v1/embeddings',
  '/ollama/*',
] as const;

export function mountMachineEngineHints(app: Hono): void {
  for (const path of HINTED_PATHS) {
    app.all(path, (c) =>
      c.json(
        {
          error: {
            message: HINT_MESSAGE,
            type: 'invalid_request_error',
            code: 'gezel_machine_engine_not_product_api',
          },
        },
        404,
      ),
    );
  }
}
