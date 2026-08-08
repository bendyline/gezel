/**
 * Conservative, deterministic second catch for commands whose destructive
 * intent is unambiguous. The sandbox and Reviewed agent remain the primary
 * controls; this list intentionally prefers false negatives over blocking a
 * legitimate build/test command.
 *
 * Keep this function standalone: runtime-files serializes it into the managed
 * hook script placed under the session's CODEX_HOME.
 */
export function codexDangerousCommandReason(command: string): string | null {
  const normalized = command
    .replace(/\\\r?\n/g, ' ')
    // A literal newline separates shell commands just like `;`. Preserve that
    // boundary so a harmless first line cannot hide a destructive second one.
    .replace(/\r?\n/g, '; ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!normalized) return null;

  const rules: Array<[RegExp, string]> = [
    [/(?:^|[;&|]\s*)(?:sudo|doas)(?:\s|$)/, 'privilege escalation is not allowed'],
    [
      /(?:^|[;&|]\s*)(?:shutdown|reboot|halt|poweroff)(?:\s|$)/,
      'machine shutdown commands are not allowed',
    ],
    [
      /(?:^|[;&|]\s*)(?:mkfs(?:\.[\w-]+)?|fdisk|parted|diskutil\s+erase\w*)(?:\s|$)/,
      'disk formatting and partition commands are not allowed',
    ],
    [/\bdd\b[^;&|]*\bof\s*=\s*['"]?\/dev\//, 'raw writes to devices are not allowed'],
    [/(?:^|[;&|]\s*)git\s+(?:-[^ ]+\s+)*reset\s+--hard(?:\s|$)/, 'git reset --hard is destructive'],
    [
      /(?:^|[;&|]\s*)git\s+(?:-[^ ]+\s+)*clean\s+(?=[^;&|]*-[^ ]*f)(?=[^;&|]*-[^ ]*[dx])[^;&|]*/,
      'forced recursive git clean is destructive',
    ],
    [
      /(?:^|[;&|]\s*)git\s+(?:-[^ ]+\s+)*push\b[^;&|]*(?:--force(?:-with-lease)?|-f)(?:\s|$)/,
      'forced git push is not allowed',
    ],
    [
      /(?:^|[;&|]\s*)find\s+(?:['"]?(?:\/|~|\$\{?home\}?|\.{1,2})['"]?)\s+[^;&|]*-delete(?:\s|$)/,
      'broad find -delete is destructive',
    ],
    [
      /(?:^|[;&|]\s*)(?:chmod|chown)\s+(?=[^;&|]*(?:-r|--recursive))[^;&|]*\s['"]?(?:\/|~|\$\{?home\}?)['"]?(?:\s|$)/,
      'recursive permission changes at a filesystem root are not allowed',
    ],
    [
      /\bcurl\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/,
      'piping downloads into a shell is not allowed',
    ],
    [
      /\bwget\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/,
      'piping downloads into a shell is not allowed',
    ],
    [
      /\b(?:drop\s+database|drop\s+schema|truncate\s+table)\b/,
      'destructive database statements are not allowed',
    ],
  ];

  // `git clean -n` / `--dry-run` is inspection even when the bundled flags
  // also contain f/d/x. Do not turn a safe preflight into a hook denial.
  const gitCleanDryRun = /(?:^|[;&|]\s*)git\s+(?:-[^ ]+\s+)*clean\s+[^;&|]*(?:--dry-run|-[a-z]*n)/;

  // `rm -rf` is common for narrow build outputs. Block only broad root/home/
  // current-directory targets, including compact flag spellings.
  const destructiveRm =
    /(?:^|[;&|]\s*)rm\s+(?=[^;&|]*(?:--recursive|-[a-z]*r))(?=[^;&|]*(?:--force|-[a-z]*f))[^;&|]*\s['"]?(?:\/|~\/?|\$home\/?|\$\{home\}\/?|\.|\.\.)['"]?(?:\s|$)/;
  if (destructiveRm.test(normalized)) return 'broad recursive deletion is not allowed';

  for (const [pattern, reason] of rules) {
    if (reason === 'forced recursive git clean is destructive' && gitCleanDryRun.test(normalized)) {
      continue;
    }
    if (pattern.test(normalized)) return reason;
  }
  return null;
}

export function buildCodexSafetyHookScript(): string {
  return `'use strict';
const dangerousReason = ${codexDangerousCommandReason.toString()};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(input); } catch { process.exit(0); }
  if (payload?.hook_event_name !== 'PreToolUse' || payload?.tool_name !== 'Bash') process.exit(0);
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);
  const reason = dangerousReason(command);
  if (!reason) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Gezel safety check: ' + reason + '.'
    }
  }));
});
`;
}
