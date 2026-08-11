import type { CraftbookDoc } from '@bendyline/gezel';

/**
 * The two hand-authored guardrail craftbook definitions. The whole
 * value is the PreToolUse hook + inline sandboxed check script. The
 * approach is adapted from gstack (Garry Tan's stack —
 * github.com/garrytan/gstack)'s `careful` / `freeze` hook skills
 * (bin/check-careful.sh / bin/check-freeze.sh), but they
 * ship as ordinary gezel safety books with a structured upstream credit.
 * Written to the catalog by scripts/write-guardrail-books.ts; byte-pinned
 * by gstack-import.test.ts.
 */

export const GUARDRAIL_RELEASED_AT = '2026-08-10T00:00:00Z';
export const CAREFUL_MODE_VERSION = '1.2.0';
export const FREEZE_SCOPE_VERSION = '1.3.0';
const GSTACK_BASED_ON = {
  name: 'gstack',
  url: 'https://github.com/garrytan/gstack',
} as const;

const CHECK_CAREFUL = `import { defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'check-careful',
  description: 'Warn before destructive commands and workspace deletes (careful mode).',
  inputs: {
    toolName: { type: 'string', description: 'Matched MCP tool name.', required: true },
    args: { type: 'json', description: 'Tool arguments.', required: true },
    phase: { type: 'string', description: 'Hook phase.', required: true },
  },
  outputs: {
    decision: { type: 'string', description: 'allow | ask' },
    message: { type: 'string', description: 'Warning shown on ask.' },
  },
  requires: [],
});

// Build-artifact targets that are always safe to delete recursively —
// ported from check-careful.sh's exception list.
const SAFE_DELETE_TARGETS =
  /(?:^|\\/)(node_modules|dist|build|coverage|\\.next|\\.cache|\\.turbo|__pycache__)\\/?$/;

// Destructive patterns checked against the stringified tool arguments —
// the ladder from check-careful.sh, minus host telemetry.
const PATTERNS: Array<[RegExp, string]> = [
  [/\\brm\\s+(-[a-z]*r|--recursive)/i, 'recursive delete (rm -r) permanently removes files'],
  [/\\bdrop\\s+(table|database)\\b/i, 'SQL DROP permanently deletes database objects'],
  [/\\btruncate\\b/i, 'SQL TRUNCATE deletes all rows from a table'],
  [/\\bgit\\s+push\\b[^\\n]*(\\s-f\\b|--force)/i, 'git force-push rewrites remote history'],
  [/\\bgit\\s+reset\\s+--hard/i, 'git reset --hard discards all uncommitted changes'],
  [/\\bgit\\s+(checkout|restore)\\s+\\./i, 'this discards all uncommitted changes in the working tree'],
  [/\\bkubectl\\s+delete\\b/i, 'kubectl delete removes live resources'],
  [/\\bdocker\\s+(rm\\s+-f|system\\s+prune)/i, 'docker force-remove or prune deletes containers or images'],
];

// These tools execute code whose filesystem or external side effects cannot
// be inferred reliably from their call arguments. Careful mode therefore
// asks before the call instead of pretending a script-name scan is enough.
const OPAQUE_EXECUTION_TOOLS = new Set([
  'run_package_script',
  'run_npx',
  'run_nodejs_script',
  'derive_file',
  'run_playwright_script',
  'run_installed_script',
]);

async function main(): Promise<void> {
  const input = gezel.input as { toolName?: unknown; args?: Record<string, unknown> };
  const toolName = String(input.toolName ?? '');
  const args = input.args ?? {};

  if (toolName === 'delete_path') {
    const target = String((args as { path?: unknown }).path ?? '');
    if (target && SAFE_DELETE_TARGETS.test(target)) {
      gezel.output({ decision: 'allow', message: '' });
      return;
    }
    gezel.output({
      decision: 'ask',
      message: '[careful] Deleting "' + target + '" permanently removes it from the workspace.',
    });
    return;
  }

  if (OPAQUE_EXECUTION_TOOLS.has(toolName)) {
    gezel.output({
      decision: 'ask',
      message:
        '[careful] ' + toolName + ' executes code whose destructive side effects cannot be proven from the tool call. Review and approve it before it runs.',
    });
    return;
  }

  let text = '';
  try {
    text = JSON.stringify(args);
  } catch {
    text = String(args);
  }
  for (const [pattern, why] of PATTERNS) {
    if (pattern.test(text)) {
      gezel.output({ decision: 'ask', message: '[careful] Heads up: ' + why + '.' });
      return;
    }
  }
  gezel.output({ decision: 'allow', message: '' });
}

await main();
`;

