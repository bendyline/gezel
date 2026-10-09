import { readFile } from 'node:fs/promises';

export type UserSimulation = 'disabled' | 'scripted' | 'heuristic';
export interface UserScriptEntry {
  kind: 'structured' | 'inline';
  /** Exact question, not a pattern that can accidentally approve another action. */
  prompt: string;
  intentKind?: string;
  answer: { writeIn: string } | { choice: string };
}
export interface QualificationOptions {
  userSimulation: UserSimulation;
  userScript: UserScriptEntry[];
  completionTimeoutMs: number;
}
export const QUALIFICATION_FLAGS = [
  'qualification',
  'user-simulation',
  'user-script',
  'completion-timeout',
] as const;

export function validateQualification(value: QualificationOptions): QualificationOptions {
  if (!['disabled', 'scripted', 'heuristic'].includes(value.userSimulation)) {
    throw new Error('user-simulation must be disabled, scripted, or heuristic');
  }
  if (!Number.isSafeInteger(value.completionTimeoutMs) || value.completionTimeoutMs <= 0) {
    throw new Error('completion-timeout must be a positive duration');
  }
  if (!Array.isArray(value.userScript)) throw new Error('user-script must be a JSON array');
  for (const entry of value.userScript) {
    if (
      !entry ||
      !['structured', 'inline'].includes(entry.kind) ||
      typeof entry.prompt !== 'string' ||
      !entry.prompt
    ) {
      throw new Error('Each user-script entry needs kind (structured|inline) and an exact prompt');
    }
    const answer = entry.answer;
    if (
      !answer ||
      typeof answer !== 'object' ||
      Object.keys(answer).length !== 1 ||
      !('writeIn' in answer
        ? typeof answer.writeIn === 'string'
        : 'choice' in answer && typeof answer.choice === 'string') ||
      (entry.kind === 'inline' && !('writeIn' in answer)) ||
      (entry.intentKind !== undefined && typeof entry.intentKind !== 'string')
    ) {
      throw new Error(
        'Script answers need exactly one writeIn or exact choice; inline answers need writeIn',
      );
    }
  }
  if ((value.userSimulation === 'scripted') !== value.userScript.length > 0) {
    throw new Error('A nonempty user-script is required only with --user-simulation scripted');
  }
  return value;
}

export async function resolveQualificationFlags(
  flags: Record<string, string | boolean>,
): Promise<QualificationOptions | undefined> {
  if (flags.qualification === undefined) {
    if (QUALIFICATION_FLAGS.slice(1).some((key) => flags[key] !== undefined)) {
      throw new Error('User simulation and completion flags require --qualification');
    }
    return undefined;
  }
  if (flags.qualification !== true) throw new Error('--qualification is a boolean flag');
  const duration = flags['completion-timeout'] ?? '2m';
  if (typeof duration !== 'string' || !/^\d+(?:ms|s|m)$/.test(duration)) {
    throw new Error('--completion-timeout needs a duration such as 30s or 2m');
  }
  const multiplier = duration.endsWith('ms') ? 1 : duration.endsWith('s') ? 1000 : 60000;
  if (flags['user-script'] !== undefined && typeof flags['user-script'] !== 'string') {
    throw new Error('--user-script needs a JSON file path');
  }
  return validateQualification({
    userSimulation: (flags['user-simulation'] ?? 'disabled') as UserSimulation,
    userScript:
      typeof flags['user-script'] === 'string'
        ? JSON.parse(await readFile(flags['user-script'], 'utf8'))
        : [],
    completionTimeoutMs: Number.parseInt(duration, 10) * multiplier,
  });
}
