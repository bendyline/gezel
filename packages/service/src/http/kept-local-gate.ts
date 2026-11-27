/**
 * Who may be handed connector data that stays on models on this computer.
 *
 * The person's own app may. A gezel session may when its model runs here, and
 * from then on the conversation stays here too. Everyone else (a session on a
 * cloud model, an outside AI app, an app grant) may not: Gezel cannot see
 * where they would send it. Every route that opens, lists or searches
 * artifacts for a caller asks this.
 */

import { type KeptLocalSource, createLogger } from '@bendyline/gezel';
import type { Context } from 'hono';
import {
  type KeptLocalArea,
  KeptLocalData,
  keptLocalRefusal,
  uniqueSources,
} from '../connectors/kept-local.js';
import { keptMemoryTag } from '../memory/daily-markdown.js';
import { isOwnerCaller } from './auth.js';
import type { ServiceContext } from './context.js';

const log = createLogger('kept-local');

/** The gezel session behind a request, when one is. */
export function callerSessionId(c: Context): string | null {
  const auth = c.get('auth');
  return auth?.scopes.includes('session') && auth.appId.startsWith('session:')
    ? auth.appId.slice('session:'.length)
    : null;
}

export class KeptLocalGate {
  private shownSources: KeptLocalSource[] = [];

  constructor(
    private readonly data: KeptLocalData,
    readonly projectId: string,
    private readonly areas: readonly KeptLocalArea[],
    /** The caller's model may not see any of it. */
    readonly withheld: boolean,
    private readonly mark: ((sources: KeptLocalSource[]) => Promise<void>) | null,
  ) {}

  /** Whether an entry must be left out of what the caller is given. */
  hidesPath(artifactPath: string): boolean {
    const area = this.data.areaForPath(this.areas, artifactPath);
    if (!area) return false;
    if (this.withheld) return true;
    this.shownSources.push(area.source);
    return false;
  }

  /**
   * Why the caller may not open this artifact, or null. `file` is the absolute
   * path the read will open, when the route knows it.
   */
  async refusal(artifactPath: string, file?: string | null): Promise<string | null> {
    const area =
      this.data.areaForPath(this.areas, artifactPath) ??
      (file ? await this.data.areaForFile(this.projectId, this.areas, file) : undefined);
    if (!area) return null;
    if (this.withheld) return keptLocalRefusal([area.source]);
    this.shownSources.push(area.source);
    return null;
  }

  /** Refuse when the caller could reach any of it, without naming a path. */
  async refusalForAll(): Promise<string | null> {
    if (this.withheld) return keptLocalRefusal(uniqueSources(this.areas.map((a) => a.source)));
    this.shownSources.push(...this.areas.map((a) => a.source));
    return null;
  }

  /** The artifact paths a sandboxed run for this caller must not be granted. */
  get paths(): string[] {
    return this.areas.map((a) => a.path);
  }

  /**
   * Mark the conversation before the answer leaves: once a model on this
   * computer has the data, the session stays with models here.
   */
  async settle(): Promise<void> {
    const sources = uniqueSources(this.shownSources);
    this.shownSources = [];
    if (sources.length > 0 && this.mark) await this.mark(sources);
  }
}

/**
 * The gate for one request, or null when there is nothing to gate: the caller
 * is the person, or the project keeps nothing local (nearly every project).
 */
export async function keptLocalGate(
  ctx: ServiceContext,
  c: Context,
  projectId: string,
): Promise<KeptLocalGate | null> {
  if (isOwnerCaller(c)) return null;
  const data = new KeptLocalData(ctx.store);
  const areas = await data.areas(projectId);
  if (areas.length === 0) return null;
  const sessionId = callerSessionId(c);
  const here = sessionId ? await ctx.chat.sessionRunsOnThisComputer(sessionId) : false;
  if (!here) log.debug(`${projectId}: kept-local data withheld from ${c.get('auth')?.appId}`);
  return new KeptLocalGate(
    data,
    projectId,
    areas,
    !here,
    sessionId && here ? (sources) => ctx.chat.markKeptLocal(sessionId, sources) : null,
  );
}

