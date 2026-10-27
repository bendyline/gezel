/**
 * Agent requests to a local engine are held to about a megapixel, the size
 * most current models were trained at; the route then fits the size to the
 * model's own range, so SD 1.5 still lands at 768 and Ming at no less than
 * 1024. A cap below the training size degrades the image rather than speeding
 * it up: SDXL-class models garble composition at 512. Steps are not touched
 * here: the route holds them at the model's own recommendation
 * (`capStepsAtRecommended`), because a fixed cap of 4 suits only the distilled
 * models and ruined every one that needs 25 to 100 steps.
 *
 * This runs in the daemon, not the MCP tool, because only the daemon knows
 * whether a local engine or a cloud provider serves the request.
 */
const AGENT_IMAGE_MAX_SIDE_PX = 1024;
const SIZE_MULTIPLE = 64;

export interface AgentImageSize {
  width?: number;
  height?: number;
}

export function capAgentImageSize(req: AgentImageSize): AgentImageSize & { note?: string } {
  const next: AgentImageSize = {
    ...(req.width !== undefined ? { width: req.width } : {}),
    ...(req.height !== undefined ? { height: req.height } : {}),
  };
  const changes: string[] = [];
  const originalSize =
    typeof req.width === 'number' && typeof req.height === 'number'
      ? `${req.width}x${req.height}`
      : undefined;

  if (typeof req.width === 'number' && typeof req.height === 'number') {
    const maxSide = Math.max(req.width, req.height);
    if (maxSide > AGENT_IMAGE_MAX_SIDE_PX) {
      const scale = AGENT_IMAGE_MAX_SIDE_PX / maxSide;
      next.width = quantizeImageSize(req.width * scale);
      next.height = quantizeImageSize(req.height * scale);
    }
  } else if (typeof req.width === 'number' && req.width > AGENT_IMAGE_MAX_SIDE_PX) {
    next.width = AGENT_IMAGE_MAX_SIDE_PX;
  } else if (typeof req.height === 'number' && req.height > AGENT_IMAGE_MAX_SIDE_PX) {
    next.height = AGENT_IMAGE_MAX_SIDE_PX;
  }

  if (
    originalSize &&
    typeof next.width === 'number' &&
    typeof next.height === 'number' &&
    `${next.width}x${next.height}` !== originalSize
  ) {
    changes.push(`size ${originalSize} -> ${next.width}x${next.height}`);
  } else if (req.width !== next.width && typeof next.width === 'number') {
    changes.push(`width ${req.width} -> ${next.width}`);
  } else if (req.height !== next.height && typeof next.height === 'number') {
    changes.push(`height ${req.height} -> ${next.height}`);
  }

  return changes.length > 0
    ? { ...next, note: `Request normalized for agent image generation (${changes.join(', ')}).` }
    : next;
}

function quantizeImageSize(size: number): number {
  const rounded = Math.round(size / SIZE_MULTIPLE) * SIZE_MULTIPLE;
  return Math.max(SIZE_MULTIPLE, Math.min(AGENT_IMAGE_MAX_SIDE_PX, rounded));
}
