import { describe, expect, it } from 'vitest';
import { redactLogLine } from './log-redact.js';

describe('redactLogLine', () => {
  it('leaves a normal llama-server log line alone', () => {
    const line =
      '[llama-server] slot update_slots: id  1 | task 0 | prompt processing progress, n_tokens = 2048, progress = 0.146474';
    expect(redactLogLine(line)).toBe(line);
  });

  it('redacts OpenAI secret keys (classic sk-…)', () => {
    const line = 'OPENAI_API_KEY=sk-abcdef1234567890abcdef1234567890abcd gibberish';
    expect(redactLogLine(line)).not.toContain('sk-abcdef');
    expect(redactLogLine(line)).toContain('[REDACTED]');
  });

  it('redacts OpenAI project-scoped keys (sk-proj-…)', () => {
    const line = 'loading config with sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDEF123456';
    expect(redactLogLine(line)).toContain('[REDACTED]');
    expect(redactLogLine(line)).not.toContain('sk-proj-');
  });

  it('redacts Anthropic keys (sk-ant-…)', () => {
    const line = 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefGHIJKLMN0123456789_-xyz';
    expect(redactLogLine(line)).toContain('[REDACTED]');
    expect(redactLogLine(line)).not.toContain('sk-ant-');
  });

  it('redacts classic GitHub PATs (ghp_<36>)', () => {
    const line = 'cloning with ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789 now';
    expect(redactLogLine(line)).toContain('[REDACTED]');
    expect(redactLogLine(line)).not.toContain('ghp_');
  });

  it('redacts fine-grained GitHub PATs (github_pat_…)', () => {
    const line =
      'GITHUB_TOKEN=github_pat_11ABCDEFG012345_abcdefGHIJKLMNopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    expect(redactLogLine(line)).toContain('[REDACTED]');
    expect(redactLogLine(line)).not.toContain('github_pat_');
  });

  it('redacts Hugging Face tokens (hf_…)', () => {
    const line = 'HF_TOKEN=hf_abcdefGHIJKLMNopqrstuvwxyz01234567';
    expect(redactLogLine(line)).toContain('[REDACTED]');
    expect(redactLogLine(line)).not.toContain('hf_abcd');
  });

  it('redacts Authorization: Bearer headers', () => {
    const line = 'GET /v1/models Authorization: Bearer abcdef123456789012345 200';
    expect(redactLogLine(line)).toContain('[REDACTED]');
    expect(redactLogLine(line)).not.toContain('abcdef123456789012345');
  });

  it('redacts JWT-shaped tokens', () => {
    const line =
      'session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c active';
    expect(redactLogLine(line)).toContain('[REDACTED]');
    expect(redactLogLine(line)).not.toContain('eyJhbGc');
  });

  it('handles multiple secrets in one line', () => {
    const line =
      'both ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789 and sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa present';
    const out = redactLogLine(line);
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('sk-aaaa');
    // Two separate redactions, not collapsed.
    expect((out.match(/\[REDACTED\]/g) ?? []).length).toBe(2);
  });

  it("leaves sha256 hashes alone (64-hex isn't credential-shaped)", () => {
    const line =
      '[llama-server] load_tensors: checksum f469b835a32f853f34209053a9e4c2ae0aba4e10f469b835a32f853f34209053a9e';
    expect(redactLogLine(line)).toBe(line);
  });
});
