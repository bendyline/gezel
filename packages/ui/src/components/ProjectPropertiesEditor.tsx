import type { ProjectDetail } from '@bendyline/gezel';
import { PROJECT_PROPERTY_DEFINITIONS, projectPropertyDefinition } from '@bendyline/gezel';
import { useState } from 'react';
import { api } from '../api.js';

/**
 * Inline editor for the project's shared configuration values ("project
 * properties", core `project-properties.ts`) — e.g. the designated
 * language a translator gezel targets. Well-known properties always
 * render; unknown ids present on disk render with their raw id. Values
 * save on blur; an emptied field deletes the key.
 */
export function ProjectPropertiesEditor({
  project,
  onProjectChange,
}: {
  project: ProjectDetail;
  onProjectChange: (project: ProjectDetail) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const stored = project.properties ?? {};
  const extraIds = Object.keys(stored).filter((id) => !projectPropertyDefinition(id));
  const rows = [
    ...PROJECT_PROPERTY_DEFINITIONS.map((def) => ({
      id: def.id,
      label: def.label,
      description: def.description,
      options: def.options,
    })),
    ...extraIds.map((id) => ({
      id,
      label: id,
      description: undefined as string | undefined,
      options: undefined as string[] | undefined,
    })),
  ];

  const save = async (id: string) => {
    const draft = drafts[id];
    if (draft === undefined || draft === (stored[id] ?? '')) return;
    setError(null);
    try {
      const updated = await api.updateProject(project.id, { properties: { [id]: draft } });
      onProjectChange(updated);
      setDrafts((current) => {
        const { [id]: _saved, ...rest } = current;
        return rest;
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="project-properties">
      {rows.map((row) => (
        <label key={row.id} className="config-label project-properties-row">
          {row.label}
          <div className="new-row">
            <input
              value={drafts[row.id] ?? stored[row.id] ?? ''}
              placeholder="Not set"
              list={row.options ? `project-property-options-${row.id}` : undefined}
              onChange={(e) =>
                setDrafts((current) => ({ ...current, [row.id]: e.target.value }))
              }
              onBlur={() => void save(row.id)}
            />
            {row.options && (
              <datalist id={`project-property-options-${row.id}`}>
                {row.options.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            )}
          </div>
          {row.description && <small className="muted">{row.description}</small>}
        </label>
      ))}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
