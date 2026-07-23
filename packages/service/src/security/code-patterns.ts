/**
 * Built-in static security pattern catalog. Modeled on the prompt-injection
 * scanner shape (`safety/patterns.ts`) — a `{ruleId, category, severity, re}[]`
 * table scanned line-by-line — but SEMANTICALLY DISTINCT: this scans first-party
 * source code for vulnerability hallmarks (sinks, taint sources, secrets, weak
 * crypto), not untrusted ingested content for injection payloads.
 *
 * Deliberately conservative and cheap (regex per line + an entropy pass on string
 * literals): it runs in the per-file indexing hot path. It catches the common,
 * high-signal cases; the opportunistic OSS tools (semgrep/osv/gitleaks) and the
 * craftbook's reasoning layer catch what regex can't. NEVER stores a raw secret
 * value — only a redacted shape — because the finding is persisted to the index DB.
 */

import type { SecurityFindingInput, SecuritySeverity } from '../index-store/index-store.js';

export type SecurityCategory =
  | 'injection'
  | 'command-injection'
  | 'xss'
  | 'ssrf'
  | 'path-traversal'
  | 'deserialization'
  | 'crypto'
  | 'secret'
  | 'taint-source'
  | 'auth';

interface CodePattern {
  ruleId: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  title: string;
  re: RegExp;
}

const EVIDENCE_CAP = 160;

/**
 * The catalog. Regexes are intentionally line-local (no multiline state) so a
 * match yields a precise 1-based line number. Ordered roughly by category.
 */
