import type {
  AppliedProjectType,
  ProjectTypeUpgradeNeedsOkKind,
  ProjectTypeUpgradePlan,
} from '@bendyline/gezel';
import { useState } from 'react';
import { apiErrorMessage } from '../../api-error.js';
import { api } from '../../api.js';
import { SettingField } from '../../components/SettingsSection.js';
import { useBuilderView } from '../../components/useBuilderView.js';
import { Dialog } from '../../primitives/index.js';

/**
 * App updates in a project: a project made from a project type moves to a
 * newer version of it on its own when nothing of the person's is affected.
 * These pieces cover the rest, the updates that wait for the person's OK:
 * one muted line over the Output page, the same state in Settings, and a
 * dialog that says in plain words what changes and what stays.
 */

function count(n: number, one: string, many: string): string {
  return n === 1 ? `${one}` : `${n} ${many}`;
}

function list(items: readonly string[]): string {
  return items.join(', ');
}

/** What the person is agreeing to, one sentence per reason the update waited. */
export function projectTypeUpdateAsks(plan: ProjectTypeUpgradePlan): string[] {
  const words: Record<ProjectTypeUpgradeNeedsOkKind, (items: string[]) => string> = {
    'edited-script': (items) =>
      `Replaces ${items.length === 1 ? 'a script' : 'scripts'} changed in this project (${list(items)}). A copy is saved first in Artifacts, under app-updates.`,
    'new-crew': (items) =>
      `Adds ${count(items.length, 'a crew member', 'crew members')} this version works with.`,
    'new-toolset': (items) => `Connects a tool service this version uses (${list(items)}).`,
    'new-schedule': (items) => `Adds a recurring run that starts on its own (${list(items)}).`,
    'folder-write': (items) =>
      `Adds ${count(items.length, 'a file', 'files')} to your folder (${list(items)}).`,
    'network-access': (items) =>
      `Lets a script use the internet or a saved password (${list(items)}).`,
    'other-source': () => 'This app was added from a file, so its updates wait for you.',
    pinned: () => 'This project was set to stay on its version.',
  };
  return plan.needsOk.map((reason) => words[reason.kind](reason.items));
}

/** What the update leaves as it is. */
export function projectTypeUpdateKeeps(plan: ProjectTypeUpgradePlan): string[] {
  const keeps = ['Your data stays as it is.'];
  if (plan.changes.about === 'keep-edited') keeps.push('Your About this project text stays.');
  if (plan.changes.mission === 'keep-edited') keeps.push('Your mission objectives stay.');
  return keeps;
}

/** The muted line over the Output page while an update waits for the person. */
export function ProjectTypeUpdateNotice({
  plan,
  onReview,
}: {
  plan: ProjectTypeUpgradePlan;
  onReview: () => void;
}) {
  return (
    <div className="file-flat-notice project-type-update-notice">
      <span>An update for {plan.typeName} is ready.</span>
      <button type="button" className="file-flat-notice-action" onClick={onReview}>
        Update…
      </button>
    </div>
  );
}

/** Project Settings → Preferences: which app set the project up, and its update state. */
export function ProjectTypeField({
  typeName,
  version,
  plan,
  onReview,
}: {
  typeName: string;
  version: string;
  plan: ProjectTypeUpgradePlan | null;
  onReview: () => void;
}) {
  const builder = useBuilderView();
  const waiting = plan !== null && !plan.automatic;
  const state = waiting
    ? 'An update is ready.'
    : plan
      ? 'An update is being applied.'
      : 'Up to date.';
  return (
    <SettingField
      label="Set up as"
      hint="The project type this project was made from. Its page and tools stay current on their own; an update that would change something of yours waits for you."
    >
      <div className="project-type-field">
        <span>
          {typeName}
          {builder ? ` · version ${version}` : ''}
          {' · '}
          <span className="muted">{state}</span>
        </span>
        {waiting && (
          <button type="button" className="secondary" onClick={onReview}>
            Update…
          </button>
        )}
      </div>
    </SettingField>
  );
}

/** Review and approve an update that waited for the person. */
export function ProjectTypeUpdateDialog({
  projectId,
  plan,
  open,
  onOpenChange,
  onUpdated,
}: {
  projectId: string;
  plan: ProjectTypeUpgradePlan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (applied: AppliedProjectType) => void;
}) {
  const builder = useBuilderView();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const asks = projectTypeUpdateAsks(plan);
  const keeps = projectTypeUpdateKeeps(plan);

  const update = async () => {
    setBusy(true);
    setError('');
    try {
      const applied = await api.upgradeProjectType(projectId, { toVersion: plan.toVersion });
      onUpdated(applied);
      onOpenChange(false);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="project-type-update-dialog">
          <Dialog.Title asChild>
            <h3>Update {plan.typeName}?</h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            A newer version of {plan.typeName} is ready. It updates the page and the tools your crew
            uses in this project.
            {builder ? ` Version ${plan.fromVersion} to ${plan.toVersion}.` : ''}
          </Dialog.Description>
          {asks.length > 0 && (
            <div className="project-type-update-section">
              <h4>This update</h4>
              <ul>
                {asks.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="project-type-update-section">
            <h4>Stays the same</h4>
            <ul>
              {keeps.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          {error && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
          <Dialog.Actions>
            <Dialog.Close asChild>
              <button type="button" className="secondary" disabled={busy}>
                Not now
              </button>
            </Dialog.Close>
            <button type="button" onClick={() => void update()} disabled={busy}>
              {busy ? 'Updating…' : 'Update'}
            </button>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
