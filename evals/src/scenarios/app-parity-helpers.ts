import type { GezelClient } from '@bendyline/gezel-client';

/** Shared readers for app-parity cases: store files and the crew lead's last reply. */

export interface StoreRecord {
  id?: string;
  status?: string;
  fields?: Record<string, unknown>;
}

export function list(doc: unknown, key: string): Array<Record<string, unknown>> {
  const value = (doc as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** A rosterStore file's records. */
export function records(doc: unknown): StoreRecord[] {
  return list(doc, 'records') as StoreRecord[];
}

export function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** A local calendar date `days` from today, YYYY-MM-DD, as page date fields write it. */
export function isoDaysAhead(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The same calendar date a year (or `months` months) later, as a recurring obligation rolls. */
export function addMonths(day: string, months: number): string {
  const d = new Date(`${day}T12:00:00`);
  const date = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  d.setDate(Math.min(date, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'string'
        ? part
        : part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
    )
    .join('');
}

/** The crew lead's latest reply in the project, once its turn has produced one. */
export async function lastReply(
  client: GezelClient,
  gezelId: string,
  projectId: string,
): Promise<string | null> {
  const { sessions } = await client.listChatSessions({ gezelId, projectId });
  const latest = sessions
    .filter((s) => !s.archived)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  if (!latest) return null;
  const session = await client.getChatSession(latest.id);
  const last = session.messages[session.messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  const text = messageText(last.content).trim();
  return text || null;
}
