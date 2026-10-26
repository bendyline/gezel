import type { ImageEngineStatusResponse } from '@bendyline/gezel';
import { CopilotInstallCard } from '../components/CopilotInstallCard.js';
import { CopilotLoginCommand } from '../components/CopilotLoginCommand.js';
import { useCopilotAvailability } from '../components/useCopilotAvailability.js';

export function CopilotImageSettings({
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
  const availability = useCopilotAvailability();
  return (
    <>
      <p className="muted small">
        Generate and edit images with your GitHub Copilot account. Copilot chooses the image model
        and applies your account's access and usage limits. No separate image API key is needed.
        This feature is experimental.
      </p>
      <CopilotInstallCard availability={availability} onInstalled={onRefresh} />
      {(error || engine?.error) && (
        <p className="error" role="alert">
          {error || engine?.error}
        </p>
      )}
      {availability?.available && engine?.status !== 'ok' && (
        <CopilotLoginCommand installDir={availability.installDir} onComplete={onRefresh} />
      )}
      <button type="button" disabled={checking} onClick={onRefresh}>
        {checking ? 'Checking Copilot…' : 'Check availability'}
      </button>
    </>
  );
}
