import { type GezelGrowthState, GezelGrowthStateSchema } from '../schemas/growth.js';
import { gezelRoot, requireGezel } from './gezels.js';
import { listMemoryDays, readMemoryDay } from './memories.js';
import { type MemoryKind, USER_MEMORY_ID, parseMemoryDay } from './memory-markdown.js';
import type { PortableRepository } from './repository.js';
import { getSession, listSessions } from './sessions.js';

/** A gezel's growth sheet on the phone: `gezels/<id>/growth.json`, as on the desktop. */
export function growthPath(gezelId: string): string {
  return `${gezelRoot(gezelId)}/growth.json`;
}

export async function readGezelGrowth(
  repo: PortableRepository,
  gezelId: string,
): Promise<GezelGrowthState> {
  return (
    (await repo.tolerantRecord(
      growthPath(gezelId),
      GezelGrowthStateSchema,
      `growth for ${gezelId}`,
    )) ?? GezelGrowthStateSchema.parse({})
  );
}

export async function writeGezelGrowth(
  repo: PortableRepository,
  gezelId: string,
  state: GezelGrowthState,
): Promise<void> {
  await requireGezel(repo, gezelId);
  await repo.transactions.commit(
    new Map([[growthPath(gezelId), repo.json(GezelGrowthStateSchema.parse(state))]]),
  );
}

/**
 * Everything this gezel wrote down: its own notes, and the notes about the
 * person it saved to the shared "About you" scope (their source names it).
 */
export async function authoredMemoryEntries(
  repo: PortableRepository,
  gezelId: string,
): Promise<{ day: string; kind: MemoryKind; text: string }[]> {
  const entries: { day: string; kind: MemoryKind; text: string }[] = [];
  for (const day of await listMemoryDays(repo, 'gezel', gezelId))
    for (const block of parseMemoryDay(await readMemoryDay(repo, 'gezel', gezelId, day)))
      entries.push({ day, kind: block.kind, text: block.text });
  for (const day of await listMemoryDays(repo, 'user', USER_MEMORY_ID))
    for (const block of parseMemoryDay(await readMemoryDay(repo, 'user', USER_MEMORY_ID, day)))
      if (block.source?.gezel === gezelId)
        entries.push({ day, kind: block.kind, text: block.text });
  return entries;
}

/**
 * The phone's consultations: messages another gezel delivered into this
 * gezel's conversations, counted per day (the desktop counts its
 * `gezel.message.delivered` history events; the phone keeps no history log).
 */
export async function consultationsByDay(
  repo: PortableRepository,
  gezelId: string,
): Promise<Map<string, number>> {
  const byDay = new Map<string, number>();
  for (const summary of await listSessions(repo, { gezelId })) {
    const session = await getSession(repo, gezelId, summary.id);
    for (const message of session?.messages ?? []) {
      if (message.role !== 'user' || !message.from) continue;
      const day = message.at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
  }
  return byDay;
}
