import type { PromptInclusion } from '@bendyline/gezel';
import { ConnectorMark } from './ConnectorMark.js';
import { openProjectFileActions, runNavActions } from './nav-actions.js';

/**
 * Under a person's message: the saved copy of each thing they named that a
 * connector brought into the turn (a web page saved in this project). The
 * row is the link to the local copy; the synopsis is the one the turn was
 * given, and is the item's own words, not Gezel's. An entry with no copy says
 * why. See docs/prompt-connectors.md.
 */
export function MessageInclusions({
  inclusions,
  projectId,
}: {
  inclusions: readonly PromptInclusion[];
  projectId?: string | undefined;
}) {
  if (inclusions.length === 0) return null;
  return (
    <ul className="msg-inclusions" aria-label="Saved for this message">
      {inclusions.map((item) => (
        <li key={`${item.connectorType}:${item.subject}`}>
          <InclusionRow item={item} projectId={projectId} />
        </li>
      ))}
    </ul>
  );
}

function InclusionRow({
  item,
  projectId,
}: {
  item: PromptInclusion;
  projectId?: string | undefined;
}) {
  const mark = (
    <ConnectorMark
      className="msg-inclusion-mark"
      connectorType={item.connectorType}
      size={16}
      svgClassName="chat-composer-connector-mark-svg"
    />
  );
  const label = item.label ?? item.subject;
  if (!item.path) {
    return (
      <div className="msg-inclusion" data-state="failed">
        {mark}
        <span className="msg-inclusion-text">
          <span className="msg-inclusion-title" title={item.subject}>
            {label} was not saved
          </span>
          {item.reason ? <span className="msg-inclusion-meta">{item.reason}</span> : null}
        </span>
      </div>
    );
  }
  const path = item.path;
  return (
    <button
      type="button"
      className="msg-inclusion"
      title={`Open the saved copy: ${path}`}
      disabled={!projectId}
      onClick={() => {
        if (projectId) {
          runNavActions(openProjectFileActions({ projectId, path, source: 'artifacts' }));
        }
      }}
    >
      {mark}
      <span className="msg-inclusion-text">
        <span className="msg-inclusion-title">{item.title ?? label}</span>
        <span className="msg-inclusion-meta">Saved copy of {label}</span>
        {item.summary ? <span className="msg-inclusion-summary">{item.summary}</span> : null}
      </span>
    </button>
  );
}
