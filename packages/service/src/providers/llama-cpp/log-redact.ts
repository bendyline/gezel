/**
 * Pattern-based credential scrubber for the llama-server rolling
 * log. Runs on every line before it hits disk.
 *
 * Scope — defense in depth, not primary defense:
 *   - llama-server's own stdout doesn't carry user data by design.
 *   - Our launch config doesn't pass secrets as argv/env.
 *   - So the *expected* threat is zero. This catches the occasional
 *     "user pasted a token into the model-path override" or an
 *     upstream build that starts echoing its argv differently.
 *
 * Why pattern-based (not a real secret-store diff):
 *   - `SecretStore.listAll()` doesn't exist (and shouldn't — keyring
 *     backends deliberately prevent bulk enumeration). So we'd have
 *     to copy every known secret into plaintext memory just to build
 *     a substring replacer. That's worse than scanning for the
 *     canonical shapes we know carry credentials.
 *   - False positives (redacting text that *looks* like a token but
 *     isn't) cost nothing in a log file.
 *   - False negatives would leak credentials. Be conservative.
 *
 * Patterns covered:
 *   - OpenAI-style secret keys: `sk-<40+ alnum>`, `sk-proj-...`
 *   - Anthropic keys: `sk-ant-<alnum-dash>`
 *   - GitHub personal access tokens: classic `ghp_<36>`, fine-grained
 *     `github_pat_<22-250+>`
 *   - Hugging Face tokens: `hf_<36+>`
 *   - Bearer-style auth headers: `Authorization: Bearer <long>`
 *   - JWT-ish tokens: three base64url segments joined by `.`
 */

type Pattern = { label: string; regex: RegExp };

const REDACTION = '[REDACTED]';

const PATTERNS: Pattern[] = [
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
  // want (hits any dotted-base64 triple), but log false-positives are
  // cheap.
  { label: 'jwt-ish', regex: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

/**
 * Replace any credential-shaped substrings in `line` with `[REDACTED]`.
 * Pure function. Returns the input unchanged when no pattern matches.
 * Exported for tests.
 */
export function redactLogLine(line: string): string {
  let out = line;
  for (const { regex } of PATTERNS) {
    out = out.replace(regex, REDACTION);
  }
  return out;
}