const CHECK_FREEZE = `import { defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'check-freeze',
  description: 'Block workspace writes outside the frozen directory (freeze scope).',
  inputs: {
    toolName: { type: 'string', description: 'Matched MCP tool name.', required: true },
    args: { type: 'json', description: 'Tool arguments.', required: true },
    phase: { type: 'string', description: 'Hook phase.', required: true },
  },
  outputs: {
    decision: { type: 'string', description: 'allow | deny' },
    message: { type: 'string', description: 'Reason shown on deny.' },
  },
  requires: ['workspace.read'],
});

const STATE_FILE = '.gezel/freeze.json';

function normalize(p: string): string {
  return p.replace(/\\\\/g, '/').replace(/\\/{2,}/g, '/').replace(/^\\.\\//, '').replace(/\\/$/, '');
}

async function main(): Promise<void> {
  const input = gezel.input as { toolName?: unknown; args?: Record<string, unknown> };
  const toolName = String(input.toolName ?? '');
  const args = input.args ?? {};

  let frozenDir = '';
  try {
    const raw = await gezel.fs.read(STATE_FILE);
    frozenDir = normalize(String(JSON.parse(raw).dir ?? ''));
  } catch {
    // Not configured yet (the setup step writes it) — allow everything.
    gezel.output({ decision: 'allow', message: '' });
    return;
  }
  if (!frozenDir) {
    gezel.output({ decision: 'allow', message: '' });
    return;
  }

  // Arbitrary code and project-type application can write paths that are not
  // declared in their tool arguments. Fail closed: direct file tools remain
  // available inside the boundary, while opaque executors must wait until
  // the freeze is lifted.
  const unboundedWriteTools = new Set([
    'npm_install',
    'run_package_script',
    'run_npx',
    'run_nodejs_script',
    'derive_file',
    'run_playwright_script',
    'run_installed_script',
    'apply_project_type',
  ]);
  if (unboundedWriteTools.has(toolName)) {
    gezel.output({
      decision: 'deny',
      message:
        '[freeze] ' + toolName + ' can write undeclared paths, so it is blocked while freeze scope is active. Use direct workspace tools inside "' + frozenDir + '/", or end the freeze before running code.',
    });
    return;
  }

  // Only write destinations count. Source paths may live elsewhere and are
  // safe to read (copy_artifact_to_workspace and extract_archive).
  const candidateKeys =
    toolName === 'rename'
      ? ['fromPath', 'toPath']
      : toolName === 'copy_artifact_to_workspace'
        ? ['dest']
        : toolName === 'extract_archive'
          ? ['outputPath']
          : ['path'];
  const candidates = candidateKeys
    .map((key) => (args as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(normalize);
  if (candidates.length === 0) {
    gezel.output({
      decision: 'deny',
      message: '[freeze] This write call did not expose a destination path, so its boundary cannot be verified.',
    });
    return;
  }

  for (const candidate of candidates) {
    const inside = candidate === frozenDir || candidate.startsWith(frozenDir + '/');
    const isStateFile = candidate === normalize(STATE_FILE);
    if (candidate.includes('..')) {
      gezel.output({ decision: 'deny', message: '[freeze] Path escapes are blocked while freeze scope is active.' });
      return;
    }
    if (!inside && !isStateFile) {
      gezel.output({
        decision: 'deny',
        message:
          '[freeze] Writes are frozen to "' + frozenDir + '/" — "' + candidate + '" is outside it. Finish the scoped work first, or end the freeze-scope task to lift the boundary.',
      });
      return;
    }
  }
  gezel.output({ decision: 'allow', message: '' });
}

await main();
`;

const WRITE_TOOL_MATCHER =
  '^(write_file|append_to_file|replace_in_file|replace_lines|apply_patch|insert_at_marker|copy_artifact_to_workspace|make_dir|delete_path|rename|extract_archive|npm_install|run_package_script|run_npx|run_nodejs_script|derive_file|run_playwright_script|run_installed_script|apply_project_type)$';
const COMMAND_TOOL_MATCHER =
  '^(delete_path|run_package_script|run_npx|run_nodejs_script|derive_file|run_playwright_script|run_installed_script)$';

