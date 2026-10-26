export interface GenerateImageToolArgs {
  width?: number;
  height?: number;
  steps?: number;
}

/**
 * Agent requests are held to about a megapixel, the size most current models
 * were trained at; the daemon then fits the size to the model's own range, so
 * SD 1.5 still lands at 768 and Ming at no less than 1024. A cap below the
 * training size degrades the image rather than speeding it up: SDXL-class
 * models garble composition at 512. Steps are not touched here: the daemon
 * holds them at the model's own recommendation (`capStepsAtRecommended`),
 * because a fixed cap of 4 suits only the distilled models and ruined every
 * one that needs 25 to 100 steps.
 */
const AGENT_IMAGE_MAX_SIDE_PX = 1024;
const SIZE_MULTIPLE = 64;

export function normalizeGenerateImageToolArgs<T extends GenerateImageToolArgs>(
  args: T,
  kind: 'local' | 'cloud' = 'local',
): {
  args: T;
  note?: string;
} {
  if (kind === 'cloud') return { args: { ...args } };
  const next = { ...args };
  const changes: string[] = [];
  const originalSize =
    typeof args.width === 'number' && typeof args.height === 'number'
      ? `${args.width}x${args.height}`
      : undefined;

  if (typeof args.width === 'number' && typeof args.height === 'number') {
    const maxSide = Math.max(args.width, args.height);
    if (maxSide > AGENT_IMAGE_MAX_SIDE_PX) {
      const scale = AGENT_IMAGE_MAX_SIDE_PX / maxSide;
      next.width = quantizeImageSize(args.width * scale);
      next.height = quantizeImageSize(args.height * scale);
    }
  } else if (typeof args.width === 'number' && args.width > AGENT_IMAGE_MAX_SIDE_PX) {
    next.width = AGENT_IMAGE_MAX_SIDE_PX;
  } else if (typeof args.height === 'number' && args.height > AGENT_IMAGE_MAX_SIDE_PX) {
    next.height = AGENT_IMAGE_MAX_SIDE_PX;
  }

  if (
    originalSize &&
    typeof next.width === 'number' &&
    typeof next.height === 'number' &&
    `${next.width}x${next.height}` !== originalSize
  ) {
    changes.push(`size ${originalSize} -> ${next.width}x${next.height}`);
  } else if (args.width !== next.width && typeof next.width === 'number') {
    changes.push(`width ${args.width} -> ${next.width}`);
  } else if (args.height !== next.height && typeof next.height === 'number') {
    changes.push(`height ${args.height} -> ${next.height}`);
  }

  return {
    args: next as T,
    ...(changes.length > 0
      ? { note: `Request normalized for agent image generation (${changes.join(', ')}).` }
      : {}),
  };
}

function quantizeImageSize(size: number): number {
  const rounded = Math.round(size / SIZE_MULTIPLE) * SIZE_MULTIPLE;
  return Math.max(SIZE_MULTIPLE, Math.min(AGENT_IMAGE_MAX_SIDE_PX, rounded));
}
