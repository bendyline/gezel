import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ScriptTrustInput } from './trust.js';
import { computeScriptTrust } from './trust.js';

const source = "export const meta = { name: 'probe' };\nexport default async () => {};\n";
const input: ScriptTrustInput = {
  scope: 'craftbook',
  source,
  scriptName: 'probe',
  inline: true,
  projectId: 'p',
  trigger: { kind: 'step', taskRef: 'p/1', stepId: 'build', moment: 'enter' },
};
// A task whose CLI-authorized hash list names this exact script.
const readTask = (async () => ({
  cliTrustedScriptHashes: [createHash('sha256').update(source).digest('hex')],
})) as never;

describe('computeScriptTrust and a task-granted trust stamp', () => {
  it("honors it in this account's own project", async () => {
    const trust = await computeScriptTrust({ readTask, isMachineShared: () => false }, input);
    expect(trust.cliTrusted).toBe(true);
  });

  it('never honors it in a machine-shared project, whose task files any account can write', async () => {
    const trust = await computeScriptTrust({ readTask, isMachineShared: () => true }, input);
    expect(trust.cliTrusted).toBe(false);
  });
});
