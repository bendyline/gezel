import type { InferProjectForPathResponse } from '@bendyline/gezel';
import {
  type HttpDeps,
  type KeyValueStorage,
  clearToken,
  loadToken,
  probeToken,
  registerPane,
  saveToken,
  waitForGrant,
} from './auth.js';
import { readDocChoices, writeDocChoices } from './doc-memory.js';

/**
 * The pane's boot sequence, before any of the chat UI loads: a working
 * token (asking for one the first time), the project for this document,
 * and the gezel to talk to. Pure over `fetch` and a storage, so every
 * branch is testable without Office.
 */

export interface PaneProject {
  id: string;
  name: string;
  readOnly: boolean;
  workingDir?: string;
  voormanGezelId?: string;
  gezelIds?: string[];
}

export interface PaneReady {
  token: string;
  project: PaneProject;
  /** How the project was found (`existing`, `well-known`, `climb`, `parent`, `default`). */
  matchedBy: InferProjectForPathResponse['matchedBy'];
  created: boolean;
  gezelId: string;
  documentPath: string | null;
  edits: boolean;
}

export type BootState =
  | { kind: 'connecting' }
  | { kind: 'code'; code?: string }
  | { kind: 'needs-revoke' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'daemon-down' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; ready: PaneReady };

export interface BootDeps extends HttpDeps {
  storage: KeyValueStorage;
  documentPath: string | null;
  signal?: AbortSignal;
  grantTimeoutMs?: number;
}

async function apiJson<T>(
  deps: HttpDeps,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await deps.fetch(`${deps.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    const err = new Error(
      body.message ?? body.error ?? `Gezel answered ${res.status}.`,
    ) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

function toPaneProject(
  project: NonNullable<InferProjectForPathResponse['project']>,
  readOnly: boolean,
): PaneProject {
  return {
    id: project.id,
    name: project.name,
    readOnly,
    ...(project.workingDir ? { workingDir: project.workingDir } : {}),
    ...(project.voormanGezelId ? { voormanGezelId: project.voormanGezelId } : {}),
    ...(project.gezelIds ? { gezelIds: project.gezelIds } : {}),
  };
}

/** The project that owns this document's folder; see the daemon's folder inference. */
export async function resolveProject(
  deps: HttpDeps,
  token: string,
  path: string | null,
): Promise<{ project: PaneProject; matchedBy: PaneReady['matchedBy']; created: boolean }> {
  const res = await apiJson<InferProjectForPathResponse>(
    deps,
    token,
    '/api/projects/infer-for-path',
    {
      method: 'POST',
      body: JSON.stringify({ ...(path ? { path } : {}), kind: 'document', source: 'office' }),
    },
  );
  if (!res.project) throw new Error('Gezel did not return a project for this document.');
  return {
    project: toPaneProject(res.project, res.readOnly),
    matchedBy: res.matchedBy,
    created: res.created,
  };
}

export interface RosterGezel {
  id: string;
  name: string;
  role?: string;
}

export async function listGezels(deps: HttpDeps, token: string): Promise<RosterGezel[]> {
  const res = await apiJson<{ gezels: RosterGezel[] }>(deps, token, '/api/gezels');
  return res.gezels ?? [];
}

/** Remembered choice, else the project lead, else its first member, else the Meester, else anyone. */
export function pickDefaultGezel(
  project: PaneProject,
  roster: readonly RosterGezel[],
  meesterId: string | undefined,
  remembered: string | undefined,
): string {
  const known = (id: string | undefined): id is string => !!id && roster.some((g) => g.id === id);
  if (known(remembered)) return remembered;
  if (known(project.voormanGezelId)) return project.voormanGezelId;
  const member = project.gezelIds?.find((id) => known(id));
  if (member) return member;
  if (known(meesterId)) return meesterId;
  return roster[0]?.id ?? '';
}

async function obtainToken(
  deps: BootDeps,
  onState: (s: BootState) => void,
): Promise<string | null> {
  const stored = loadToken(deps.storage);
  if (stored) {
    const probe = await probeToken(deps, stored);
    if (probe === 'ok') return stored;
    if (probe === 'down') {
      onState({ kind: 'daemon-down' });
      return null;
    }
    clearToken(deps.storage);
  }
  let registered: Awaited<ReturnType<typeof registerPane>>;
  try {
    registered = await registerPane(deps);
  } catch {
    onState({ kind: 'daemon-down' });
    return null;
  }
  if (registered.kind === 'already-connected') {
    onState({ kind: 'needs-revoke' });
    return null;
  }
  if (registered.kind === 'refused') {
    onState({ kind: 'error', message: registered.message });
    return null;
  }
  if (registered.kind === 'approved') {
    saveToken(deps.storage, registered.token);
    return registered.token;
  }
  onState({ kind: 'code', ...(registered.code ? { code: registered.code } : {}) });
  const outcome = await waitForGrant(deps, registered.grantRequestId, {
    ...(deps.grantTimeoutMs ? { timeoutMs: deps.grantTimeoutMs } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (outcome.kind === 'approved') {
    saveToken(deps.storage, outcome.token);
    return outcome.token;
  }
  onState({ kind: outcome.kind === 'denied' ? 'denied' : 'expired' });
  return null;
}

export async function bootPane(
  deps: BootDeps,
  onState: (s: BootState) => void,
): Promise<PaneReady | null> {
  onState({ kind: 'connecting' });
  const token = await obtainToken(deps, onState);
  if (!token) return null;
  onState({ kind: 'connecting' });
  try {
    const remembered = readDocChoices(deps.storage, deps.documentPath);
    const resolved = await resolveProject(deps, token, deps.documentPath);
    const [roster, config] = await Promise.all([
      listGezels(deps, token),
      apiJson<{ meesterGezelId?: string }>(deps, token, '/api/config').catch(
        () => ({}) as { meesterGezelId?: string },
      ),
    ]);
    const gezelId = pickDefaultGezel(
      resolved.project,
      roster,
      config.meesterGezelId,
      remembered.gezelId,
    );
    const ready: PaneReady = {
      token,
      project: resolved.project,
      matchedBy: resolved.matchedBy,
      created: resolved.created,
      gezelId,
      documentPath: deps.documentPath,
      edits: remembered.edits !== false,
    };
    writeDocChoices(deps.storage, deps.documentPath, { projectId: ready.project.id, gezelId });
    onState({ kind: 'ready', ready });
    return ready;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      clearToken(deps.storage);
      onState({
        kind: 'error',
        message: 'Gezel no longer recognizes this pane. Close and reopen it to connect again.',
      });
    } else {
      onState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }
}
