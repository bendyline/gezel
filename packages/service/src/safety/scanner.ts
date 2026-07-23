/**
 * Content scanner: the single ingest gate that every piece of untrusted
 * content passes through before it can be indexed and surfaced to the model.
 * It normalizes (stripping invisible carriers), pattern-scans for injection,
 * and returns a verdict: `pass` (index as-is), `annotate` (index but stamp
 * trust + flags so provenance framing escalates), or `quarantine` (do NOT
 * index — divert the raw artifact, index only a stub).
 *
 * It operates on the markdown string, so one implementation covers email bodies
 * and text extracted from attachments uniformly. It is pure and synchronous —
 * no I/O — so it is cheap and trivially testable.
 */

import { normalizeText } from './normalize.js';
import { type PatternHit, scanPatterns, scoreHits } from './patterns.js';

export type TrustLevel = 'untrusted-external';
export type ScanAction = 'pass' | 'annotate' | 'quarantine';
export type ScanOrigin = 'email' | 'attachment';

export interface ScanInput {
  /** The markdown to inspect (email body, or attachment converted to markdown). */
  markdown: string;
  origin: ScanOrigin;
  /** Message-id or source file path, for audit logging. */
  sourceRef: string;
}

export interface ScanVerdict {
  action: ScanAction;
  /** Normalized markdown — always returned, even on `quarantine`. */
  cleaned: string;
  /** Provenance level for this content (always untrusted for email/attachments). */
  trust: TrustLevel;
  /** Carrier categories + injection categories that fired, for `scan_flags`. */
  flags: string[];
  /** Total injection score (sum of pattern severities). */
  score: number;
  hits: PatternHit[];
}

export interface ContentScanner {
  scan(input: ScanInput): ScanVerdict;
}

/** Score at/above which content is quarantined rather than annotated. */
const QUARANTINE_SCORE = 9;

class StaticContentScanner implements ContentScanner {
  scan(input: ScanInput): ScanVerdict {
    const norm = normalizeText(input.markdown);
    const hits = scanPatterns(norm.text);
    const score = scoreHits(hits);
    const categories = new Set(hits.map((h) => h.category));

    // Clear exfiltration attempt: the content both tells the agent to act and
    // carries an active payload to act with — quarantine regardless of score.
    const exfilCombo =
      categories.has('agent-directed-action') && categories.has('suspicious-payload');

    let action: ScanAction;
    if (score >= QUARANTINE_SCORE || exfilCombo) action = 'quarantine';
    else if (score > 0 || norm.flags.length > 0) action = 'annotate';
    else action = 'pass';

    return {
      action,
      cleaned: norm.text,
      trust: 'untrusted-external',
      flags: [...norm.flags, ...categories],
      score,
      hits,
    };
  }
}

/** The default scanner used by the ingest pipeline. */
export const contentScanner: ContentScanner = new StaticContentScanner();
