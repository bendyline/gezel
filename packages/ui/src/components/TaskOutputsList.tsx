import type { ReferencedFile, TaskDeliverable } from '@bendyline/gezel';
import { useId, useState } from 'react';
import { FileTypeIcon } from './FileTypeIcon.js';
import { openProjectFileActions, runNavActions } from './nav-actions.js';

/** Rows shown before the list folds; a fanout host can make dozens of files. */
const FOLDED_COUNT = 8;

/**
 * Every file a task made, each a row that opens it. The wrap-up and the
 * Ready card name a few and send the person here for "…and 3 more", so this
 * is where the rest must be reachable. The deliverable card already opens the
 * finished file, so the list holds everything else.
 */
export function TaskOutputsList({
  projectId,
  outputs,
  deliverable,
}: {
  projectId: string;
  outputs: readonly ReferencedFile[];
  deliverable: TaskDeliverable | null;
}) {
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const rest = deliverable
    ? outputs.filter(
        (file) =>
          file.kind !== deliverable.kind ||
          file.path.toLowerCase() !== deliverable.path.toLowerCase(),
      )
    : outputs;
  if (rest.length === 0) return null;
  const shown = expanded ? rest : rest.slice(0, FOLDED_COUNT);
  return (
    <section className="task-outputs" aria-labelledby={headingId}>
      <h4 id={headingId}>{deliverable ? 'Other files' : 'Files'}</h4>
      <ul className="task-outputs-list">
        {shown.map((file) => {
          const slash = file.path.lastIndexOf('/');
          const name = file.path.slice(slash + 1) || file.path;
          const folder = slash > 0 ? file.path.slice(0, slash) : '';
          const where = file.kind === 'workspace' ? 'Project folder' : 'Artifacts';
          return (
            <li key={`${file.kind}:${file.path}`}>
              <button
                type="button"
                className="task-output-row"
                title={`Open ${file.path}`}
                onClick={() =>
                  runNavActions(
                    openProjectFileActions({
                      projectId,
                      path: file.path,
                      source: file.kind === 'workspace' ? 'workspace' : 'artifacts',
                    }),
                  )
                }
              >
                <FileTypeIcon name={name} className="task-output-icon" />
                <span className="task-output-name">{name}</span>
                <span className="task-output-where">{folder ? `${where} · ${folder}` : where}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {rest.length > FOLDED_COUNT && (
        <button
          type="button"
          className="subtle task-outputs-more"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show fewer' : `Show all ${rest.length}`}
        </button>
      )}
    </section>
  );
}
