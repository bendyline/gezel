import { Tooltip } from '../primitives/index.js';
import {
  type ModelSizeCopyInput,
  formatBytes,
  modelMemoryHeadline,
  modelSizeTitle,
} from './model-memory-copy.js';

/**
 * Size cell for the installed local-model tables: on-disk size, the
 * "~X GB in memory" headline, and the memory-breakdown hover. Radix
 * tooltip rather than a native `title` — the native delay in Electron
 * is long enough to read as "no tooltip at all".
 */
export function ModelSizeCell({ model }: { model: ModelSizeCopyInput }) {
  const headline = modelMemoryHeadline(model);
  return (
    <td>
      <Tooltip.Hint text={modelSizeTitle(model)}>
        <span className="model-size-cell">
          {formatBytes(model.approxSizeBytes)}
          {headline ? <span className="muted small model-memory-headline">{headline}</span> : null}
        </span>
      </Tooltip.Hint>
    </td>
  );
}
