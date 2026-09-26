import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RetrievalOracle } from '../retrieval-facts.ts';

/**
 * Fact oracles for the annotated-work scenarios: which figures a deliverable
 * must carry (from the golden document) and which it must not (from the
 * decoys). Deterministic by design — the question is whether the right
 * material reached the work, and a checkable figure answers that without a
 * judge. The A/B bin re-grades every trial from its run directory with the
 * same oracle the scenario used, so a pass and a score never disagree.
 */

export interface OracleFact {
  id: string;
  label: string;
  /** Any one of these surface forms counts. */
  required: readonly string[];
}

export type OracleDeliverable =
  | { kind: 'workspace-file'; path: string }
  | { kind: 'final-reply'; gezelName: string };

export interface AnnotatedOracle {
  scenarioId: string;
  facts: readonly OracleFact[];
  forbidden: readonly string[];
  deliverable: OracleDeliverable;
  retrieval: RetrievalOracle;
}

export interface OracleGrade {
  /** Share of facts present; 1 when the oracle names none. Null without a deliverable. */
  factScore: number | null;
  found: string[];
  missing: string[];
  forbiddenHits: string[];
  deliverableFound: boolean;
}

export function gradeText(text: string | null, oracle: AnnotatedOracle): OracleGrade {
  if (text === null) {
    return {
      factScore: null,
      found: [],
      missing: oracle.facts.map((fact) => fact.id),
      forbiddenHits: [],
      deliverableFound: false,
    };
  }
  const haystack = text.toLowerCase();
  const found = oracle.facts.filter((fact) =>
    fact.required.some((form) => haystack.includes(form.toLowerCase())),
  );
  return {
    factScore: oracle.facts.length === 0 ? 1 : found.length / oracle.facts.length,
    found: found.map((fact) => fact.id),
    missing: oracle.facts.filter((fact) => !found.includes(fact)).map((fact) => fact.id),
    forbiddenHits: oracle.forbidden.filter((form) => haystack.includes(form.toLowerCase())),
    deliverableFound: true,
  };
}

/** The deliverable's text from a captured run directory, or null when it was never produced. */
export function deliverableTextFromRunDir(runDir: string, oracle: AnnotatedOracle): string | null {
  if (oracle.deliverable.kind === 'workspace-file') {
    const root = join(runDir, 'workspace');
    if (!existsSync(root)) return null;
    for (const project of readdirSync(root)) {
      const path = join(root, project, oracle.deliverable.path);
      if (existsSync(path)) return readFileSync(path, 'utf8');
    }
    return null;
  }
  const sessionsDir = join(runDir, 'sessions');
  if (!existsSync(sessionsDir)) return null;
  // Dumps are `<gezelId>--<sessionId>.json`; a gezel id is its name, lowercased,
  // with a suffix when the name was taken.
  const prefix = oracle.deliverable.gezelName.toLowerCase();
  let latest: { at: string; text: string } | null = null;
  for (const name of readdirSync(sessionsDir)) {
    const gezelId = name.split('--')[0]?.toLowerCase() ?? '';
    if (!gezelId.startsWith(prefix) || !name.endsWith('.json')) continue;
    try {
      const session = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8')) as {
        messages?: Array<{ role?: string; content?: string; at?: string }>;
      };
      const reply = [...(session.messages ?? [])]
        .reverse()
        .find((message) => message.role === 'assistant' && message.content?.trim());
      if (reply && (!latest || (reply.at ?? '') > latest.at)) {
        latest = { at: reply.at ?? '', text: reply.content ?? '' };
      }
    } catch {
      /* partial dump */
    }
  }
  return latest?.text ?? null;
}
