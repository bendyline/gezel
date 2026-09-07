import type { ClaudePermissionMode, CodexPermissionMode } from '@bendyline/gezel';

interface CliPermissionChoice<Mode extends string> {
  id: Mode;
  label: string;
  description: string;
}

export const CLAUDE_PERMISSION_CHOICES: ReadonlyArray<CliPermissionChoice<ClaudePermissionMode>> = [
  {
    id: 'plan',
    label: 'Plan only',
    description: 'Read and review without making changes.',
  },
  {
    id: 'default',
    label: 'Standard prompts',
    description: "Use Claude Code's normal permission prompts.",
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    description: 'Approve file changes; ask before commands and other actions.',
  },
  {
    id: 'bypassPermissions',
    label: 'Full access',
    description: 'Approve every tool automatically, including shell commands.',
  },
];

export const CODEX_PERMISSION_CHOICES: ReadonlyArray<CliPermissionChoice<CodexPermissionMode>> = [
  {
    id: 'plan',
    label: 'Plan',
    description: 'Read-only. Codex can look at the workspace but never changes it.',
  },
  {
    id: 'edit',
    label: 'Edit',
    description: 'Can change files in the workspace, but cannot reach outside its sandbox.',
  },
  {
    id: 'reviewed',
    label: 'Reviewed',
    description:
      'Like Edit, and anything that would cross the sandbox boundary goes to an independent Codex reviewer first.',
  },
  {
    id: 'full',
    label: 'Full',
    description: 'Turns off Codex sandboxing and approvals. Codex may do anything the CLI can.',
  },
];
