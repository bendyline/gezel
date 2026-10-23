import type {
  ChatEventEnvelope,
  Lookout,
  LookoutAction,
  LookoutFiring,
  LookoutListResponse,
  LookoutWithStatus,
} from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { formatAbsoluteTime, formatRelativeTime } from '../../relative-time.js';
import { streamSharedProjectChatEvents } from '../../shared-chat-events.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { type LookoutChoices, LookoutSentenceBuilder } from './LookoutSentenceBuilder.js';
import './lookouts.css';

const ACTION_WORDS: Record<LookoutAction['kind'], string> = {
  notify: 'tell me',
  sound: 'play a sound',
  speak: 'say something',
  push: 'send to my phone',
  email: 'email',
  'ask-gezel': 'ask a gezel',
  'run-craftbook': 'run a craftbook',
};

function conditionWords(lookout: Lookout): string {
  const c = lookout.condition;
  if (c.kind === 'motion') return 'anything moving';
  if (c.kind === 'subject') {
    return c.subjects.includes('person') ? 'a person' : 'a pet';
  }
  return `“${c.question}”${c.strictness === 'sure' ? ' (clearly)' : ''}`;
}

function sentence(lookout: Lookout, cameraName: string): string {
  const actions = lookout.actions.map((a) =>
    a.kind === 'sound' ? `play the ${a.clip}` : ACTION_WORDS[a.kind],
  );
  const then =
    actions.length <= 1
      ? (actions[0] ?? '')
      : `${actions.slice(0, -1).join(', ')} and ${actions[actions.length - 1]}`;
  return `When ${cameraName} sees ${conditionWords(lookout)}, ${then}.`;
}

function outcomeWords(firing: LookoutFiring): string {
  if (!firing.settled) return 'Running…';
  return firing.outcomes
    .map((o) => {
      const what = ACTION_WORDS[o.action as LookoutAction['kind']] ?? o.action;
      if (o.status === 'done') return `${what}: done${o.reason ? ` (${o.reason})` : ''}`;
      return `${what}: ${o.status === 'held' ? 'held' : o.status === 'skipped' ? 'skipped' : 'failed'} — ${o.reason ?? ''}`;
    })
    .join(' · ');
}

