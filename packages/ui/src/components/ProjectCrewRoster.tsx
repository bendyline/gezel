import type { GezelSummary, ProjectDetail } from '@bendyline/gezel';
import { displayName, roleForMatching } from '@bendyline/gezel';
import { type ReactNode, useMemo, useState } from 'react';
import { crewLeadLabelLower } from '../labels.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import { GezelIcon } from './GezelIcon.js';
import {
  ProjectAddGezelDialog,
  type ProjectTemplateGezelOptions,
} from './ProjectAddGezelDialog.js';
import { SettingField, SettingsSection } from './SettingsSection.js';
import { SuggestedNightWork } from './SuggestedNightWork.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

/**
 * Project membership summary and add-crew entry point at the top of Project
 * Settings. `children` are the crew's own settings (the lead picker), shown
 * right under the members they choose from.
 *
 * Chat recipient selection lives in ChatComposer's To-line picker; this
 * surface manages durable project membership while task and conversation
 * assignments continue to happen in their own contexts.
 */
export function ProjectCrewRoster({
  project,
  gezels,
  boekwachterGezelId,
  recentlyAddedGezelId,
  onAddGezel,
  onCreateTemplateGezel,
  onRemoveGezel,
  children,
}: {
  project: ProjectDetail;
  gezels: GezelSummary[];
  boekwachterGezelId?: string;
  /** The last gezel added via this surface — flashes their fresh suggestions. */
  recentlyAddedGezelId?: string;
  onAddGezel?: (gezelId: string) => Promise<void>;
  onCreateTemplateGezel?: (
    templateId: string,
    options: ProjectTemplateGezelOptions,
  ) => Promise<void>;
  onRemoveGezel?: (gezelId: string) => Promise<void>;
  children?: ReactNode;
}) {
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const [showAddGezel, setShowAddGezel] = useState(false);
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
        roleForMatching(gezel.role)?.trim().toLocaleLowerCase() === 'boekwachter'),
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
    <SettingsSection
      id="project-about-crew"
      className="project-about-anchor project-crew-settings"
      title="Crew"
      hint="The gezellen on this project. Anyone you give a task or a conversation here joins automatically."
      actions={
        onAddGezel &&
        onCreateTemplateGezel && (
          <button
            type="button"
            className="primary project-crew-add"
            onClick={() => setShowAddGezel(true)}
          >
            Add Gezel
          </button>
        )
      }
    >
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
      {children}
      {(runtimeCapabilities().index || runtimeCapabilities().background) && (
        <SettingField label="Background work">
          <div className="project-crew-background">
            {runtimeCapabilities().index && (
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
                      : 'Structural file and symbol search stays available. Add the Librarian to this crew for background AI summaries, reviews, and digests.'}
                  </span>
                </div>
                {projectBoekwachter ? (
                  <button
                    type="button"
                    className="subtle"
                    disabled={boekwachterBusy || !onRemoveGezel}
                    onClick={() => void changeBoekwachter('remove')}
                  >
                    {boekwachterBusy ? 'Updating…' : 'Remove Librarian'}
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
                        : 'No Librarian available'}
                  </button>
                )}
              </div>
            )}
            {boekwachterError && (
              <p className="error small project-autonomous-role-error">{boekwachterError}</p>
            )}
            {runtimeCapabilities().background && (
              <SuggestedNightWork
                projectId={project.id}
                projectProperties={project.properties}
                refreshKey={[project.voormanGezelId ?? '', ...(project.gezelIds ?? [])].join('|')}
                recentlyAddedGezelId={recentlyAddedGezelId}
              />
            )}
          </div>
        </SettingField>
      )}
      {onAddGezel && onCreateTemplateGezel && (
        <ProjectAddGezelDialog
          open={showAddGezel}
          project={project}
          gezels={gezels}
          roleBasedNameOnlyMode={roleBasedNameOnlyMode}
          onClose={() => setShowAddGezel(false)}
          onAddExisting={onAddGezel}
          onCreateTemplate={onCreateTemplateGezel}
        />
      )}
    </SettingsSection>
  );
}