export const CAREFUL_MODE: CraftbookDoc = {
  id: 'careful-mode',
  name: 'Careful Mode',
  description:
    'Safety guardrails for destructive commands. While this book’s task is active, direct workspace deletes and opaque code-execution tools pause for approval; visible command arguments are also checked for recursive deletes, SQL DROP/TRUNCATE, git force-push/reset, and kubectl/docker destruction. Deleting build artifacts (node_modules, dist, build, coverage caches) stays frictionless. End the task to turn the guardrails off.',
  basedOn: GSTACK_BASED_ON,
  plan: 'This book does its work through a PreToolUse hook: the inline `check-careful` script inspects each gated tool call and answers allow or ask. An ask surfaces the standard permission card; declining (or ignoring it for five minutes) blocks that one call and the session continues.',
  entryStepId: 'active',
  triggers: ['be careful', 'careful mode', 'safety mode', 'warn before destructive'],
  command: 'careful-mode',
  hooks: [
    {
      phase: 'PreToolUse',
      matcher: COMMAND_TOOL_MATCHER,
      script: { name: 'check-careful', scope: 'craftbook' },
      label: 'careful: destructive-command check',
    },
  ],
  steps: [
    {
      id: 'active',
      name: 'Careful mode active',
      suggestedRole: 'developer',
      prompt:
        'Careful mode is **active**: destructive tool calls now pause for the user’s approval before running.\n\nWhat gets flagged:\n\n| Pattern | Risk |\n|---|---|\n| `delete_path` of a workspace path (except build artifacts like `node_modules`, `dist`, `build`, `.cache`, `coverage`) | permanent file loss |\n| package, npx, Node, derived-file, Playwright, and installed-script execution | side effects cannot be proven from call arguments |\n| recursive shell deletes (`rm -r` / `rm -rf`) visible in tool arguments | permanent file loss |\n| `DROP TABLE` / `DROP DATABASE` / `TRUNCATE` | data loss |\n| `git push --force`, `git reset --hard`, `git checkout .` / `git restore .` | history rewrite / uncommitted-work loss |\n| `kubectl delete`, `docker rm -f`, `docker system prune` | live-infrastructure impact |\n\nWork normally — there is nothing special to do. When a call is flagged the user sees a permission card and decides. If they decline, adjust your approach instead of retrying the same call. Keep this task open for as long as careful mode should stay on; closing it uninstalls the guardrails.',
      terminal: true,
    },
  ],
  scripts: { 'check-careful': CHECK_CAREFUL },
  version: CAREFUL_MODE_VERSION,
  releasedAt: GUARDRAIL_RELEASED_AT,
};

export const FREEZE_SCOPE: CraftbookDoc = {
  id: 'freeze-scope',
  name: 'Freeze Scope',
  description:
    'Confine Gezel’s built-in workspace mutation surface to one directory. Direct file writes, patches, renames, deletes, directory creation, copies, and archive extraction are allowed only inside the chosen boundary. Built-in code/package executors whose write targets cannot be proven are blocked until the task ends. Custom project-type and third-party tools are outside this hook contract and must not be used while frozen.',
  basedOn: GSTACK_BASED_ON,
  plan: 'Step 1 agrees the boundary with the user and records it at `.gezel/freeze.json`. From then on the PreToolUse hook checks every built-in workspace mutation destination and denies paths outside the frozen directory. It also fails closed on built-in code/package executors whose filesystem effects are not declared. Custom project-type and third-party tools are explicitly out of contract and must not be called while frozen (the state file itself stays writable so the boundary can be adjusted deliberately).',
  entryStepId: 'set-boundary',
  triggers: ['freeze scope', 'only touch', 'stay inside', 'lock edits to'],
  command: 'freeze-scope',
  hooks: [
    {
      phase: 'PreToolUse',
      matcher: WRITE_TOOL_MATCHER,
      script: { name: 'check-freeze', scope: 'craftbook' },
      label: 'freeze: write-boundary check',
    },
  ],
  steps: [
    {
      id: 'set-boundary',
      name: 'Agree the frozen directory',
      suggestedRole: 'planner',
      prompt:
        'Confirm with the user which single workspace directory edits are allowed in — use `ask_user_question` if the kickoff didn’t name one. Then record it by writing `.gezel/freeze.json` with exactly:\n\n```json\n{ "dir": "<workspace-relative-directory>" }\n```\n\nUse a relative path with no leading `./` and no trailing slash (e.g. `src/billing`). Tell the user the freeze is on and advance.',
      next: 'frozen',
    },
    {
      id: 'frozen',
      name: 'Freeze active',
      suggestedRole: 'developer',
      prompt:
        'The built-in write boundary is active: direct file mutations outside the frozen directory are denied automatically — you will see the denial as a tool error naming the boundary. Opaque built-in execution tools (`npm_install`, package/npx/Node/Playwright/installed scripts, `derive_file`, and project-type application) are blocked because their extra write targets cannot be proven. Custom project-type and third-party tools are not covered by this hook and must not be called while frozen. Work with direct workspace tools inside the directory. If the work genuinely needs an executor, custom tool, or outside path, do NOT fight the boundary: explain why and let the user widen `.gezel/freeze.json` or end this task.',
      terminal: true,
    },
  ],
  scripts: { 'check-freeze': CHECK_FREEZE },
  version: FREEZE_SCOPE_VERSION,
  releasedAt: GUARDRAIL_RELEASED_AT,
};
