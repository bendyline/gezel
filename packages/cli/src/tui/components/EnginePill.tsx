import { Box, Text } from 'ink';
import type { JSX } from 'react';

/**
 * Terminal equivalent of the web UI's EngineStatusPill — a compact badge
 * showing the active provider and whether a turn is currently running.
 * `provider` is polled from `/api/config` by App; `busy` is derived from
 * the live feed (any open assistant turn in the project).
 */
export function EnginePill(props: {
  provider: string | undefined;
  busy: boolean;
  label?: string | undefined;
}): JSX.Element {
  const { provider, busy, label } = props;
  const text = busy ? `● ${label ?? 'working'}` : '○ idle';
  return (
    <Box>
      <Text backgroundColor={busy ? 'yellow' : 'blackBright'} color={busy ? 'black' : 'white'}>
        {' '}
        {text} · {provider ?? 'on-device'}{' '}
      </Text>
    </Box>
  );
}
