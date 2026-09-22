import type { NormalizedStepGate } from './schemas/gate.js';

import { TEMPLATE_PLACEHOLDER_SOURCE } from './path-rules.js';

/**
 * Gate fields still carrying a `{{param}}` token at evaluation time.
 *
 * Launch interpolation deliberately leaves UNKNOWN placeholders intact so
 * a craftbook typo stays visible rather than silently blanking to an
 * empty string. Visible to a human reading the recipe — but the model on
 * the other end of the gate just sees a rejection it cannot satisfy,
 * because the literal `{{…}}` is being handed to a regex engine or a
 * path resolver. Pull Request Review shipped `PR\s*#{{number}}` that way:
 * the reviewer had written the note correctly, spent three attempts
 * re-deriving why a correct note kept failing, and finally "passed" the
 * gate by writing the raw template token into the task's audit trail.
 *
 * No assignee can repair this, so it is an infrastructure fault — it
 * pauses for a human instead of charging attempts and climbing the
 * repair ladder.
 *
 * The rejection copy has to say that outright. An earlier version told the
 * assignee to "fix the craftbook or relaunch with that parameter", neither of
 * which a gezel can do, and on task gezel/7 the retry took the only remaining
 * reading: it wrote its deliverable to the literal `{{task.dir}}/…` path to
 * make the check match. That is unreachable — this branch returns before any
 * check is evaluated — and it left a real directory named `{{task.dir}}` in
 * the artifacts drawer. `assertNoTemplatePlaceholderPath` now refuses the
 * write; the message names the dead end so it is not attempted.
 */
export function unresolvedGatePlaceholders(gate: NormalizedStepGate): string[] {
  const found: string[] = [];
  const scan = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const hits = value.match(new RegExp(TEMPLATE_PLACEHOLDER_SOURCE, 'g'));
      if (hits) found.push(`${path} (${[...new Set(hits)].join(' ')})`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => scan(entry, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        scan(entry, `${path}.${key}`);
      }
    }
  };
  gate.checks.forEach((check, i) => scan(check, `checks[${i}] ${check.kind}`));
  gate.scripts.forEach((ref, i) => scan(ref.inputs, `scripts[${i}] ${ref.name} inputs`));
  return found;
}
