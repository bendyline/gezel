import type { GezelSummary, ProjectDetail } from '@bendyline/gezel';
import { displayName } from '@bendyline/gezel';
import { useMemo } from 'react';
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
}: {
  project: ProjectDetail;
  gezels: GezelSummary[];
}) {
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
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

  return (
    <section
      id="project-about-crew"
      className="project-crew-settings project-about-anchor"
      aria-labelledby="project-crew-settings-title"
    >
      <h3 id="project-crew-settings-title" className="project-crew-settings-title">
        Assigned gezels
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
          No gezels are assigned to this project yet.
        </p>
      )}
    </section>
  );
}