/** Why this caller may not open this artifact, or null. Marks the session when it may. */
export async function keptLocalFileRefusal(
  ctx: ServiceContext,
  c: Context,
  projectId: string,
  artifactPath: string,
  file?: string | null,
): Promise<string | null> {
  const gate = await keptLocalGate(ctx, c, projectId);
  if (!gate) return null;
  const refused = await gate.refusal(artifactPath, file);
  if (!refused) await gate.settle();
  return refused;
}

/**
 * Whether a caller whose own model is elsewhere may be given text a session
 * on this computer wrote. Owner and on-device callers may; the others not.
 */
export async function callerRunsHere(ctx: ServiceContext, c: Context): Promise<boolean> {
  if (isOwnerCaller(c)) return true;
  const sessionId = callerSessionId(c);
  return sessionId ? ctx.chat.sessionRunsOnThisComputer(sessionId) : false;
}

/** What a session that read kept-local data just wrote into the drawer. */
export async function rememberKeptLocalWrite(
  ctx: ServiceContext,
  c: Context,
  projectId: string,
  paths: readonly string[],
): Promise<void> {
  const sessionId = callerSessionId(c);
  if (!sessionId) return;
  const sources = await ctx.chat.keptLocalSources(sessionId);
  if (sources.length === 0) return;
  await new KeptLocalData(ctx.store).remember(projectId, paths, sources);
}

/** The memory tag for what this caller saves, when its conversation read kept-local data. */
export async function callerKeptTag(ctx: ServiceContext, c: Context): Promise<string | undefined> {
  const sessionId = callerSessionId(c);
  if (!sessionId) return undefined;
  const sources = await ctx.chat.keptLocalSources(sessionId);
  return keptMemoryTag(sources.map((s) => s.bindingId));
}

/** A session on this computer recalled kept-local memories, so it stays too. */
export async function markKeptLocalTags(
  ctx: ServiceContext,
  c: Context,
  tags: readonly string[],
): Promise<void> {
  const sessionId = callerSessionId(c);
  if (sessionId && tags.length > 0) await ctx.chat.markKeptLocalTags(sessionId, tags);
}

/** {@link markKeptLocalTags} for the memories among search results. */
export async function markKeptLocalMemory(
  ctx: ServiceContext,
  c: Context,
  results: readonly { memory?: { kept?: string | undefined } | undefined }[],
): Promise<void> {
  await markKeptLocalTags(
    ctx,
    c,
    results.flatMap((r) => (r.memory?.kept ? [r.memory.kept] : [])),
  );
}

/** A renamed artifact still holds what it held. Written before the move, so a crash keeps it. */
export async function carryKeptLocal(
  ctx: ServiceContext,
  projectId: string,
  from: string,
  to: string,
): Promise<void> {
  const data = new KeptLocalData(ctx.store);
  const area = data.areaForPath(await data.areas(projectId), from);
  if (area) await data.remember(projectId, [to], [area.source]);
}

/**
 * Transcript hits and audit events without those of conversations that read
 * kept-local data, for a caller whose model is elsewhere. A conversation here
 * that is shown one takes on what it holds.
 */
export async function withoutKeptLocalSessions<T>(
  ctx: ServiceContext,
  c: Context,
  items: T[],
  sessionIdOf: (item: T) => string | undefined,
): Promise<T[]> {
  if (isOwnerCaller(c)) return items;
  const here = await callerRunsHere(ctx, c);
  const own = callerSessionId(c);
  const held = new Map<string, KeptLocalSource[]>();
  for (const item of items) {
    const id = sessionIdOf(item);
    if (id && !held.has(id)) held.set(id, await ctx.chat.keptLocalSources(id));
  }
  if (!here) {
    return items.filter((item) => (held.get(sessionIdOf(item) ?? '')?.length ?? 0) === 0);
  }
  if (own) await ctx.chat.markKeptLocal(own, uniqueSources([...held.values()].flat()));
  return items;
}
