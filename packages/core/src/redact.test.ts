import { describe, expect, it } from 'vitest';
import { redactCredentials, redactSensitive } from './redact.js';

// The credential cases below are ported verbatim from the llama-cpp
// log scrubber this table moved out of, so the move is provably
// behavior-preserving for the log path.
describe('redactCredentials', () => {
  it('leaves a normal llama-server log line alone', () => {
    const line =
      '[llama-server] slot update_slots: id  1 | task 0 | prompt processing progress, n_tokens = 2048, progress = 0.146474';
    expect(redactCredentials(line)).toBe(line);
  });

  it('redacts OpenAI secret keys (classic sk-…)', () => {
    const line = 'OPENAI_API_KEY=sk-abcdef1234567890abcdef1234567890abcd gibberish';
    expect(redactCredentials(line)).not.toContain('sk-abcdef');
    expect(redactCredentials(line)).toContain('[REDACTED]');
  });

  it('redacts OpenAI project-scoped keys (sk-proj-…)', () => {
    const line = 'loading config with sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDEF123456';
    expect(redactCredentials(line)).toContain('[REDACTED]');
    expect(redactCredentials(line)).not.toContain('sk-proj-');
  });

  it('redacts Anthropic keys (sk-ant-…)', () => {
    const line = 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefGHIJKLMN0123456789_-xyz';
    expect(redactCredentials(line)).toContain('[REDACTED]');
    expect(redactCredentials(line)).not.toContain('sk-ant-');
  });

  it('redacts classic GitHub PATs (ghp_<36>)', () => {
    const line = 'cloning with ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789 now';
    expect(redactCredentials(line)).toContain('[REDACTED]');
    expect(redactCredentials(line)).not.toContain('ghp_');
  });

  it('redacts fine-grained GitHub PATs (github_pat_…)', () => {
    const line =
      'GITHUB_TOKEN=github_pat_11ABCDEFG012345_abcdefGHIJKLMNopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    expect(redactCredentials(line)).toContain('[REDACTED]');
    expect(redactCredentials(line)).not.toContain('github_pat_');
  });

  it('redacts Hugging Face tokens (hf_…)', () => {
    const line = 'HF_TOKEN=hf_abcdefGHIJKLMNopqrstuvwxyz01234567';
    expect(redactCredentials(line)).toContain('[REDACTED]');
    expect(redactCredentials(line)).not.toContain('hf_abcd');
  });

  it('redacts Authorization: Bearer headers', () => {
    const line = 'GET /v1/models Authorization: Bearer abcdef123456789012345 200';
    expect(redactCredentials(line)).toContain('[REDACTED]');
    expect(redactCredentials(line)).not.toContain('abcdef123456789012345');
  });

  it('redacts JWT-shaped tokens', () => {
    const line =
      'session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c active';
    expect(redactCredentials(line)).toContain('[REDACTED]');
    expect(redactCredentials(line)).not.toContain('eyJhbGc');
  });

  it('handles multiple secrets in one line', () => {
    const line =
      'both ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789 and sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa present';
    const out = redactCredentials(line);
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('sk-aaaa');
    // Two separate redactions, not collapsed.
    expect((out.match(/\[REDACTED\]/g) ?? []).length).toBe(2);
  });

  it("leaves sha256 hashes alone (64-hex isn't credential-shaped)", () => {
    const line =
      '[llama-server] load_tensors: checksum f469b835a32f853f34209053a9e4c2ae0aba4e10f469b835a32f853f34209053a9e';
    expect(redactCredentials(line)).toBe(line);
  });

  it('leaves home paths and emails alone — that is the publishing scrub, not this one', () => {
    const line =
      "ENOENT: no such file or directory, open '/Users/mike/proj/a.ts' for mike@example.com";
    expect(redactCredentials(line)).toBe(line);
  });
});

