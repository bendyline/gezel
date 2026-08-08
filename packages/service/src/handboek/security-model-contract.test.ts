import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findHandboekContent, loadCuratedArticles } from './content.js';

function handboekRoot(): string {
  const root = findHandboekContent();
  if (!root) throw new Error('Handboek content tree is unavailable');
  return root;
}

function securityModel(): string {
  return readFileSync(join(handboekRoot(), 'technical', 'security-model.md'), 'utf8');
}

describe('Handboek security disclosure contract', () => {
  it('states that the local credential is not a same-user isolation boundary', () => {
    const page = securityModel();
    expect(page).toMatch(
      /malicious software already running as \*\*your\*\*[\s\S]*operating-system account/i,
    );
    expect(page).toMatch(/limited to inference and model management/i);
    expect(page).not.toMatch(/other software on the machine can't impersonate the app/i);
  });

  it('distinguishes sandboxed, trusted-compatibility, and full-trust execution', () => {
    const page = securityModel();
    expect(page).toMatch(/sandboxed standalone-script tools/i);
    expect(page).toMatch(/byte-verified first-party scripts/i);
    expect(page).toContain('run_package_script');
    expect(page).toContain('run_npx');
    expect(page).toMatch(/third-party MCP servers[\s\S]*unconfined/i);
    expect(page).not.toMatch(/code they bring executes inside the script sandbox/i);
  });

  it('describes History as provider-observed rather than complete or tamper-evident', () => {
    const page = securityModel();
    expect(page).toMatch(/provider-native tool loops/i);
    expect(page).toMatch(/missing History entry is not proof/i);
    expect(page).toContain('sandboxCopilot: false');
    expect(page).toMatch(/not a[\s\S]*tamper-evident compliance ledger/i);
    expect(page).not.toMatch(/tool calls[\s\S]{0,80}all land in the History log/i);
  });

  it('keeps the old absolute claims out of every curated article', () => {
    const corpus = loadCuratedArticles(handboekRoot())
      .map((article) => article.body)
      .join('\n');
    for (const claim of [
      /Every tool call is mediated/i,
      /Every meaningful action lands in History/i,
      /everything it does lands in History/i,
      /everything fired lands in History/i,
    ]) {
      expect(corpus).not.toMatch(claim);
    }
  });
});
