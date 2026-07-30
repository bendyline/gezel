import type { GezelSummary, ProjectDetail } from '@bendyline/gezel';
import { displayName } from '@bendyline/gezel';
import { useMemo, useState } from 'react';
import { crewLeadLabelLower } from '../labels.js';
import { GezelIcon } from './GezelIcon.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

/**
 * Read-only project membership summary for the top of Project Settings.
 *
 * Chat recipient selection lives in ChatComposer's To-line picker; this
 * surface is intentionally informational and keeps project membership in the
 * place where the lead and other project-wide settings are managed.
 */
export function ProjectCrewRoster({
  project,
  gezels,
  boekwachterGezelId,
  onAddGezel,
  onRemoveGezel,
}: {
  project: ProjectDetail;
  gezels: GezelSummary[];
  boekwachterGezelId?: string;
  onAddGezel?: (gezelId: string) => Promise<void>;
  onRemoveGezel?: (gezelId: string) => Promise<void>;
}) {
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const [boekwachterBusy, setBoekwachterBusy] = useState(false);
  const [boekwachterError, setBoekwachterError] = useState<string | null>(null);
  const assigned = useMemo(() => {
    const seen = new Set<string>();
    const entries: Array<{ gezel: GezelSummary; isLead: boolean }> = [];
    if (project.voormanGezelId) {
      const lead = gezels.find((gezel) => gezel.id === project.voormanGezelId);
      if (lead) {
        entries.push({ gezel: lead, isLead: true });
        seen.add(lead.id);
      }
    }
    for (const id of project.gezelIds ?? []) {
      if (seen.has(id)) continue;
      const gezel = gezels.find((candidate) => candidate.id === id);
      if (!gezel) continue;
      entries.push({ gezel, isLead: false });
      seen.add(id);
    }
    return entries;
  }, [gezels, project.gezelIds, project.voormanGezelId]);
  const designatedBoekwachter = boekwachterGezelId
    ? gezels.find((gezel) => gezel.id === boekwachterGezelId)
    : undefined;
  const projectBoekwachter = gezels.find(
    (gezel) =>
      (project.gezelIds ?? []).includes(gezel.id) &&
      (gezel.id === boekwachterGezelId ||
        gezel.templateId === 'boekwachter' ||
        gezel.role?.trim().toLocaleLowerCase() === 'boekwachter'),
  );

  const changeBoekwachter = async (action: 'add' | 'remove') => {
    const target = action === 'add' ? designatedBoekwachter : projectBoekwachter;
    const callback = action === 'add' ? onAddGezel : onRemoveGezel;
    if (!target || !callback) return;
    setBoekwachterBusy(true);
    setBoekwachterError(null);
    try {
      await callback(target.id);
    } catch (err) {
      setBoekwachterError((err as Error).message);
    } finally {
      setBoekwachterBusy(false);
    }
  };

  return (
    <section
      id="project-about-crew"
      className="project-crew-settings project-about-anchor"
      aria-labelledby="project-crew-settings-title"
    >
      <h3 id="project-crew-settings-title" className="project-crew-settings-title">
        Assigned gezellen
      </h3>
      <p className="muted small project-crew-settings-hint">
        The crew attached to this project. Change the lead below; task and conversation assignments
        are added automatically.
      </p>
      {assigned.length > 0 ? (
        <ul className="project-crew-list">
          {assigned.map(({ gezel, isLead }) => {
            const rendered = displayName(
              { name: gezel.name, roleBasedName: gezel.roleBasedName },
              roleBasedNameOnlyMode,
            );
            const subtitle = isLead ? `⭐ ${crewLeadLabelLower(project)}` : gezel.role;
            return (
              <li
                key={gezel.id}
                className={`project-crew-card${isLead ? ' project-crew-card-lead' : ''}`}
              >
                <GezelIcon
                  svg={gezel.icon ?? null}
                  poppetje={gezel.poppetje}
                  iconOverride={gezel.iconOverride}
                  name={rendered}
                  size={30}
                />
                <span className="project-crew-card-text">
                  <span className="project-crew-card-name">{rendered}</span>
                  {subtitle && <span className="project-crew-card-role">{subtitle}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted small project-crew-empty">
          No gezellen are assigned to this project yet.
        </p>
      )}
      <div
        className={`project-autonomous-role${
          projectBoekwachter ? ' project-autonomous-role-active' : ''
        }`}
      >
        <div className="project-autonomous-role-copy">
          <span className="project-autonomous-role-title">
            AI indexing {projectBoekwachter ? 'on' : 'off'}
          </span>
          <span className="muted small">
            {projectBoekwachter
              ? `${projectBoekwachter.name} studies changed files, writes short summaries and reviews, and prepares weekly digests while the workshop is quiet.`
              : 'Structural file and symbol search stays available. Add the Boekwachter to this crew for background AI summaries, reviews, and digests.'}
          </span>
        </div>
        {projectBoekwachter ? (
          <button
            type="button"
            className="subtle"
            disabled={boekwachterBusy || !onRemoveGezel}
            onClick={() => void changeBoekwachter('remove')}
          >
            {boekwachterBusy ? 'Updating…' : 'Remove Boekwachter'}
          </button>
        ) : (
          <button
            type="button"
            className="subtle"
            disabled={boekwachterBusy || !designatedBoekwachter || !onAddGezel}
            onClick={() => void changeBoekwachter('add')}
          >
            {boekwachterBusy
              ? 'Updating…'
              : designatedBoekwachter
                ? `Add ${designatedBoekwachter.name}`
                : 'No Boekwachter available'}
          </button>
        )}
      </div>
      {boekwachterError && (
        <p className="error small project-autonomous-role-error">{boekwachterError}</p>
      )}
    </section>
  );
}
