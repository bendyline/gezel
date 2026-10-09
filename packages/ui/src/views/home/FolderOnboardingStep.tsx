import {
  type CloudProvider,
  type FolderCensus,
  type WellKnownFoldersResponse,
  isSharedLibraryProject,
} from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { folderCensusLine } from '../../components/folder-census-text.js';

interface FolderChoice {
  path: string;
  label: string;
  kind: 'pictures' | 'documents' | 'desktop' | 'code' | 'other';
  census?: FolderCensus;
  cloud?: CloudProvider;
  selected: boolean;
}

const CLOUD_NAMES: Record<string, string> = {
  icloud: 'iCloud',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  gdrive: 'Google Drive',
  box: 'Box',
  nextcloud: 'Nextcloud',
};

/**
 * First-run: which folders should the crew look after, and may it work at
 * night. Offered on Home until the person finishes or skips it. Every folder
 * is added read-only with its crew and its night work, which is why the
 * card says what will happen before anything is added.
 */
export function FolderOnboardingStep({
  config,
  onDone,
}: {
  config: ConfigResponse | null;
  onDone: () => void;
}) {
  const [choices, setChoices] = useState<FolderChoice[] | null>(null);
  const [overnight, setOvernight] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listWellKnownFolders({ census: true })
      .then((res) => {
        if (!cancelled) setChoices(choicesFrom(res));
      })
      .catch(() => {
        if (!cancelled) setChoices([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (path: string) =>
    setChoices((list) =>
      (list ?? []).map((c) => (c.path === path ? { ...c, selected: !c.selected } : c)),
    );

  const addAnother = async () => {
    const path = await window.__GEZEL__?.selectDirectory?.({ title: 'Add a folder' });
    if (!path) return;
    setChoices((list) => {
      const existing = list ?? [];
      if (existing.some((c) => c.path === path)) {
        return existing.map((c) => (c.path === path ? { ...c, selected: true } : c));
      }
      const label = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      return [...existing, { path, label, kind: 'other', selected: true }];
    });
  };

  const markDone = async () => {
    const now = new Date().toISOString();
    await api
      .updateConfig({ onboarding: { foldersStepDoneAt: now, overnightStepDoneAt: now } })
      .catch(() => {});
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    const failed: string[] = [];
    for (const choice of (choices ?? []).filter((c) => c.selected)) {
      try {
        await api.inferProjectForPath({
          path: choice.path,
          kind: 'folder',
          source: 'first-run',
          create: true,
          recruitCrew: true,
          nightWork: overnight,
        });
      } catch {
        failed.push(choice.label);
      }
    }
    if (overnight) {
      await window.__GEZEL__?.startAtLogin?.set(true).catch(() => {});
      await api
        .updateConfig({
          nightShift: {
            ...(config?.nightShift ?? {}),
            enabled: true,
            keepAwakeWhileRunning: true,
            pauseOnBattery: true,
          },
        })
        .catch(() => {});
    }
    await markDone();
    setBusy(false);
    if (failed.length > 0) {
      setError(`Couldn't add ${failed.join(', ')}. You can add them later from Projects.`);
      return;
    }
    onDone();
  };

  const skip = async () => {
    setBusy(true);
    await markDone();
    onDone();
  };

  const selectedCount = (choices ?? []).filter((c) => c.selected).length;
  return (
    <section className="folder-onboarding" aria-labelledby="folder-onboarding-title">
      <h2 id="folder-onboarding-title">Which folders should your crew look after?</h2>
      <p className="folder-onboarding-promise">
        Read-only. Gezel reads and indexes these folders. It never changes, moves or deletes a file
        unless you ask and approve.
      </p>
      {choices === null ? (
        <p className="muted">Looking through your folders…</p>
      ) : (
        <div className="folder-onboarding-cards">
          {choices.map((choice) => (
            <label
              key={choice.path}
              className={`folder-onboarding-card${choice.selected ? ' is-selected' : ''}`}
            >
              <input
                type="checkbox"
                checked={choice.selected}
                onChange={() => toggle(choice.path)}
                disabled={busy}
              />
              <span className="folder-onboarding-card-text">
                <span className="folder-onboarding-card-name">{choice.label}</span>
                <span className="folder-onboarding-card-detail">
                  {choice.census
                    ? folderCensusLine(
                        choice.census,
                        choice.kind === 'code' ? 'other' : choice.kind,
                        choice.cloud ? CLOUD_NAMES[choice.cloud] : undefined,
                      )
                    : choice.path}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      <button
        type="button"
        className="home-workshop-tip-action folder-onboarding-add"
        onClick={() => void addAnother()}
        disabled={busy || !window.__GEZEL__?.selectDirectory}
      >
        Add another folder…
      </button>

      <h3>Let your crew work while you sleep?</h3>
      <p className="folder-onboarding-promise">
        Gezel starts when you log in and keeps this computer awake at night while it's plugged in.
      </p>
      <div className="gz-tray" role="radiogroup" aria-label="Work while you sleep">
        <button
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
          type="button"
          role="radio"
          aria-checked={overnight}
          className={`gz-key${overnight ? ' gz-key-active' : ''}`}
          onClick={() => setOvernight(true)}
          disabled={busy}
        >
          Yes
        </button>
        <button
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
          type="button"
          role="radio"
          aria-checked={!overnight}
          className={`gz-key${!overnight ? ' gz-key-active' : ''}`}
          onClick={() => setOvernight(false)}
          disabled={busy}
        >
          Not now
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      <div className="folder-onboarding-actions">
        <button type="button" onClick={() => void finish()} disabled={busy || choices === null}>
          {busy
            ? 'Adding…'
            : selectedCount === 0
              ? 'Continue'
              : `Add ${selectedCount === 1 ? 'this folder' : `${selectedCount} folders`}`}
        </button>
        <button type="button" className="secondary" onClick={() => void skip()} disabled={busy}>
          Skip for now
        </button>
      </div>
    </section>
  );
}

/** Pictures and Documents preselected; the shared library and existing projects left out. */
export function choicesFrom(res: WellKnownFoldersResponse): FolderChoice[] {
  const out: FolderChoice[] = [];
  for (const folder of res.folders) {
    if (!folder.exists || folder.forbidden || folder.projectId || folder.sharedLibrary) continue;
    if (folder.kind !== 'pictures' && folder.kind !== 'documents' && folder.kind !== 'desktop') {
      continue;
    }
    if (folder.census && folder.census.files === 0) continue;
    out.push({
      path: folder.path,
      label: folder.label,
      kind: folder.kind,
      ...(folder.census ? { census: folder.census } : {}),
      ...(folder.cloud ? { cloud: folder.cloud } : {}),
      selected: folder.kind === 'pictures' || folder.kind === 'documents',
    });
  }
  for (const code of (res.codeFolders ?? []).slice(0, 4)) {
    if (code.projectId) continue;
    out.push({
      path: code.path,
      label: code.name,
      kind: 'code',
      ...(code.census ? { census: code.census } : {}),
      selected: false,
    });
  }
  return out;
}

/** Whether Home should offer the folder step: not yet done, and no folder added yet. */
export function shouldOfferFolderStep(
  config: ConfigResponse | null,
  projects: Array<{ workingDir?: string; properties?: Record<string, string> }>,
): boolean {
  if (!config || config.onboarding?.foldersStepDoneAt) return false;
  return !projects.some((p) => Boolean(p.workingDir) && !isSharedLibraryProject(p));
}
