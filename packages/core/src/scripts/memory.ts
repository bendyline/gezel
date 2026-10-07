import { type MemoryKind, type MemorySource, isMemoryKind } from '../runtime/memory-markdown.js';

/** The longest memory a script may write to the gezel running it. */
export const SCRIPT_GEZEL_MEMORY_MAX_CHARS = 200;

export interface ScriptMemorySave {
  scope: 'gezel' | 'project';
  id: string;
  text: string;
  kind?: MemoryKind;
  source?: MemorySource;
}

/**
 * Resolve a script's `memory.save(text, meta)` call, the same way on every
 * host. Project memory is the default and takes any kind. With
 * `meta.scope: 'gezel'` a scored activity's script writes to the gezel
 * running it: the script decides which outcomes the gezel remembers (a
 * learner's mistake as a `correction`, a strong answer as an `example`), so
 * these entries are short and must name their kind.
 */
export function resolveScriptMemorySave(
  params: unknown,
  run: { projectId: string; gezelId?: string },
): ScriptMemorySave {
  const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const text = typeof p.text === 'string' ? p.text.trim() : '';
  if (!text) throw new Error('memory.save needs a non-empty "text"');
  const meta =
    p.meta && typeof p.meta === 'object' ? (p.meta as Record<string, unknown>) : undefined;
  const kind = typeof meta?.kind === 'string' && isMemoryKind(meta.kind) ? meta.kind : undefined;
  if (meta?.scope === undefined || meta.scope === 'project') {
    return { scope: 'project', id: run.projectId, text, ...(kind ? { kind } : {}) };
  }
  if (meta.scope !== 'gezel') throw new Error('memory.save scope must be "project" or "gezel"');
  if (!run.gezelId)
    throw new Error("memory.save to a gezel's memory runs only when a gezel called the script");
  if (!kind) throw new Error('memory.save to a gezel needs meta.kind, such as "correction"');
  if (text.length > SCRIPT_GEZEL_MEMORY_MAX_CHARS)
    throw new Error(
      `memory.save to a gezel takes at most ${SCRIPT_GEZEL_MEMORY_MAX_CHARS} characters; got ${text.length}`,
    );
  return { scope: 'gezel', id: run.gezelId, text, kind, source: { project: run.projectId } };
}
