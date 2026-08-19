export type LocalEngineLabelKind = 'mlx' | 'llama-cpp' | 'ds4';

/**
 * Settings labels for engines that run on the current computer. The engine
 * suffix keeps the several local runtimes distinct while the prefix uses the
 * platform language people expect from the desktop app.
 */
export function localEngineSettingsLabel(
  engine: LocalEngineLabelKind,
  platform: string | undefined,
): string {
  if (engine === 'mlx') return 'This Mac (Apple MLX)';

  const device = platform === 'darwin' ? 'This Mac' : 'This PC';
  if (engine === 'llama-cpp') return `${device} (llama)`;
  return `${device} (DwarfStar - DS4)`;
}
