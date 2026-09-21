import type { GezelConfig } from '../schemas/api.js';
import type { ScriptCapability, ScriptRunTrigger, ScriptScope } from '../schemas/script.js';
import { resolveSecurityPolicy } from '../security/policy.js';

/** The SDK method contract shared by every execution host. No catch-all capability. */
export const SCRIPT_METHOD_CAPABILITIES: Readonly<Record<string, ScriptCapability | null>> = {
  'fs.read': 'workspace.read',
  'fs.list': 'workspace.read',
  'fs.listAll': 'workspace.read',
  'fs.stat': 'workspace.read',
  'fs.write': 'workspace.write',
  'fs.rm': 'workspace.write',
  'fs.mkdir': 'workspace.write',
  'fs.rename': 'workspace.write',
  'artifact.read': 'artifacts.read',
  'artifact.list': 'artifacts.read',
  'artifact.write': 'artifacts.write',
  'artifact.delete': 'artifacts.write',
  'document.read': 'documents.read',
  'document.list': 'documents.read',
  'document.write': 'documents.write',
  'document.delete': 'documents.write',
  'task.get': 'tasks.read',
  'task.steps': 'tasks.read',
  'task.currentStep': 'tasks.read',
  'task.readNotes': 'tasks.read',
  'task.update': 'tasks.write',
  'task.advance': 'tasks.write',
  'task.writeNotes': 'tasks.write',
  'task.appendNote': 'tasks.write',
  'task.deleteNote': 'tasks.write',
  'task.create': 'tasks.write',
  'memory.search': 'memory.read',
  'memory.save': 'memory.write',
  'llm.oneShot': 'llm',
  'mcp.call': 'network',
  'http.request': 'network',
  'http.authed': 'network',
  'index.status': 'index.read',
  'index.ensureFresh': 'index.refresh',
  'script.run': null,
};

export class CapabilityDeniedError extends Error {
  readonly code = 'CAPABILITY_DENIED';
  constructor(capability: ScriptCapability, method: string, strippedReason?: string) {
    super(
      strippedReason
        ? `script attempted to call "${method}" (capability: ${capability}); the capability is declared in meta.requires but is currently denied: ${strippedReason}`
        : `script attempted to call "${method}" (capability: ${capability}) but did not declare it in meta.requires`,
    );
    this.name = 'CapabilityDeniedError';
  }
}

export class EngagementDeniedError extends Error {
  readonly code = 'ENGAGEMENT_DENIED';
  constructor(method: string) {
    super(`script called "${method}" but AI engagement mode is set to "off"`);
    this.name = 'EngagementDeniedError';
  }
}

export function assertScriptMethodAllowed(
  method: string,
  allowedCapabilities: ReadonlySet<ScriptCapability>,
  strippedCapabilities?: ReadonlyMap<ScriptCapability, string>,
): void {
  if (!Object.hasOwn(SCRIPT_METHOD_CAPABILITIES, method))
    throw new Error(`unknown method "${method}"`);
  const capability = SCRIPT_METHOD_CAPABILITIES[method];
  if (capability && !allowedCapabilities.has(capability)) {
    throw new CapabilityDeniedError(capability, method, strippedCapabilities?.get(capability));
  }
}

/** Reapply mutable security ceilings without granting anything denied at admission. */
export function narrowScriptSecurityCapabilities(
  config: GezelConfig,
  allowed: Set<ScriptCapability>,
  stripped: Map<ScriptCapability, string>,
): void {
  const policy = resolveSecurityPolicy(config);
  for (const capability of allowed) {
    const reason =
      !policy.allowExternalServices &&
      (capability === 'network' || capability.startsWith('credential:'))
        ? 'external services are disabled by the security policy'
        : !policy.allowFileEdits && capability === 'documents.write'
          ? 'file edits are disabled by the security policy'
          : undefined;
    if (reason) {
      allowed.delete(capability);
      stripped.set(capability, reason);
    }
  }
}

/** Manual actions and immutable standard scripts retain desktop's agency contract. */
export function assertScriptExecutionAllowed(
  config: GezelConfig,
  scope: ScriptScope,
  trigger: ScriptRunTrigger,
): void {
  if (
    !resolveSecurityPolicy(config).allowScriptExecution &&
    scope !== 'standard' &&
    (trigger.kind === 'chat' || trigger.kind === 'step')
  ) {
    throw new Error(
      'Security policy: script execution is disabled. Raise the security level in Settings → Security & Compliance to let gezels run scripts.',
    );
  }
}
