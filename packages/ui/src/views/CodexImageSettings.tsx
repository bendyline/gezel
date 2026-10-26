import type { ImageEngineStatusResponse } from '@bendyline/gezel';

export function CodexImageSettings({
  engine,
  error,
  checking,
  onRefresh,
}: {
  engine: ImageEngineStatusResponse['engine'] | undefined;
  error: string | undefined;
  checking: boolean;
  onRefresh: () => void;
}) {
  return (
    <>
      <p className="muted small">
        Generate and edit images with your Codex account through the installed Codex CLI. Your
        existing ChatGPT sign-in and Codex usage limits apply. No separate image API key is needed.
        This feature is experimental.
      </p>
      <p className="muted small">
        Image size, shape, quality, and editing instructions are passed to Codex. Codex controls the
        final render settings; any differences or unsupported controls are reported with the result.
      </p>
      {(error || engine?.error) && (
        <p className="error" role="alert">
          {error || engine?.error}
        </p>
      )}
      {engine?.status !== 'ok' && (
        <p className="muted small">
          Install or update{' '}
          <a href="https://learn.chatgpt.com/docs/cli" target="_blank" rel="noreferrer">
            Codex CLI
          </a>
          , then run <code>codex login</code> with your ChatGPT account. An explicit binary path can
          be set in Settings → OpenAI Codex CLI → Advanced.
        </p>
      )}
      <button type="button" disabled={checking} onClick={onRefresh}>
        {checking ? 'Checking Codex…' : 'Check availability'}
      </button>
    </>
  );
}
