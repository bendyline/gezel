/**
 * Static prompt-injection pattern scanner. Runs over already-normalized text
 * (see normalize.ts) and scores it for the hallmarks of an injection payload:
 * instruction-override phrases, role/turn markers, agent-directed action verbs,
 * and active payloads (data:/javascript: URIs, long base64 blobs). It is
 * deliberately conservative and pattern-based — it catches the common cases
 * cheaply; the provenance-framing and send-gate layers catch what it misses.
 */

export type Severity = 'low' | 'medium' | 'high';

export interface PatternHit {
  category: string;
  severity: Severity;
  /** The matched substring (capped) for audit/debug. */
  match: string;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { low: 1, medium: 3, high: 6 };

interface PatternDef {
  category: string;
  severity: Severity;
  re: RegExp;
}

const PATTERNS: readonly PatternDef[] = [
  // "ignore the previous instructions", "disregard all prior rules", etc.
  {
    category: 'instruction-override',
    severity: 'high',
    re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|the)\b[^.\n]{0,24}\b(instructions?|prompts?|rules?|context|guidelines?)\b/i,
  },
  { category: 'instruction-override', severity: 'high', re: /\byou are now\b/i },
  { category: 'instruction-override', severity: 'medium', re: /\bnew instructions?\s*:/i },
  { category: 'instruction-override', severity: 'medium', re: /\b(system|developer)\s+prompt\b/i },
  // Chat-template / turn markers that try to forge a new role.
  {
    category: 'role-marker',
    severity: 'high',
    re: /<\|?\/?(im_start|im_end|system|assistant|user)\|?>/i,
  },
  { category: 'role-marker', severity: 'medium', re: /\[\/?INST\]/i },
  { category: 'role-marker', severity: 'low', re: /^\s{0,3}#{2,4}\s*(system|assistant)\b/im },
  // Agent-directed actions — the model is told to exfiltrate or transmit.
  {
    category: 'agent-directed-action',
    severity: 'high',
    re: /\b(send|forward|email|exfiltrate|leak|upload|post)\b[^.\n]{0,40}\b(password|secret|api[ _-]?key|token|credentials?|private key|\.env)\b/i,
  },
  {
    category: 'agent-directed-action',
    severity: 'medium',
    re: /\b(curl|wget)\s+https?:\/\/|\bfetch\(\s*['"]https?:\/\//i,
  },
  // Active payloads embedded in the content.
  { category: 'suspicious-payload', severity: 'medium', re: /\bjavascript:/i },
  { category: 'suspicious-payload', severity: 'medium', re: /\bdata:[\w.+-]+\/[\w.+-]+;base64,/i },
  { category: 'suspicious-payload', severity: 'low', re: /[A-Za-z0-9+/]{256,}={0,2}/ },
];

/** Score normalized text against the injection-pattern set. */
export function scanPatterns(text: string): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (m) hits.push({ category: p.category, severity: p.severity, match: m[0].slice(0, 120) });
  }
  return hits;
}

/** Sum of severity weights for a set of hits. */
export function scoreHits(hits: readonly PatternHit[]): number {
  return hits.reduce((sum, h) => sum + SEVERITY_WEIGHT[h.severity], 0);
}
