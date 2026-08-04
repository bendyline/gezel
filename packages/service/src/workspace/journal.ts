import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { projectPrivateDir } from '@bendyline/gezel/paths';

/**
 * Append-only write journal for gezel mutations against the project
 * workspace. Lives at `~/.gezel/projects/<id>/workspace-writes.jsonl`.
 * Every write/delete/mkdir/rename lands one JSONL line so the user
 * can review exactly what a gezel changed, and so the future git
 * helpers (Phase 3) can stage ONLY paths the journal records —
 * leaving a user's hand-edited files untouched.
 */

export type WorkspaceJournalOp = 'write' | 'delete' | 'mkdir' | 'rename';

export interface WorkspaceJournalEntry {
  at: string;
  op: WorkspaceJournalOp;
  path: string;
  /** For `rename` ops: the previous path. */
  fromPath?: string;
  /** Byte length of the written payload. Writes only. */
  bytes?: number;
  /** sha256 of the written payload. Writes only. */
  sha256?: string;
  /** Gezel that initiated the change — when known. Null for bulk user actions. */
  gezelId?: string;
  /** Chat session this mutation belongs to — when known. */
  sessionId?: string;
}

export interface JournalContext {
  gezelId?: string;
  sessionId?: string;
}

function journalFile(home: string, projectId: string): string {
  return join(projectPrivateDir(home, projectId), 'workspace-writes.jsonl');
}

export async function appendJournalEntry(
  home: string,
  projectId: string,
  op: WorkspaceJournalOp,
  path: string,
  extras: {
    fromPath?: string;
    content?: string | Buffer;
    ctx?: JournalContext;
  } = {},
): Promise<void> {
  const file = journalFile(home, projectId);
  await mkdir(dirname(file), { recursive: true });
  const entry: WorkspaceJournalEntry = {
    at: new Date().toISOString(),
    op,
    path,
    ...(extras.fromPath ? { fromPath: extras.fromPath } : {}),
    ...(extras.content !== undefined
      ? {
          bytes: Buffer.byteLength(extras.content as string | Buffer),
          sha256: sha256(extras.content as string | Buffer),
        }
      : {}),
    ...(extras.ctx?.gezelId ? { gezelId: extras.ctx.gezelId } : {}),
    ...(extras.ctx?.sessionId ? { sessionId: extras.ctx.sessionId } : {}),
  };
  await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * Read the most-recent N entries. Reads the whole journal because it
 * grows slowly (one line per mutation) and projects tend to have
 * hundreds, not millions. Revisit if this becomes hot.
 */
export async function readJournalTail(
  home: string,
  projectId: string,
  limit = 100,
): Promise<WorkspaceJournalEntry[]> {
  try {
    const raw = await readFile(journalFile(home, projectId), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    const out: WorkspaceJournalEntry[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as WorkspaceJournalEntry);
      } catch {
        /* skip malformed line */
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
