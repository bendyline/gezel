import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeurmeesterCaseRecord } from '@bendyline/gezel';
import { KeurmeesterCaseRecordSchema, createLogger } from '@bendyline/gezel';
import { keurmeesterCasesDir } from '@bendyline/gezel/paths';

const log = createLogger('keurmeester');

/**
 * Append-only JSONL store for Keurmeester intervention case records,
 * monthly-sharded at `~/.gezel/keurmeester/cases/YYYY-MM.jsonl`. A
 * deliberate Store carve-out (see AGENTS.md) — same posture as
 * `history.jsonl`: no rewrites, no atomic-replace contract, owned
 * entirely by this module. Records are the raw material for the debug
 * harvest (digest reports) and for eval postmortems.
 */
export class KeurmeesterCaseStore {
  constructor(private readonly home: string) {}

  private shardPath(ts: string): string {
    // `ts` is ISO — shard on its YYYY-MM prefix so appends never need
    // a clock of their own and tests can pin timestamps.
    const shard = ts.slice(0, 7) || 'unknown';
    return join(keurmeesterCasesDir(this.home), `${shard}.jsonl`);
  }

  async append(record: KeurmeesterCaseRecord): Promise<void> {
    const parsed = KeurmeesterCaseRecordSchema.parse(record);
    await mkdir(keurmeesterCasesDir(this.home), { recursive: true });
    await appendFile(this.shardPath(parsed.ts), `${JSON.stringify(parsed)}\n`, 'utf8');
  }

  /**
   * Read every record with `ts >= sinceIso` (all records when omitted),
   * oldest first. Malformed lines are skipped with a warning — an
   * interrupted append must never poison the whole harvest.
   */
  async read(sinceIso?: string): Promise<KeurmeesterCaseRecord[]> {
    let files: string[];
    try {
      files = await readdir(keurmeesterCasesDir(this.home));
    } catch {
      return [];
    }
    const out: KeurmeesterCaseRecord[] = [];
    for (const file of files.filter((f) => f.endsWith('.jsonl')).sort()) {
      const raw = await readFile(join(keurmeesterCasesDir(this.home), file), 'utf8').catch(
        () => '',
      );
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = KeurmeesterCaseRecordSchema.parse(JSON.parse(line));
          if (!sinceIso || record.ts >= sinceIso) out.push(record);
        } catch (err) {
          log.warn(
            `skipping malformed case line in ${file}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    return out;
  }
}
