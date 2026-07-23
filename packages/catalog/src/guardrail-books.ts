import type { CraftbookDoc } from '@bendyline/gezel';
import { GSTACK_BASED_ON } from './gstack-import.js';

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

export const GUARDRAIL_RELEASED_AT = '2026-07-06T00:00:00Z';
export const GUARDRAIL_VERSION = '1.0.0';

const CHECK_CAREFUL = `import { defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'check-careful',
  description: 'Warn before destructive commands and workspace deletes (careful mode).',
  inputs: {},
  outputs: {
    decision: { type: 'string', description: 'allow | ask' },
    message: { type: 'string', description: 'Warning shown on ask.' },
  },
  requires: [],
});

// Build-artifact targets that are always safe to delete recursively —
// ported from check-careful.sh's exception list.
const SAFE_RM_TARGETS =
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

async function main(): Promise<void> {
  const input = gezel.input as { toolName?: unknown; args?: Record<string, unknown> };
  const toolName = String(input.toolName ?? '');
  const args = input.args ?? {};

  if (toolName === 'rm') {
    const target = String((args as { path?: unknown }).path ?? '');
    if (target && SAFE_RM_TARGETS.test(target)) {
      gezel.output({ decision: 'allow', message: '' });
      return;
    }
    gezel.output({
      decision: 'ask',
      message: '[careful] Deleting "' + target + '" permanently removes it from the workspace.',
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
  inputs: {},
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
  const input = gezel.input as { args?: Record<string, unknown> };
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

  // Every path-like argument the write-tool family carries.
  const candidates = ['path', 'from', 'to', 'file']
    .map((key) => (args as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(normalize);
  if (candidates.length === 0) {
    gezel.output({ decision: 'allow', message: '' });
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
  '^(writeFile|appendToFile|replaceInFile|replaceLines|applyPatch|insertAtMarker|rename|rm|mkdir)$';
const COMMAND_TOOL_MATCHER = '^(rm|run_git|run_package_script|run_npx|run_nodejs_script)$';

export const CAREFUL_MODE: CraftbookDoc = {
  id: 'careful-mode',
  name: 'Careful Mode',
  description:
    'Safety guardrails for destructive commands. While this book’s task is active, every risky tool call — recursive deletes, SQL DROP/TRUNCATE, git force-push, `git reset --hard`, kubectl/docker destructive operations, and workspace `rm` — pauses for your approval before it runs. Deleting build artifacts (node_modules, dist, build, coverage caches) stays frictionless. End the task to turn the guardrails off.',
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
      prompt:
        'Careful mode is **active**: destructive tool calls now pause for the user’s approval before running.\n\nWhat gets flagged:\n\n| Pattern | Risk |\n|---|---|\n| `rm` of a workspace path (except build artifacts like `node_modules`, `dist`, `build`, `.cache`, `coverage`) | permanent file loss |\n| recursive shell deletes (`rm -r` / `rm -rf`) inside scripts | permanent file loss |\n| `DROP TABLE` / `DROP DATABASE` / `TRUNCATE` | data loss |\n| `git push --force`, `git reset --hard`, `git checkout .` / `git restore .` | history rewrite / uncommitted-work loss |\n| `kubectl delete`, `docker rm -f`, `docker system prune` | live-infrastructure impact |\n\nWork normally — there is nothing special to do. When a call is flagged the user sees a permission card and decides. If they decline, adjust your approach instead of retrying the same call. Keep this task open for as long as careful mode should stay on; closing it uninstalls the guardrails.',
      terminal: true,
    },
  ],
  scripts: { 'check-careful': CHECK_CAREFUL },
  version: GUARDRAIL_VERSION,
  releasedAt: GUARDRAIL_RELEASED_AT,
};

export const FREEZE_SCOPE: CraftbookDoc = {
  id: 'freeze-scope',
  name: 'Freeze Scope',
  description:
    'Confine all workspace writes to one directory. Pick a directory with the user; from then on every write tool — file writes, patches, renames, deletes, mkdir — is blocked outside it until the task ends. Ideal for surgical fixes where collateral edits are worse than no edits.',
  basedOn: GSTACK_BASED_ON,
  plan: 'Step 1 agrees the boundary with the user and records it at `.gezel/freeze.json`. From then on the PreToolUse hook runs the inline `check-freeze` script on every workspace write and denies anything outside the frozen directory (the state file itself stays writable so the boundary can be adjusted deliberately).',
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
      prompt:
        'Confirm with the user which single workspace directory edits are allowed in — use `ask_user_question` if the kickoff didn’t name one. Then record it by writing `.gezel/freeze.json` with exactly:\n\n```json\n{ "dir": "<workspace-relative-directory>" }\n```\n\nUse a relative path with no leading `./` and no trailing slash (e.g. `src/billing`). Tell the user the freeze is on and advance.',
      next: 'frozen',
    },
    {
      id: 'frozen',
      name: 'Freeze active',
      prompt:
        'The write boundary is active: any write outside the frozen directory is denied automatically — you will see the denial as a tool error naming the boundary. Do the scoped work normally inside the directory. If the work genuinely needs to touch something outside, do NOT fight the boundary: tell the user what needs changing and why, and let them either widen `.gezel/freeze.json` deliberately or end this task to lift the freeze.',
      terminal: true,
    },
  ],
  scripts: { 'check-freeze': CHECK_FREEZE },
  version: GUARDRAIL_VERSION,
  releasedAt: GUARDRAIL_RELEASED_AT,
};
