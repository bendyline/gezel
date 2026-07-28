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
  busy: boolean;
  label?: string | undefined;
}): JSX.Element {
  const { provider, model, busy, label } = props;
  const text = busy ? `● ${label ?? 'working'}` : '○ idle';
  const engine = formatEngineIdentity(provider, model);
  return (
    <Box>
      <Text backgroundColor={busy ? 'yellow' : 'blackBright'} color={busy ? 'black' : 'white'}>
        {' '}
        {text} · {engine}{' '}
      </Text>
    </Box>
  );
}

export function formatEngineIdentity(
  provider: string | undefined,
  model: string | undefined,
): string {
  const engine = provider === 'llama-cpp' ? 'llama' : (provider ?? 'on-device');
  return model ? `${engine} · ${model}` : engine;
}