function FiringFrame({ projectId, path }: { projectId: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let current: string | null = null;
    let stopped = false;
    void api
      .fetchProjectArtifactBlob(projectId, path)
      .then((blob) => {
        if (stopped) return;
        current = URL.createObjectURL(blob);
        setUrl(current);
      })
      .catch(() => {});
    return () => {
      stopped = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [projectId, path]);
  return url ? (
    <img className="lookout-firing-frame" src={url} alt="What the camera saw" />
  ) : (
    <span className="lookout-firing-frame lookout-firing-frame--empty" aria-hidden="true" />
  );
}

/**
 * The project's lookouts: what each one watches for and does, when it last
 * acted and why anything was held, and the sentence builder to add one.
 * Shown once the project has a camera.
 */
export function ProjectLookoutsSection({ projectId }: { projectId: string }) {
  const [data, setData] = useState<LookoutListResponse | null>(null);
  const [choices, setChoices] = useState<LookoutChoices | null>(null);
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, connectors] = await Promise.all([
        api.listLookouts(projectId),
        api.listConnectors(projectId),
      ]);
      setData(list);
      setChoices((current) => ({
        cameras: connectors.bindings
          .filter((b) => b.driver === 'device')
          .map((b) => ({ id: b.id, name: b.displayName || 'Camera' })),
        mailAccounts: connectors.bindings
          .filter((b) => b.type.startsWith('mail-'))
          .map((b) => ({ id: b.id, name: b.displayName || b.type })),
        gezels: current?.gezels ?? [],
        craftbooks: current?.craftbooks ?? [],
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    void Promise.all([
      api.listGezels().catch(() => ({ gezels: [] })),
      api.listProjectCraftbooks(projectId).catch(() => ({ items: [] })),
    ]).then(([g, c]) =>
      setChoices((current) => ({
        cameras: current?.cameras ?? [],
        mailAccounts: current?.mailAccounts ?? [],
        gezels: (g.gezels as Array<{ id: string; name: string }>).map((x) => ({
          id: x.id,
          name: x.name,
        })),
        craftbooks: (c.items as Array<{ manifest: { id: string; name: string } }>).map((x) => ({
          id: x.manifest.id,
          name: x.manifest.name,
        })),
      })),
    );
  }, [refresh, projectId]);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        for await (const env of streamSharedProjectChatEvents({
          url: api.projectEventsUrl(projectId),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const ev = (env as ChatEventEnvelope).event;
          if (ev.type === 'lookouts_updated' && ev.projectId === projectId) void refresh();
        }
      } catch {
        /* stream ended */
      }
    })();
    return () => ctrl.abort();
  }, [projectId, refresh]);

  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await work();
      if (done) setNotice(done);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!data || !choices) return null;
  if (choices.cameras.length === 0 && data.lookouts.length === 0) return null;

  const cameraName = (id: string) => choices.cameras.find((c) => c.id === id)?.name ?? 'the camera';
  const nameOf = (id: string) => data.lookouts.find((l) => l.id === id)?.name ?? 'A lookout';

  const row = (lookout: LookoutWithStatus) => {
    const snoozed = lookout.snoozedUntil && Date.parse(lookout.snoozedUntil) > Date.now();
    const proposed = lookout.state === 'proposed';
    if (editing === lookout.id) {
      return (
        <li key={lookout.id}>
          <LookoutSentenceBuilder
            choices={choices}
            initial={lookout}
            busy={busy === lookout.id}
            onCancel={() => setEditing(null)}
            onSave={(input) =>
              void run(lookout.id, async () => {
                await api.updateLookout(projectId, lookout.id, input);
                setEditing(null);
              })
            }
          />
        </li>
      );
    }
    return (
      <li key={lookout.id} className="lookout-row">
        <div className="lookout-row-text">
          <strong>{lookout.name}</strong>
          {proposed ? <span className="badge">Proposed by a gezel</span> : null}
          {!proposed && !lookout.enabled ? <span className="badge">Off</span> : null}
          {snoozed ? <span className="badge">Snoozed</span> : null}
          <div className="small">{sentence(lookout, cameraName(lookout.source.bindingId))}</div>
          <div className="small muted">
            {lookout.lastFiredAt
              ? `Last acted ${formatRelativeTime(lookout.lastFiredAt)} · ${lookout.firedToday} today (at most ${lookout.limits.maxPerDay})`
              : 'Has not acted yet.'}
            {lookout.activeHours
              ? ` · only ${lookout.activeHours.from}–${lookout.activeHours.to}`
              : ''}
          </div>
        </div>
        <div
          className="gz-tray lookout-row-actions"
          role="toolbar"
          aria-label={`Actions for ${lookout.name}`}
        >
          {proposed ? (
            <button
              type="button"
              className="gz-key lookout-key-accent"
              disabled={busy === lookout.id}
              onClick={() =>
                void run(
                  lookout.id,
                  () => api.approveLookout(projectId, lookout.id),
                  'Lookout approved.',
                )
              }
            >
              Approve
            </button>
          ) : (
            <button
              type="button"
              className="gz-key"
              disabled={busy === lookout.id}
              onClick={() =>
                void run(lookout.id, () =>
                  api.updateLookout(projectId, lookout.id, { enabled: !lookout.enabled }),
                )
              }
            >
              {lookout.enabled ? 'Turn off' : 'Turn on'}
            </button>
          )}
          <button
            type="button"
            className="gz-key"
            disabled={busy === lookout.id || proposed}
            onClick={() =>
              void run(
                lookout.id,
                () => api.testLookout(projectId, lookout.id),
                'Tested: its sounds and alerts ran; AI follow-ups only reported what they would do.',
              )
            }
          >
            Test
          </button>
          <button
            type="button"
            className="gz-key"
            disabled={busy === lookout.id}
            onClick={() =>
              void run(lookout.id, () =>
                api.snoozeLookout(projectId, lookout.id, snoozed ? null : 60),
              )
            }
          >
            {snoozed ? 'Wake' : 'Snooze 1 hour'}
          </button>
          <button
            type="button"
            className="gz-key"
            disabled={busy === lookout.id}
            onClick={() => setEditing(lookout.id)}
          >
            Edit
          </button>
          <button
            type="button"
            className="gz-key"
            disabled={busy === lookout.id}
            onClick={() => setConfirmDelete(lookout.id)}
          >
            Remove
          </button>
        </div>
      </li>
    );
  };

  return (
    <section className="settings-section lookouts-section" aria-labelledby="project-lookouts-title">
      <div className="gz-mail-header">
        <h3 id="project-lookouts-title">Lookouts</h3>
        {editing !== 'new' && choices.cameras.length > 0 ? (
          <button type="button" onClick={() => setEditing('new')}>
            Add a lookout
          </button>
        ) : null}
      </div>
      {data.paused ? (
        <p className="small camera-setup-notice">
          Every lookout is paused (Settings). Cameras keep watching, but nothing acts on what they
          see.
        </p>
      ) : null}
      {data.lookouts.length === 0 && editing !== 'new' ? (
        <p className="muted">
          Tell a camera what to keep a lookout for and what to do when it sees it — play a sound,
          tell you, or have a gezel follow up.
        </p>
      ) : (
        <ul className="settings-list">{data.lookouts.map(row)}</ul>
      )}
      {editing === 'new' ? (
        <LookoutSentenceBuilder
          choices={choices}
          busy={busy === 'new'}
          onCancel={() => setEditing(null)}
          onSave={(input) =>
            void run(
              'new',
              async () => {
                await api.createLookout(projectId, input);
                setEditing(null);
              },
              'Lookout added.',
            )
          }
        />
      ) : null}

      {data.firings.length > 0 ? (
        <div className="settings-subsection">
          <h4>Recently</h4>
          <ul className="lookout-firings">
            {data.firings.slice(0, 10).map((f) => (
              <li
                key={f.id}
                className={`lookout-firing${f.feedback ? ' lookout-firing--dismissed' : ''}`}
              >
                {f.frame ? <FiringFrame projectId={projectId} path={f.frame} /> : null}
                <div>
                  <div>
                    <strong>
                      {f.test ? `Test: ${f.lookoutName}` : nameOf(f.lookoutId) || f.lookoutName}
                    </strong>{' '}
                    <span className="muted small" title={formatAbsoluteTime(f.at)}>
                      {formatRelativeTime(f.at)}
                    </span>
                  </div>
                  {f.summary ? (
                    <div className="small muted">The camera's model saw: “{f.summary}”</div>
                  ) : null}
                  <div className="small">
                    {f.interrupted ? 'Interrupted when Gezel stopped.' : outcomeWords(f)}
                  </div>
                </div>
                {!f.test ? (
                  <button
                    type="button"
                    className="lookout-firing-feedback"
                    disabled={busy === f.id}
                    onClick={() =>
                      void run(f.id, () =>
                        api.lookoutFeedback(projectId, f.id, f.feedback ? null : 'false-alarm'),
                      )
                    }
                  >
                    {f.feedback ? 'Undo' : 'Not this'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <p className="error small">{error}</p> : null}
      {notice ? <p className="muted small">{notice}</p> : null}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Remove lookout?"
        message="It stops watching for this. What it already recorded stays."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(null);
          if (id) void run(id, () => api.deleteLookout(projectId, id));
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  );
}
