import { Box, Text } from 'ink';
import type { JSX } from 'react';

/**
 * Terminal equivalent of the web UI's EngineStatusPill — a compact badge
 * showing the selected gezel's effective provider/model and whether a turn
 * is currently running. `busy` is derived from the live feed (any open
 * assistant turn in the project).
 */
export function EnginePill(props: {
  provider: string | undefined;
  model: string | undefined;
  accessMode?: string | undefined;
  busy: boolean;
  label?: string | undefined;
}): JSX.Element {
  const { provider, model, accessMode, busy, label } = props;
  const metadata = formatEngineMetadata(provider, model, accessMode);
  const activity = formatEngineActivity(busy, label);
  return (
    <Box>
      <Text> {metadata} ·</Text>
      <Text backgroundColor={busy ? 'yellow' : 'blackBright'} color={busy ? 'black' : 'white'}>
        {' '}
        {activity}{' '}
      </Text>
    </Box>
  );
}

export function formatEngineStatus(
  provider: string | undefined,
  model: string | undefined,
  busy: boolean,
  label?: string,
  accessMode?: string,
): string {
  return [
    formatEngineMetadata(provider, model, accessMode),
    formatEngineActivity(busy, label),
  ].join(' · ');
}

function formatEngineMetadata(
  provider: string | undefined,
  model: string | undefined,
  accessMode?: string,
): string {
  return [accessMode, formatEngineIdentity(provider, model)].filter(Boolean).join(' · ');
}

function formatEngineActivity(busy: boolean, label?: string): string {
  return busy ? `● ${label ?? 'working'}` : '○ idle';
}

export function formatEngineIdentity(
  provider: string | undefined,
  model: string | undefined,
): string {
  const engine = provider === 'llama-cpp' ? 'llama' : (provider ?? 'on-device');
  return model ? `${engine} · ${model}` : engine;
}
