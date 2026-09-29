import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Root } from 'react-dom/client';
import * as Select from '../primitives/Select.js';
import {
  type PaneProject,
  type PaneReady,
  type RosterGezel,
  listGezels,
  resolveProject,
} from './boot.js';
import { writeDocChoices } from './doc-memory.js';
import {
  OFFICE_HOST_LABELS,
  type OfficeHostApp,
  documentPath,
  documentTitle,
  isRequirementSetSupported,
} from './host.js';
import { type OfficeRelay, type RelayStatus, startOfficeRelay } from './relay.js';
import { toolsForHost } from './tools/index.js';

const RELAY_LABELS: Record<RelayStatus, string> = {
  connecting: 'Connecting the document…',
  connected: 'Gezels can read this document',
  reconnecting: 'Reconnecting…',
  closed: 'Document tools are off',
};

/**
 * The pane once connected: a slim header (project, who you are talking to,
 * whether gezels may edit) over the chat. The chat is the main UI's
 * `?embedded=chat` page in a same-origin frame, reading the pane's token
 * from this origin's storage. The pane also offers the document tools to
 * the project's gezels for as long as it is open.
 */
export function chatFrameUrl(projectId: string, gezelId: string): string {
  const params = new URLSearchParams({ embedded: 'chat', compact: '1', projectId });
  if (gezelId) params.set('gezelId', gezelId);
  return `/?${params.toString()}`;
}

function OfficePane({ ready, host }: { ready: PaneReady; host: OfficeHostApp }) {
  const [project, setProject] = useState<PaneProject>(ready.project);
  const [path, setPath] = useState(ready.documentPath);
  const [gezelId, setGezelId] = useState(ready.gezelId);
  const [edits, setEdits] = useState(ready.edits);
  const [roster, setRoster] = useState<RosterGezel[]>([]);
  const [relayStatus, setRelayStatus] = useState<RelayStatus>('connecting');
  const [unauthorized, setUnauthorized] = useState(false);
  const relayRef = useRef<OfficeRelay | null>(null);
  const baseUrl = window.location.origin;

  const describe = useCallback(
    () => ({
      host: OFFICE_HOST_LABELS[host],
      title: documentTitle(path),
      path,
      projectId: project.id,
      projectName: project.name,
      projectReadOnly: project.readOnly,
      editsEnabled: edits,
    }),
    [host, path, project, edits],
  );
  const describeRef = useRef(describe);
  describeRef.current = describe;

  const tools = useMemo(
    () =>
      toolsForHost({
        host,
        edits,
        describe: () => describeRef.current(),
        isSupported: isRequirementSetSupported,
      }),
    [host, edits],
  );

  useEffect(() => {
    let cancelled = false;
    void listGezels({ fetch: window.fetch.bind(window), baseUrl }, ready.token)
      .then((gezels) => {
        if (!cancelled) setRoster(gezels);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [baseUrl, ready.token]);

  // One relay per project: tools are bound to the project they serve.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tools change through update(), not a new relay.
  useEffect(() => {
    let closed = false;
    let relay: OfficeRelay | null = null;
    void startOfficeRelay({
      baseUrl,
      token: ready.token,
      projectId: project.id,
      label: `${OFFICE_HOST_LABELS[host]}: ${documentTitle(path)}`,
      tools,
      onStatus: setRelayStatus,
      onUnauthorized: () => setUnauthorized(true),
    })
      .then((r) => {
        if (closed) void r.close();
        else {
          relay = r;
          relayRef.current = r;
        }
      })
      .catch(() => setRelayStatus('closed'));
    const onHide = () => void relay?.close();
    window.addEventListener('pagehide', onHide);
    return () => {
      closed = true;
      window.removeEventListener('pagehide', onHide);
      relayRef.current = null;
      void relay?.close();
    };
  }, [project.id]);

  useEffect(() => {
    void relayRef.current?.update(tools).catch(() => undefined);
  }, [tools]);

  // Save As moves the document; its project may change with it.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const current = documentPath();
      if (current === path) return;
      setPath(current);
      void resolveProject({ fetch: window.fetch.bind(window), baseUrl }, ready.token, current)
        .then((resolved) => {
          if (resolved.project.id !== project.id) setProject(resolved.project);
          writeDocChoices(window.localStorage, current, {
            projectId: resolved.project.id,
            gezelId,
          });
        })
        .catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [path, project.id, gezelId, baseUrl, ready.token]);

  const chooseGezel = (id: string) => {
    writeDocChoices(window.localStorage, path, { gezelId: id });
    setGezelId(id);
  };

  const toggleEdits = (on: boolean) => {
    writeDocChoices(window.localStorage, path, { edits: on });
    setEdits(on);
  };

  if (unauthorized) {
    return (
      <div className="office-boot">
        <h1 className="office-boot-title">Disconnected from Gezel</h1>
        <p>
          This pane's connection was removed in Gezel. Close the pane and open it again to
          reconnect.
        </p>
      </div>
    );
  }

  return (
    <div className="office-pane">
      <header className="office-pane-header">
        <div
          className="office-pane-project"
          title={project.workingDir ?? 'No folder: the Default project'}
        >
          <span className="office-pane-project-name">{project.name}</span>
          {project.readOnly && (
            <span
              className="office-pane-badge"
              title="Gezels cannot change files in this folder. They edit this document through the pane."
            >
              Read-only folder
            </span>
          )}
        </div>
        <div className="office-pane-controls">
          {roster.length > 0 && (
            <Select.Root value={gezelId} onValueChange={chooseGezel}>
              <Select.Trigger aria-label="Talk to">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {roster.map((g) => (
                  <Select.Item key={g.id} value={g.id}>
                    {g.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
          <label className="office-pane-edits">
            <input
              type="checkbox"
              checked={edits}
              onChange={(e) => toggleEdits(e.target.checked)}
            />
            <span>Allow edits</span>
          </label>
          <span
            className={`office-pane-relay office-pane-relay--${relayStatus}`}
            role="img"
            aria-label={RELAY_LABELS[relayStatus]}
            title={RELAY_LABELS[relayStatus]}
          />
        </div>
      </header>
      <iframe
        key={`${project.id}:${gezelId}`}
        className="office-pane-chat"
        title="Gezel chat"
        src={chatFrameUrl(project.id, gezelId)}
      />
    </div>
  );
}

export function mountPane(root: Root, ready: PaneReady, host: OfficeHostApp): void {
  root.render(
    <StrictMode>
      <OfficePane ready={ready} host={host} />
    </StrictMode>,
  );
}
