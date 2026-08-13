import type { UnrecognizedLocalModel } from '@bendyline/gezel-client';
import { formatBytes } from './engine-pill-stats.js';

/**
 * Management surface for model directories whose manifest exists but cannot
 * be loaded by the current daemon. They are intentionally not promoted into
 * the runnable installed list; this row only keeps their disk use visible and
 * gives the user a safe path to replace or remove them.
 */
export function UnrecognizedModels({
  items,
  onUpdate,
  onRemove,
}: {
  items: UnrecognizedLocalModel[];
  onUpdate: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="ollama-section local-model-attention">
      <h4>Models needing attention</h4>
      <p className="muted small local-model-attention-intro">
        Gezel found model files whose metadata is older or unreadable. They won't be used until
        replaced with a current catalog build, but they remain here so you can update or remove
        them.
      </p>
      <div className="ollama-pull-list">
        {items.map((item) => (
          <div key={item.id} className="ollama-pull local-model-attention-row">
            <div className="ollama-pull-head">
              <div className="local-model-attention-name">
                <strong>{item.name ?? item.id}</strong>
                {item.name && <code>{item.id}</code>}
              </div>
              <span className="muted small local-model-attention-reason" title={item.reason}>
                {formatBytes(item.bytes)} · {item.reason}
              </span>
              <span className="local-model-attention-actions">
                {item.canUpdate && (
                  <button type="button" className="home-link" onClick={() => onUpdate(item.id)}>
                    Update
                  </button>
                )}
                {item.readOnly ? (
                  <span
                    className="muted small"
                    title="This model is supplied by the machine-wide model store and must be managed there."
                  >
                    Machine model
                  </span>
                ) : (
                  <button type="button" className="home-link" onClick={() => onRemove(item.id)}>
                    Remove
                  </button>
                )}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
