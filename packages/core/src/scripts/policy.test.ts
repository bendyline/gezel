import { describe, expect, it } from 'vitest';
import { GezelConfigSchema } from '../schemas/api.js';
import type { ScriptCapability } from '../schemas/script.js';
import { securityPolicyForLevel } from '../security/policy.js';
import { narrowScriptSecurityCapabilities } from './policy.js';

describe('shared script security ceiling', () => {
  it('revokes network credentials and shared-library writes without expanding an admitted grant', () => {
    const allowed = new Set<ScriptCapability>([
      'network',
      'credential:service',
      'documents.write',
      'artifacts.write',
      'workspace.write',
    ]);
    const stripped = new Map<ScriptCapability, string>();
    narrowScriptSecurityCapabilities(
      GezelConfigSchema.parse({ securityPolicy: securityPolicyForLevel('super-lockdown') }),
      allowed,
      stripped,
    );
    expect([...allowed]).toEqual(['artifacts.write', 'workspace.write']);
    expect(stripped.get('credential:service')).toContain('external services');
    expect(stripped.get('documents.write')).toContain('file edits');
    narrowScriptSecurityCapabilities(
      GezelConfigSchema.parse({ securityPolicy: securityPolicyForLevel('free') }),
      allowed,
      stripped,
    );
    expect([...allowed]).toEqual(['artifacts.write', 'workspace.write']);
  });
});
