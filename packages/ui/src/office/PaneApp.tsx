import { providerUsesManagedMcpBridge } from '@bendyline/gezel';
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Root } from 'react-dom/client';
import { providerLabel } from '../components/provider-label.js';
import { APP_SURFACE_PARAM } from '../embedded/app-surface.js';
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

function relayLabel(status: RelayStatus, gezelName: string | undefined): string {
  switch (status) {
    case 'connecting':
      return 'Connecting the document…';
    case 'connected':
      return gezelName ? `${gezelName} can read this document` : 'The document is connected';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'closed':
      return 'Document tools are off';
  }
}

/**
 * The pane once connected: a slim header (project, who you are talking to,
 * whether gezels may edit) over the chat. The chat is the main UI's
 * `?embedded=chat` page in a same-origin frame, reading the pane's token
 * from this origin's storage. The pane also offers the document tools to
 * the gezel it talks to for as long as it is open, in the threads its own
 * chat drives: the frame stamps every message with `surfaceId`, the id the
 * tools are registered under.
 */
export function chatFrameUrl(projectId: string, gezelId: string, surfaceId: string): string {
  const params = new URLSearchParams({ embedded: 'chat', compact: '1', projectId });
  if (gezelId) params.set('gezelId', gezelId);
  params.set(APP_SURFACE_PARAM, surfaceId);
  return `/?${params.toString()}`;
}

export function OfficePane({ ready, host }: { ready: PaneReady; host: OfficeHostApp }) {
  const [project, setProject] = useState<PaneProject>(ready.project);
  const [path, setPath] = useState(ready.documentPath);
  const [gezelId, setGezelId] = useState(ready.gezelId);
  const [edits, setEdits] = useState(ready.edits);
  const [roster, setRoster] = useState<RosterGezel[]>([]);
  const [relayStatus, setRelayStatus] = useState<RelayStatus>('connecting');
  const [unauthorized, setUnauthorized] = useState(false);
  // One per pane: a second document's pane, or this one reopened, is a
  // different surface, so its tools never reach this pane's threads.
  const [surfaceId] = useState(() => crypto.randomUUID());
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
  const toolsRef = useRef(tools);
  toolsRef.current = tools;

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

  // One relay per project and gezel: the tools are bound to the project they
  // serve and offered only to the gezel this pane talks to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tools change through update(), not a new relay.
  useEffect(() => {
    if (!gezelId) {
      setRelayStatus('closed');
      return;
    }
    let closed = false;
    let relay: OfficeRelay | null = null;
    const sent = toolsRef.current;
    void startOfficeRelay({
      baseUrl,
      token: ready.token,
      projectId: project.id,
      gezelId,
      surfaceId,
      label: `${OFFICE_HOST_LABELS[host]}: ${documentTitle(path)}`,
      tools: sent,
      onStatus: setRelayStatus,
      onUnauthorized: () => setUnauthorized(true),
    })
      .then((r) => {
        if (closed) {
          void r.close();
          return;
        }
        relay = r;
        relayRef.current = r;
        // "Allow edits" switched while the relay was still connecting: the
        // update below found no relay then, so the old tools went out.
        if (toolsRef.current !== sent) void r.update(toolsRef.current).catch(() => undefined);
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
  }, [project.id, gezelId]);

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

  const chosen = roster.find((g) => g.id === gezelId);
  const provider = chosen ? (chosen.provider ?? ready.defaultProvider) : undefined;
  // Copilot and the CLI providers run their own tool loop, which cannot
  // reach tools an app registers; the daemon withholds them, so say so here.
  const outOfReach = provider !== undefined && !providerUsesManagedMcpBridge(provider);
  const relayTitle =
    outOfReach && chosen
      ? `${chosen.name} cannot use document tools`
      : relayLabel(relayStatus, chosen?.name);

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
            className={`office-pane-relay office-pane-relay--${outOfReach ? 'closed' : relayStatus}`}
            role="img"
            aria-label={relayTitle}
            title={relayTitle}
          />
        </div>
      </header>
      {outOfReach && chosen && provider && (
        <output className="office-pane-notice">
          {chosen.name} runs on {providerLabel(provider)}, which can't reach this document. Choose
          another gezel to read or edit it.
        </output>
      )}
      <iframe
        key={`${project.id}:${gezelId}`}
        className="office-pane-chat"
        title="Gezel chat"
        src={chatFrameUrl(project.id, gezelId, surfaceId)}
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