describe('redactSensitive', () => {
  it('collapses macOS home paths', () => {
    expect(redactSensitive('/Users/mike/proj/src/a.ts')).toBe('~/proj/src/a.ts');
  });

  it('collapses Linux home paths', () => {
    expect(redactSensitive('/home/mike/proj/a.ts')).toBe('~/proj/a.ts');
    expect(redactSensitive('/var/home/mike/proj/a.ts')).toBe('~/proj/a.ts');
  });

  it('collapses Windows home paths, including the \\\\?\\ long-path prefix', () => {
    expect(redactSensitive(String.raw`C:\Users\Mike\Downloads\x`)).toBe(
      String.raw`%USERPROFILE%\Downloads\x`,
    );
    expect(redactSensitive(String.raw`\\?\C:\Users\Mike\Downloads\x`)).toBe(
      String.raw`%USERPROFILE%\Downloads\x`,
    );
  });

  it('maps the Windows temp dir before the user profile swallows its prefix', () => {
    // Ordering regression: %TEMP% lives under %USERPROFILE%, so the more
    // specific rule has to win or this reads `%USERPROFILE%\AppData\…`.
    expect(redactSensitive(String.raw`C:\Users\Mike\AppData\Local\Temp\gezel-abc`)).toBe(
      String.raw`%TEMP%\gezel-abc`,
    );
  });

  it('maps the macOS per-user temp dir', () => {
    expect(redactSensitive('/var/folders/qx/abc123/T/gezel-xyz')).toBe('<tmp>');
  });

  it('collapses every documented gezel home to $GEZEL_HOME', () => {
    expect(redactSensitive('/Users/mike/.gezel/engines/llama-cpp/x')).toBe(
      '$GEZEL_HOME/engines/llama-cpp/x',
    );
    expect(redactSensitive('/home/mike/.gezel-dev/config.json')).toBe('$GEZEL_HOME/config.json');
    expect(redactSensitive('/var/lib/gezel/config.json')).toBe('$GEZEL_HOME/config.json');
    expect(redactSensitive('/Library/Application Support/Gezel/runtime')).toBe(
      '$GEZEL_HOME/runtime',
    );
    expect(redactSensitive(String.raw`C:\ProgramData\Gezel\runtime`)).toBe(
      String.raw`$GEZEL_HOME\runtime`,
    );
  });

  it('terminates a path segment at the closing quote of an error message', () => {
    const line = "ENOENT: no such file or directory, open '/Users/mike/.gezel/gezels/g1/about.md'";
    const out = redactSensitive(line);
    expect(out).toBe("ENOENT: no such file or directory, open '$GEZEL_HOME/gezels/g1/about.md'");
    expect(out).not.toContain('/Users/');
    expect(out).not.toContain('mike');
  });

  it('redacts email addresses', () => {
    expect(redactSensitive('failed for mike@bendyline.com today')).toBe('failed for [EMAIL] today');
  });

  it('redacts an email next to a JWT without either mangling the other', () => {
    // The JWT-ish pattern is deliberately broad, so emails run first —
    // otherwise it eats half of a dotted local-part.
    const line =
      'user first.last@example.co.uk token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactSensitive(line);
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('example.co.uk');
    expect(out).not.toContain('eyJhbGc');
  });

  it('redacts query-string tokens', () => {
    expect(redactSensitive('GET /api/x?token=abc123def&y=1')).toBe(
      'GET /api/x?token=<redacted>&y=1',
    );
  });

  it('still redacts credentials', () => {
    const out = redactSensitive('auth failed: ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('ghp_');
  });

  it('is idempotent', () => {
    const line =
      "open '/Users/mike/.gezel/x' for mike@example.com with ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
    const once = redactSensitive(line);
    expect(redactSensitive(once)).toBe(once);
  });

  it('leaves relative paths and $GEZEL_HOME-relative text alone', () => {
    const line = 'packages/service/src/x.ts and ./dist/index.js';
    expect(redactSensitive(line)).toBe(line);
  });

  it('honors the opt-outs', () => {
    const line = '/Users/mike/x for mike@example.com with ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789';
    const out = redactSensitive(line, { homePaths: false, emails: false });
    expect(out).toContain('/Users/mike/x');
    expect(out).toContain('mike@example.com');
    // Credentials are never opt-out-able.
    expect(out).toContain('[REDACTED]');
  });
});
