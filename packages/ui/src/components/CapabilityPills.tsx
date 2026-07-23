import { credentialCapabilityName } from '@bendyline/gezel';

/**
 * Capability badges with human labels — the trust surface for scripts.
 * The technical tag (`workspace.write`) stays in the tooltip; the pill
 * itself says what a non-developer needs to know ("Edits project
 * files"). Used in the script editor header, the scripts list, and the
 * task-step automation rows so the vocabulary is identical everywhere.
 */
const CAPABILITY_LABELS: Record<string, string> = {
  llm: 'Uses AI',
  network: 'Internet',
  'workspace.read': 'Reads project files',
  'workspace.write': 'Edits project files',
  'artifacts.read': 'Reads artifacts',
  'artifacts.write': 'Writes artifacts',
  'documents.read': 'Reads documents',
  'documents.write': 'Writes documents',
  'tasks.read': 'Reads tasks',
  'tasks.write': 'Updates tasks',
  'memory.read': 'Reads memory',
  'memory.write': 'Saves memory',
};

export function capabilityLabel(cap: string): string {
  const credential = credentialCapabilityName(cap);
  if (credential) return `Uses ${credential}`;
  return CAPABILITY_LABELS[cap] ?? cap;
}

export function CapabilityPills({ requires }: { requires?: string[] }) {
  if (!requires || requires.length === 0) return null;
  return (
    <ul className="capability-pills">
      {requires.map((cap) => (
        <li key={cap} className="capability-pill" title={cap}>
          {capabilityLabel(cap)}
        </li>
      ))}
    </ul>
  );
}
