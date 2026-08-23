import {
  type BoekwachterIssue,
  type GezelSummary,
  type RoleId,
  resolveRoleId,
} from '@bendyline/gezel';
import { useMemo, useState } from 'react';
import { Dialog } from '../primitives/index.js';
import { GezelPicker } from './GezelPicker.js';

export type WorkspaceIssueFixRole = 'developer' | 'writer' | 'designer' | 'researcher';

const FIX_ROLES: ReadonlyArray<{
  id: WorkspaceIssueFixRole;
  label: string;
  canonical: readonly RoleId[];
}> = [
  { id: 'developer', label: 'Developer', canonical: ['developer', 'web-developer'] },
  { id: 'writer', label: 'Writer', canonical: ['copywriter'] },
  { id: 'designer', label: 'Designer', canonical: ['designer'] },
  { id: 'researcher', label: 'Researcher', canonical: ['researcher'] },
];

const WRITING_EXTENSIONS = new Set([
  'adoc',
  'asciidoc',
  'markdown',
  'md',
  'mdx',
  'rst',
  'tex',
  'txt',
]);
const DESIGN_EXTENSIONS = new Set([
  'ai',
  'avif',
  'bmp',
  'fig',
  'gif',
  'ico',
  'jpeg',
  'jpg',
  'pdf',
  'png',
  'psd',
  'sketch',
  'svg',
  'webp',
]);
const RESEARCH_EXTENSIONS = new Set(['csv', 'ods', 'parquet', 'tsv', 'xls', 'xlsx']);

export function inferWorkspaceIssueFixRole(path: string): WorkspaceIssueFixRole {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  const extension = name.includes('.') ? (name.split('.').pop() ?? '') : '';
  if (WRITING_EXTENSIONS.has(extension)) return 'writer';
  if (DESIGN_EXTENSIONS.has(extension)) return 'designer';
  if (RESEARCH_EXTENSIONS.has(extension)) return 'researcher';
  return 'developer';
}

export function formatWorkspaceIssueFixMessage(
  path: string,
  issue: BoekwachterIssue,
  role: WorkspaceIssueFixRole,
): string {
  if (issue.stale) {
    const previous =
      issue.line != null ? ` It was previously reported near line ${issue.line}.` : '';
    return `@${role}, can you address ${issue.ref} in ${path}: ${issue.message}${previous} The file has changed since this was reported, so please verify it against the current file before editing.`;
  }
  const location = issue.line != null ? ` at line ${issue.line}` : '';
  return `@${role}, can you address ${issue.ref} in ${path}${location}: ${issue.message}`;
}

function canonicalRole(gezel: GezelSummary): RoleId | null {
  return resolveRoleId(gezel.role) ?? resolveRoleId(gezel.roleBasedName);
}

function matchingGezels(
  gezels: readonly GezelSummary[],
  role: WorkspaceIssueFixRole,
  assignedGezelIds: ReadonlySet<string>,
): GezelSummary[] {
  const canonical = new Set(FIX_ROLES.find((candidate) => candidate.id === role)!.canonical);
  return gezels
    .filter((gezel) => {
      const identity = canonicalRole(gezel);
      return !gezel.fixedFunction && identity !== null && canonical.has(identity);
    })
    .sort(
      (a, b) =>
        Number(assignedGezelIds.has(b.id)) - Number(assignedGezelIds.has(a.id)) ||
        a.name.localeCompare(b.name),
    );
}

export function WorkspaceIssueFixDialog({
  path,
  issue,
  gezels,
  assignedGezelIds,
  onCancel,
  onConfirm,
}: {
  path: string;
  issue: BoekwachterIssue;
  gezels: readonly GezelSummary[];
  assignedGezelIds: ReadonlySet<string>;
  onCancel: () => void;
  onConfirm: (gezelId: string, message: string) => void | Promise<void>;
}) {
  const inferredRole = inferWorkspaceIssueFixRole(path);
  const [role, setRole] = useState<WorkspaceIssueFixRole>(inferredRole);
  const candidates = useMemo(
    () => matchingGezels(gezels, role, assignedGezelIds),
    [assignedGezelIds, gezels, role],
  );
  const [selectedGezelId, setSelectedGezelId] = useState(
    () => matchingGezels(gezels, inferredRole, assignedGezelIds)[0]?.id ?? '',
  );
  const [message, setMessage] = useState(() =>
    formatWorkspaceIssueFixMessage(path, issue, inferredRole),
  );
  const [messageEdited, setMessageEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeRole = (next: WorkspaceIssueFixRole) => {
    const nextCandidates = matchingGezels(gezels, next, assignedGezelIds);
    setRole(next);
    setSelectedGezelId(nextCandidates[0]?.id ?? '');
    if (!messageEdited) setMessage(formatWorkspaceIssueFixMessage(path, issue, next));
  };

  const submit = async () => {
    if (busy || !selectedGezelId || !message.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(selectedGezelId, message.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const roleLabel = FIX_ROLES.find((candidate) => candidate.id === role)!.label;
  return (
    <Dialog.Root open onOpenChange={(next) => !next && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="workspace-issue-fix-dialog">
          <form
            className="workspace-issue-fix-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Dialog.Title asChild>
              <h3>Assign issue fix</h3>
            </Dialog.Title>
            <Dialog.Description className="muted small">
              This creates an assigned task and starts its specialist chat immediately. Your files
              aren’t touched — the fix arrives as a change proposal you review and apply.
            </Dialog.Description>

            <label>
              <span>Assigned role</span>
              <select
                value={role}
                onChange={(event) => changeRole(event.currentTarget.value as WorkspaceIssueFixRole)}
                disabled={busy}
              >
                {FIX_ROLES.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Gezel</span>
              <GezelPicker
                gezels={candidates}
                value={selectedGezelId}
                onValueChange={(id) => setSelectedGezelId(id ?? '')}
                placeholder={`No ${roleLabel.toLowerCase()} gezel available`}
                ariaLabel="Gezel assigned to fix this issue"
                disabled={busy || candidates.length === 0}
              />
            </label>
            {candidates.length === 0 && (
              <p className="workspace-issue-fix-missing" role="alert">
                No {roleLabel.toLowerCase()} gezel is available. Choose another role or add one to
                the crew first.
              </p>
            )}

            <label>
              <span>Message</span>
              <textarea
                value={message}
                onChange={(event) => {
                  setMessage(event.currentTarget.value);
                  setMessageEdited(true);
                }}
                rows={5}
                disabled={busy}
              />
            </label>
            {error && (
              <p className="gz-dialog-error" role="alert">
                Couldn’t start the fix: {error}
              </p>
            )}

            <Dialog.Actions>
              <button type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busy || !selectedGezelId || !message.trim()}
              >
                {busy ? 'Starting…' : 'OK'}
              </button>
            </Dialog.Actions>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