const CODE_PATTERNS: readonly CodePattern[] = [
  // ── injection: eval / dynamic code ──────────────────────────────────────
  {
    ruleId: 'sink.eval',
    category: 'injection',
    severity: 'high',
    title: 'Dynamic code execution via eval()',
    re: /\beval\s*\(/,
  },
  {
    ruleId: 'sink.function-constructor',
    category: 'injection',
    severity: 'high',
    title: 'Dynamic code execution via new Function()',
    re: /\bnew\s+Function\s*\(/,
  },
  // ── SQL injection: string-built queries with interpolation/concat ───────
  {
    ruleId: 'sink.sql-template',
    category: 'injection',
    severity: 'high',
    title: 'SQL built from a template literal with interpolation',
    re: /\b(query|execute|exec|sql|raw)\s*\(\s*`[^`]*\$\{/i,
  },
  {
    ruleId: 'sink.sql-concat-input',
    category: 'injection',
    severity: 'high',
    title: 'SQL/string concatenated with request input',
    re: /\+\s*req\.(query|body|params|headers)\b/i,
  },
  // ── command injection ───────────────────────────────────────────────────
  {
    ruleId: 'sink.command-exec',
    category: 'command-injection',
    severity: 'high',
    title: 'Shell command from exec()/execSync() — verify args are not attacker-controlled',
    re: /\b(child_process\.)?(exec|execSync)\s*\(/,
  },
  {
    ruleId: 'sink.command-template',
    category: 'command-injection',
    severity: 'high',
    title: 'Shell command built from a template literal with interpolation',
    re: /\b(exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{/,
  },
  // ── XSS ─────────────────────────────────────────────────────────────────
  {
    ruleId: 'sink.innerhtml',
    category: 'xss',
    severity: 'medium',
    title: 'Direct innerHTML assignment (XSS sink)',
    re: /\.innerHTML\s*=/,
  },
  {
    ruleId: 'sink.dangerously-set-html',
    category: 'xss',
    severity: 'medium',
    title: 'React dangerouslySetInnerHTML',
    re: /dangerouslySetInnerHTML/,
  },
  {
    ruleId: 'sink.document-write',
    category: 'xss',
    severity: 'medium',
    title: 'document.write() sink',
    re: /\bdocument\.write(ln)?\s*\(/,
  },
  // ── SSRF ──────────────────────────────────────────────────────────────────
  {
    ruleId: 'sink.outbound-request-input',
    category: 'ssrf',
    severity: 'high',
    title: 'Outbound request to a request-derived URL (SSRF)',
    re: /\b(fetch|axios|got|request|https?\.get|https?\.request)\s*\(\s*[^)]*req\.(query|body|params|headers)/i,
  },
  // ── path traversal ────────────────────────────────────────────────────────
  {
    ruleId: 'sink.fs-read-input',
    category: 'path-traversal',
    severity: 'high',
    title: 'Filesystem read of a request-derived path (path traversal)',
    re: /\b(readFile|readFileSync|createReadStream|sendFile|unlink|writeFile)\s*\(\s*[^)]*req\.(query|body|params)/i,
  },
  {
    ruleId: 'sink.path-join-input',
    category: 'path-traversal',
    severity: 'medium',
    title: 'path.join() with request input — confirm it is confined',
    re: /\bpath\.(join|resolve)\s*\(\s*[^)]*req\.(query|body|params)/i,
  },
  // ── unsafe deserialization ──────────────────────────────────────────────
  {
    ruleId: 'sink.unsafe-deserialize',
    category: 'deserialization',
    severity: 'high',
    title: 'Unsafe deserialization sink',
    re: /\b(yaml\.load\s*\(|unserialize\s*\(|pickle\.loads\s*\(|Marshal\.load\s*\(|ObjectInputStream)\b/,
  },
  // ── weak crypto ─────────────────────────────────────────────────────────
  {
    ruleId: 'crypto.weak-hash',
    category: 'crypto',
    severity: 'medium',
    title: 'Weak hash algorithm (MD5/SHA-1)',
    re: /createHash\s*\(\s*['"](md5|sha1)['"]/i,
  },
  {
    ruleId: 'crypto.insecure-random-secret',
    category: 'crypto',
    severity: 'medium',
    title: 'Math.random() used near a token/secret/key (not cryptographically secure)',
    re: /\b(token|secret|key|password|nonce|salt|otp)\b[^\n]{0,40}Math\.random\s*\(|Math\.random\s*\([^\n]{0,40}\b(token|secret|key|password|nonce|salt|otp)\b/i,
  },
  // ── secrets (shape-based; entropy handled separately) ───────────────────
  {
    ruleId: 'secret.aws-access-key',
    category: 'secret',
    severity: 'critical',
    title: 'Hardcoded AWS access key id',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    ruleId: 'secret.private-key',
    category: 'secret',
    severity: 'critical',
    title: 'Embedded private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  {
    ruleId: 'secret.assigned-literal',
    category: 'secret',
    severity: 'high',
    title: 'Hardcoded credential assigned to a secret-named variable',
    re: /\b(api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"][A-Za-z0-9+/=_\-.]{12,}['"]/i,
  },
  // ── taint sources (substrate for reachability + the model; low priority) ──
  {
    ruleId: 'source.http-input',
    category: 'taint-source',
    severity: 'info',
    title: 'Untrusted HTTP input read',
    re: /\breq\.(body|params|query|headers|cookies)\b/,
  },
  {
    ruleId: 'source.process-env',
    category: 'taint-source',
    severity: 'info',
    title: 'Environment variable read',
    re: /\bprocess\.env\.\w+/,
  },
  // ── auth hygiene ──────────────────────────────────────────────────────────
  {
    ruleId: 'auth.todo',
    category: 'auth',
    severity: 'low',
    title: 'Unfinished auth/permission marker',
    re: /\b(TODO|FIXME|HACK|XXX)\b[^\n]*\b(auth|authz|authn|permission|access\s*control|rbac|acl)\b/i,
  },
];

/** Lines that are pure comments — skip secret/credential matches there to cut noise. */
const COMMENT_LINE = /^\s*(\/\/|\*|#|--|;)/;

/**
 * Shannon entropy in bits per character. A base64/hex blob of real key material
 * runs ~4.5–6.0; English prose and identifiers run ~3.0–4.0. Exported for tests.
 */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A quoted string literal whose contents look like an encoded blob. */
const STRING_LITERAL = /['"`]([A-Za-z0-9+/=_\-]{20,})['"`]/g;

/**
 * Scan one file's content for built-in security findings. Pure + synchronous —
 * no IO, no store — so it is trivially unit-testable. Returns findings with
 * 1-based line numbers, deduped per (ruleId, line).
 */
export function scanCode(content: string): SecurityFindingInput[] {
  const lines = content.split(/\r?\n/);
  const out: SecurityFindingInput[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 2000) continue; // minified/bundled — skip to stay cheap
    const isComment = COMMENT_LINE.test(line);

    for (const p of CODE_PATTERNS) {
      // Don't flag hardcoded-credential shapes inside comment lines.
      if (isComment && p.category === 'secret') continue;
      const m = p.re.exec(line);
      if (!m) continue;
      const key = `${p.ruleId}:${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        line: i + 1,
        ruleId: p.ruleId,
        category: p.category,
        severity: p.severity,
        title: p.title,
        // Secret rules redact ANY credential-shaped run; other rules only mask
        // embedded high-entropy blobs so the sink snippet stays readable.
        evidence: redactEvidence(m[0], p.category === 'secret'),
      });
    }

    // Entropy pass: high-entropy literals that didn't already trip a secret rule.
    if (!isComment) {
      for (const lm of line.matchAll(STRING_LITERAL)) {
        const blob = lm[1]!;
        if (shannonEntropy(blob) < 4.0) continue;
        const key = `secret.high-entropy:${i + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          line: i + 1,
          ruleId: 'secret.high-entropy',
          category: 'secret',
          severity: 'medium',
          title: 'High-entropy string literal (possible hardcoded secret)',
          evidence: redactEvidence(blob, true),
        });
      }
    }
  }
  return out;
}

/**
 * Reduce a matched snippet to a safe, capped audit string. For anything that
 * looks like a real secret value, keep only a short prefix so the index never
 * persists usable credential material.
 */
function redactEvidence(match: string, aggressive = false): string {
  const capped = match.slice(0, EVIDENCE_CAP).trim();
  // In aggressive (secret) mode, mask any credential-shaped run of 8+ chars
  // regardless of entropy; otherwise only mask long high-entropy blobs so a
  // sink snippet (e.g. a SQL template) stays human-readable.
  const runRe = aggressive ? /([A-Za-z0-9+/=_\-]{8,})/g : /([A-Za-z0-9+/=_\-]{12,})/g;
  return capped.replace(runRe, (run) =>
    aggressive || shannonEntropy(run) >= 4.0
      ? `${run.slice(0, 4)}…(${run.length} chars redacted)`
      : run,
  );
}
