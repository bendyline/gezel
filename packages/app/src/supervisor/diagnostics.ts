import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const MAX_ERROR_DIAGNOSTIC_CHARS = 2_000;

/**
 * Keep operational errors useful without copying credentials into either the
 * durable service log or the renderer's fatal-connection detail.
 */
export function formatDiagnosticError(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];

  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || seen.has(value)) return;
    if (value && (typeof value === 'object' || typeof value === 'function')) seen.add(value);

    if (!(value instanceof Error)) {
      parts.push(redactDiagnosticText(String(value)));
      return;
    }

    const candidate = value as Error & {
      code?: unknown;
      errno?: unknown;
      syscall?: unknown;
    };
    const metadata = [candidate.code, candidate.errno, candidate.syscall]
      .filter(
        (item): item is string | number => typeof item === 'string' || typeof item === 'number',
      )
      .map(String)
      .filter((item, index, all) => all.indexOf(item) === index);
    const label = `${candidate.name || 'Error'}${metadata.length > 0 ? ` [${metadata.join(', ')}]` : ''}: ${candidate.message}`;
    parts.push(redactDiagnosticText(label));

    if (candidate instanceof AggregateError) {
      for (const nested of candidate.errors.slice(0, 3)) visit(nested, depth + 1);
    }
    if (candidate.cause !== undefined) visit(candidate.cause, depth + 1);
  };

  visit(error, 0);
  return truncateDiagnostic(parts.filter(Boolean).join(' <- '));
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|access_token|auth_token|api_key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(
      /((?:token|access[_-]?token|auth[_-]?token|api[_-]?key|authorization|password|secret)\s*[=:]\s*)["']?[^\s,;"']+["']?/gi,
      '$1[REDACTED]',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateDiagnostic(value: string): string {
  if (value.length <= MAX_ERROR_DIAGNOSTIC_CHARS) return value;
  return `${value.slice(0, MAX_ERROR_DIAGNOSTIC_CHARS - 1)}…`;
}

export interface OwnedChildDiagnosticOptions {
  platform?: NodeJS.Platform;
  readText?: (path: string) => Promise<string>;
}

/**
 * Describe only the process fields that help distinguish a late Node child
 * event from a genuinely wedged Linux process. In particular, `State: D` and
 * `wchan` make an uninterruptible kernel-I/O stall visible after the fact.
 */
export async function describeOwnedChildState(
  child: ChildProcess | undefined,
  options: OwnedChildDiagnosticOptions = {},
): Promise<string> {
  if (!child) return 'child=none';
  const pid = Number.isInteger(child.pid) && (child.pid ?? 0) > 0 ? child.pid! : null;
  const fields = [
    `pid=${pid ?? 'unknown'}`,
    `killed=${child.killed}`,
    `exitCode=${child.exitCode ?? 'null'}`,
    `signalCode=${child.signalCode ?? 'null'}`,
  ];
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux' || pid === null) return fields.join(' ');

  const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'));
  const [status, wchan] = await Promise.allSettled([
    readText(`/proc/${pid}/status`),
    readText(`/proc/${pid}/wchan`),
  ]);

  if (status.status === 'rejected') {
    fields.push(`procStatus=unavailable(${formatDiagnosticError(status.reason)})`);
    return fields.join(' ');
  }

  const selected = selectedProcStatus(status.value);
  if (selected.length > 0) fields.push(...selected);
  const trimmedWchan = wchan.status === 'fulfilled' ? wchan.value.trim() : '';
  if (trimmedWchan) fields.push(`wchan=${redactDiagnosticText(trimmedWchan)}`);
  return fields.join(' ');
}

function selectedProcStatus(status: string): string[] {
  const wanted = new Set(['Name', 'State', 'PPid', 'Threads', 'VmRSS', 'VmSwap']);
  const fields: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (!wanted.has(key)) continue;
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/\s+/g, ' ');
    if (value) fields.push(`${key}=${redactDiagnosticText(value)}`);
  }
  return fields;
}
