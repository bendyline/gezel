/**
 * Text scrubbers for anything that leaves the machine or lands in a durable
 * file: engine logs, persisted turn errors, and the body of a GitHub issue
 * the user is about to file.
 *
 * Two tiers, deliberately separate:
 *
 *   - `redactCredentials` — credential shapes only. Cheap enough to run on
 *     every log line, and safe to run on text the user will still read on
 *     their own machine.
 *   - `redactSensitive` — the publishing scrub. Adds home paths, temp dirs,
 *     query-string tokens, and email addresses on top. Only for text that
 *     is leaving the user's machine.
 *
 * Why the split: an `ENOENT … open '/workspace/proj/src/x.ts'` message is
 * genuinely useful to the user *on their own machine*. Collapsing that path
 * before they ever see it makes the app worse at the one thing errors are
 * for. The user's own disk is not a threat surface for the user's own paths
 * — a public issue tracker is.
 *
 * Why pattern-based (not a real secret-store diff):
 *   - `SecretStore.listAll()` doesn't exist (and shouldn't — keyring
 *     backends deliberately prevent bulk enumeration). So we'd have to copy
 *     every known secret into plaintext memory just to build a substring
 *     replacer. That's worse than scanning for the canonical shapes we know
 *     carry credentials.
 *   - False positives (redacting text that *looks* like a token but isn't)
 *     cost nothing.
 *   - False negatives would leak credentials. Be conservative.
 *
 * Browser-safe: regex only, no `node:` imports. The UI imports this.
 */

export const REDACTED = '[REDACTED]';
export const REDACTED_EMAIL = '[EMAIL]';

type Pattern = { label: string; regex: RegExp };

/**
 * Credential shapes. Kept in one place because two copies drift, and the
 * failure mode of drift is a missed credential class.
 *
 * Covered:
 *   - OpenAI-style secret keys: `sk-<24+ alnum>`, `sk-proj-...`
 *   - Anthropic keys: `sk-ant-<alnum-dash>`
 *   - GitHub personal access tokens: classic `ghp_<36>`, fine-grained
 *     `github_pat_<22-255>`, OAuth `gh[osur]_<36>`
 *   - Hugging Face tokens: `hf_<30+>`
 *   - Bearer-style auth headers: `Authorization: Bearer <long>`
 *   - JWT-ish tokens: three base64url segments joined by `.`
 */
const CREDENTIAL_PATTERNS: Pattern[] = [
  // OpenAI secret keys + project-scoped variants. 24+ alnum tail
  // catches both classic `sk-…` and the longer project keys.
  { label: 'openai-key', regex: /\bsk-(?:proj-|live-|admin-)?[A-Za-z0-9_-]{24,}/g },
  // Anthropic keys: `sk-ant-api03-…` and variants. Mixed case + dashes.
  { label: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{24,}/g },
  // GitHub PATs — classic 40-char `ghp_` + the newer 82+-char
  // `github_pat_…` format.
  { label: 'github-classic-pat', regex: /\bghp_[A-Za-z0-9]{36}\b/g },
  { label: 'github-fine-pat', regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  // GitHub OAuth access tokens (`gho_`, `ghs_`, `ghu_`, `ghr_`).
  { label: 'github-oauth', regex: /\bgh[osur]_[A-Za-z0-9]{36}\b/g },
  // Hugging Face API tokens.
  { label: 'hf-token', regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
  // Bearer auth. Greedy-safe: stops at whitespace.
  { label: 'bearer-auth', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  // JWT shape — three base64url segments. A little broader than we'd
  // want (hits any dotted-base64 triple), but false positives are cheap.
  { label: 'jwt-ish', regex: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

/**
 * Replace any credential-shaped substrings with `[REDACTED]`. Pure function.
 * Returns the input unchanged when no pattern matches.
 */
export function redactCredentials(text: string): string {
  let out = text;
  for (const { regex } of CREDENTIAL_PATTERNS) {
    out = out.replace(regex, REDACTED);
  }
  return out;
}

/**
 * A path segment stops at a separator, whitespace, or any character that
 * commonly closes a quoted path inside an error message — so
 * `open '/Users/mike/x.ts'` yields `mike`, not `mike/x.ts'`.
 */
const SEG = String.raw`[^/\\\s"'\`,;:)\]}]+`;

/**
 * Order is load-bearing. Windows temp lives *under* the user profile, so the
 * temp rule has to win before `%USERPROFILE%` swallows its prefix. The gezel
 * home collapse runs after the generic home collapse so it sees an already
 * normalized `~`.
 */
const PATH_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    new RegExp(String.raw`(?:\\\\\?\\)?[A-Za-z]:\\Users\\${SEG}\\AppData\\Local\\Temp`, 'gi'),
    '%TEMP%',
  ],
  [new RegExp(String.raw`(?:\\\\\?\\)?[A-Za-z]:\\Users\\${SEG}`, 'g'), '%USERPROFILE%'],
  [/[A-Za-z]:\\ProgramData\\Gezel/gi, '$GEZEL_HOME'],
  // macOS per-user temp. Opaque hashes, but it is still under the user.
  [/\/var\/folders\/[^\s"'`,;:)\]}]+/g, '<tmp>'],
  [new RegExp(String.raw`/Users/${SEG}`, 'g'), '~'],
  [new RegExp(String.raw`/var/home/${SEG}`, 'g'), '~'],
  [new RegExp(String.raw`/home/${SEG}`, 'g'), '~'],
  // The three machine-service homes, plus the per-user one now spelled `~`.
  [/\/Library\/Application Support\/Gezel/g, '$GEZEL_HOME'],
  [/\/var\/lib\/gezel/g, '$GEZEL_HOME'],
  [/~\/\.gezel(-dev)?/g, '$GEZEL_HOME'],
  [/%USERPROFILE%\\\.gezel(-dev)?/g, '$GEZEL_HOME'],
];

const TOKEN_QUERY = /\btoken=[^\s&"'`]+/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}\b/g;

export interface RedactSensitiveOptions {
  /** Collapse user home prefixes to `~` / `$GEZEL_HOME`. Default true. */
  homePaths?: boolean;
  /** Replace email addresses with `[EMAIL]`. Default true. */
  emails?: boolean;
}

/**
 * Full scrub for text the user is about to PUBLISH. Credentials always; home
 * paths and email addresses by default.
 *
 * Emails run before the credential table so the deliberately-broad JWT-ish
 * pattern can never eat half of a dotted local-part.
 */
export function redactSensitive(text: string, opts: RedactSensitiveOptions = {}): string {
  let out = text;
  if (opts.emails !== false) out = out.replace(EMAIL, REDACTED_EMAIL);
  out = redactCredentials(out);
  out = out.replace(TOKEN_QUERY, 'token=<redacted>');
  if (opts.homePaths !== false) {
    for (const [regex, replacement] of PATH_PATTERNS) {
      out = out.replace(regex, replacement);
    }
  }
  return out;
}
