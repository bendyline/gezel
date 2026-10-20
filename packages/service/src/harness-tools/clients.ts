import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  HARNESS_CLIENT_LABELS,
  type HarnessClientId,
  type HarnessLaunchSpec,
  type HarnessToolsClientStatus,
} from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import {
  HarnessSetupError,
  preserveConflictingFile,
  readOptionalFile,
} from '../local-harness/base.js';
import {
  JsonMemberError,
  readJsonMember,
  removeJsonMember,
  upsertJsonMember,
} from '../local-harness/json-member.js';

/**
 * How Gezel's tools get into each outside app's MCP configuration. Each app
 * keeps one `gezel` entry; Gezel records what it wrote in
 * `~/.gezel/integrations/<client>/tools-setup.json` so it can tell its own
 * entry from one the person made by hand, and never removes the latter.
 *
 * Apps with an MCP command (Claude Code, Codex) are configured through it, so
 * those apps stay the only writers of their own config files; Gezel only
 * reads them to report state. The rest are edited one entry at a time.
 */

export interface HarnessClientContext {
  /** The Gezel home. */
  home: string;
  /** The person's home folder. */
  userHome: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Runs an app's command line; resolves its output, rejects on a non-zero exit. */
  run: (command: string, args: string[]) => Promise<string>;
}

export interface HarnessSetupRecord {
  version: 1;
  client: HarnessClientId;
  spec: HarnessLaunchSpec;
  configPath?: string;
  projectId?: string;
  profileId?: string;
  at: string;
}

export interface HarnessClientAdapter {
  client: HarnessClientId;
  inspect(input: InspectInput): Promise<HarnessToolsClientStatus>;
  configure(input: ConfigureInput): Promise<void>;
  remove(input: InspectInput): Promise<void>;
}

export interface InspectInput {
  ctx: HarnessClientContext;
  /** The entry Gezel would write now, or null when it cannot (no Node found). */
  expected: HarnessLaunchSpec | null;
  record: HarnessSetupRecord | null;
  profileId?: string;
}

export interface ConfigureInput extends InspectInput {
  expected: HarnessLaunchSpec;
  replaceExisting: boolean;
}

export function setupRecordPath(home: string, client: HarnessClientId): string {
  return join(home, 'integrations', client, 'tools-setup.json');
}

export async function readSetupRecord(
  home: string,
  client: HarnessClientId,
): Promise<HarnessSetupRecord | null> {
  try {
    const parsed = JSON.parse(
      await readFile(setupRecordPath(home, client), 'utf8'),
    ) as HarnessSetupRecord;
    return parsed?.version === 1 && parsed.client === client ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeSetupRecord(home: string, record: HarnessSetupRecord): Promise<void> {
  const path = setupRecordPath(home, record.client);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

export async function removeSetupRecord(home: string, client: HarnessClientId): Promise<void> {
  await rm(setupRecordPath(home, client), { force: true });
}

/** Same command and arguments; extra keys an app adds (`type`, `env`) do not count. */
export function sameLaunch(entry: unknown, spec: HarnessLaunchSpec | null | undefined): boolean {
  if (!spec || !entry || typeof entry !== 'object') return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  return (
    command === spec.command &&
    Array.isArray(args) &&
    args.length === spec.args.length &&
    args.every((arg, i) => arg === spec.args[i])
  );
}

function quoteForShell(value: string, platform: NodeJS.Platform): string {
  if (/^[\w./:@=\\-]+$/.test(value)) return value;
  return platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

function commandLine(parts: string[], platform: NodeJS.Platform): string {
  return parts.map((part) => quoteForShell(part, platform)).join(' ');
}

function baseStatus(client: HarnessClientId): Omit<HarnessToolsClientStatus, 'state'> {
  return {
    client,
    label: HARNESS_CLIENT_LABELS[client],
    reasons: [],
    canConfigure: false,
    canRemove: false,
  };
}

/** The verdict for an existing entry, shared by every app. */
function entryState(
  entry: unknown,
  expected: HarnessLaunchSpec | null,
  record: HarnessSetupRecord | null,
  label: string,
): Pick<HarnessToolsClientStatus, 'state' | 'reasons' | 'canConfigure' | 'canRemove'> {
  if (entry === undefined) {
    return {
      state: 'not-configured',
      reasons: record ? [`Gezel's entry was removed from ${label}'s settings.`] : [],
      canConfigure: expected !== null,
      canRemove: false,
    };
  }
  if (sameLaunch(entry, expected)) {
    return { state: 'configured', reasons: [], canConfigure: true, canRemove: true };
  }
  if (record && sameLaunch(entry, record.spec)) {
    return {
      state: 'update-needed',
      reasons: ['Gezel moved since this was set up. Repair to point the app at it again.'],
      canConfigure: expected !== null,
      canRemove: true,
    };
  }
  return {
    state: 'conflict',
    reasons: [
      record
        ? `The gezel entry in ${label}'s settings was changed by hand.`
        : `${label} already has a server called gezel that Gezel did not set up.`,
    ],
    canConfigure: expected !== null,
    canRemove: false,
  };
}

// ── apps configured by editing one JSON entry ────────────────────────────────

interface FileTarget {
  configPath: string;
  memberPath: readonly string[];
  /** The app's own folder; when missing, the app is treated as not installed. */
  appDir?: string;
  notInstalled?: string;
  /** Extra keys the app's entry format wants beside command and args. */
  extra?: Record<string, unknown>;
}

function fileAdapter(
  client: HarnessClientId,
  target: (input: InspectInput) => FileTarget | { unavailable: string },
): HarnessClientAdapter {
  const label = HARNESS_CLIENT_LABELS[client];
  return {
    client,
    async inspect(input) {
      const resolved = target(input);
      if ('unavailable' in resolved) {
        return { ...baseStatus(client), state: 'unavailable', reasons: [resolved.unavailable] };
      }
      const base = { ...baseStatus(client), configPath: resolved.configPath };
      if (resolved.appDir && !existsSync(resolved.appDir)) {
        return {
          ...base,
          state: 'unavailable',
          reasons: [resolved.notInstalled ?? `${label} does not seem to be installed.`],
        };
      }
      let entry: unknown;
      try {
        entry = readJsonMember(await readOptionalFile(resolved.configPath), resolved.memberPath);
      } catch (err) {
        return {
          ...base,
          state: 'conflict',
          reasons: [
            `Gezel cannot read ${resolved.configPath} (${err instanceof Error ? err.message : String(err)}). Fix it, or let Gezel keep a backup and start it fresh.`,
          ],
          canConfigure: input.expected !== null,
        };
      }
      return { ...base, ...entryState(entry, input.expected, input.record, label) };
    },

    async configure(input) {
      const resolved = target(input);
      if ('unavailable' in resolved)
        throw new HarnessSetupError('unavailable', resolved.unavailable);
      const content = await readOptionalFile(resolved.configPath);
      let existing: unknown;
      let unreadable = false;
      try {
        existing = readJsonMember(content, resolved.memberPath);
      } catch (err) {
        if (!(err instanceof JsonMemberError)) throw err;
        unreadable = true;
      }
      const ours = sameLaunch(existing, input.expected) || sameLaunch(existing, input.record?.spec);
      const foreign = unreadable || (existing !== undefined && !ours);
      if (foreign && !input.replaceExisting) {
        throw new HarnessSetupError(
          'conflict',
          unreadable
            ? `Gezel cannot read ${resolved.configPath}.`
            : `${label} already has a server called gezel that Gezel did not set up.`,
        );
      }
      if (foreign && content !== null) {
        await preserveConflictingFile({
          path: resolved.configPath,
          content,
          mode: 0o600,
          code: 'backup_failed',
        });
      }
      const entry = {
        ...resolved.extra,
        command: input.expected.command,
        args: input.expected.args,
      };
      const next = upsertJsonMember(unreadable ? null : content, resolved.memberPath, entry);
      await mkdir(dirname(resolved.configPath), { recursive: true });
      await writeFileAtomic(resolved.configPath, next);
    },

    async remove(input) {
      const resolved = target(input);
      if ('unavailable' in resolved) return;
      const content = await readOptionalFile(resolved.configPath);
      if (content === null) return;
      const existing = readJsonMember(content, resolved.memberPath);
      if (existing === undefined) return;
      if (!sameLaunch(existing, input.expected) && !sameLaunch(existing, input.record?.spec)) {
        throw new HarnessSetupError(
          'conflict',
          `The gezel entry in ${resolved.configPath} was not written by Gezel, so Gezel left it in place.`,
        );
      }
      await writeFileAtomic(resolved.configPath, removeJsonMember(content, resolved.memberPath));
    },
  };
}

export function cursorAdapter(): HarnessClientAdapter {
  return fileAdapter('cursor', ({ ctx }) => {
    const appDir = join(ctx.userHome, '.cursor');
    return {
      configPath: join(appDir, 'mcp.json'),
      memberPath: ['mcpServers', 'gezel'],
      appDir,
      notInstalled: 'Cursor does not seem to be installed (no .cursor folder in your home folder).',
    };
  });
}

export function claudeDesktopConfigDir(ctx: HarnessClientContext): string | null {
  if (ctx.platform === 'win32') {
    return join(ctx.env.APPDATA ?? join(ctx.userHome, 'AppData', 'Roaming'), 'Claude');
  }
  if (ctx.platform === 'darwin')
    return join(ctx.userHome, 'Library', 'Application Support', 'Claude');
  return null;
}

export function claudeDesktopAdapter(): HarnessClientAdapter {
  return fileAdapter('claude-desktop', ({ ctx }) => {
    const dir = claudeDesktopConfigDir(ctx);
    if (!dir) return { unavailable: 'Claude Desktop is available on Windows and macOS only.' };
    return {
      configPath: join(dir, 'claude_desktop_config.json'),
      memberPath: ['mcpServers', 'gezel'],
      appDir: dir,
      notInstalled: 'Claude Desktop does not seem to be installed.',
    };
  });
}

export interface VSCodeProfileTarget {
  id: string;
  label: string;
  /** The profile's folder; `mcp.json` lives in it. */
  dir: string;
}

export function vscodeAdapter(
  profiles: (ctx: HarnessClientContext) => Promise<VSCodeProfileTarget[]>,
): HarnessClientAdapter & { profiles: typeof profiles } {
  let cached: VSCodeProfileTarget[] = [];
  const pick = (input: InspectInput): VSCodeProfileTarget | undefined => {
    const wanted = input.profileId ?? input.record?.profileId;
    return cached.find((p) => p.id === wanted) ?? cached[0];
  };
  const inner = fileAdapter('vscode', (input) => {
    const profile = pick(input);
    if (!profile) return { unavailable: 'VS Code does not seem to be installed.' };
    return {
      configPath: join(profile.dir, 'mcp.json'),
      memberPath: ['servers', 'gezel'],
      extra: { type: 'stdio' },
    };
  });
  const refresh = async (ctx: HarnessClientContext) => {
    cached = await profiles(ctx).catch(() => []);
  };
  return {
    client: 'vscode',
    profiles,
    async inspect(input) {
      await refresh(input.ctx);
      const status = await inner.inspect(input);
      const chosen = pick(input);
      return {
        ...status,
        ...(chosen ? { profileId: chosen.id } : {}),
        profiles: cached.map(({ id, label }) => ({ id, label })),
      };
    },
    async configure(input) {
      await refresh(input.ctx);
      if (input.profileId && !cached.some((p) => p.id === input.profileId)) {
        throw new HarnessSetupError(
          'profile_not_found',
          'That VS Code profile was not found.',
          404,
        );
      }
      await inner.configure(input);
    },
    async remove(input) {
      await refresh(input.ctx);
      await inner.remove(input);
    },
  };
}

// ── apps configured through their own MCP command ────────────────────────────

/** `[mcp_servers.<name>]` in a Codex `config.toml`: just enough to compare an entry. */
export function readTomlMcpServer(content: string | null, name: string): unknown {
  if (!content) return undefined;
  const header = new RegExp(`^\\s*\\[mcp_servers\\.(?:"${name}"|${name})\\]\\s*$`, 'm');
  const match = header.exec(content);
  if (!match) return undefined;
  const after = content.slice(match.index + match[0].length);
  const nextHeader = /^\s*\[/m.exec(after);
  const section = nextHeader ? after.slice(0, nextHeader.index) : after;
  const tomlString = (raw: string): string =>
    raw.startsWith("'") ? raw.slice(1, -1) : (JSON.parse(raw) as string);
  const command = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/m.exec(section)?.[1];
  const argsBody = /^\s*args\s*=\s*\[([\s\S]*?)\]/m.exec(section)?.[1];
  const args = argsBody?.match(/"(?:[^"\\]|\\.)*"|'[^']*'/g)?.map(tomlString) ?? [];
  return { ...(command ? { command: tomlString(command) } : {}), args };
}

function commandAdapter(opts: {
  client: HarnessClientId;
  binary: (ctx: HarnessClientContext) => Promise<string | null>;
  configPath: (ctx: HarnessClientContext) => string;
  readEntry: (content: string | null) => unknown;
  addArgs: (spec: HarnessLaunchSpec) => string[];
  removeArgs: string[];
  displayName: string;
}): HarnessClientAdapter {
  const label = HARNESS_CLIENT_LABELS[opts.client];
  const manual = (ctx: HarnessClientContext, spec: HarnessLaunchSpec | null) =>
    spec ? commandLine([opts.displayName, ...opts.addArgs(spec)], ctx.platform) : undefined;
  return {
    client: opts.client,
    async inspect(input) {
      const configPath = opts.configPath(input.ctx);
      const manualCommand = manual(input.ctx, input.expected);
      const base = {
        ...baseStatus(opts.client),
        configPath,
        ...(manualCommand ? { manualCommand } : {}),
      };
      const binary = await opts.binary(input.ctx);
      let entry: unknown;
      try {
        entry = opts.readEntry(await readOptionalFile(configPath));
      } catch {
        entry = undefined;
      }
      const verdict = entryState(entry, input.expected, input.record, label);
      if (!binary) {
        return {
          ...base,
          ...verdict,
          ...(verdict.state === 'configured'
            ? {}
            : {
                state: 'unavailable' as const,
                reasons: [
                  `Gezel could not find the ${opts.displayName} command. Install ${label}, or run the command below yourself.`,
                ],
              }),
          canConfigure: false,
          canRemove: false,
        };
      }
      return { ...base, ...verdict };
    },

    async configure(input) {
      const binary = await opts.binary(input.ctx);
      if (!binary) {
        throw new HarnessSetupError(
          'unavailable',
          `Gezel could not find the ${opts.displayName} command.`,
        );
      }
      const existing = opts.readEntry(await readOptionalFile(opts.configPath(input.ctx)));
      const ours = sameLaunch(existing, input.expected) || sameLaunch(existing, input.record?.spec);
      if (existing !== undefined && !ours && !input.replaceExisting) {
        throw new HarnessSetupError(
          'conflict',
          `${label} already has a server called gezel that Gezel did not set up.`,
        );
      }
      if (existing !== undefined) await input.ctx.run(binary, opts.removeArgs).catch(() => '');
      await input.ctx.run(binary, opts.addArgs(input.expected));
    },

    async remove(input) {
      const binary = await opts.binary(input.ctx);
      if (!binary)
        throw new HarnessSetupError(
          'unavailable',
          `Gezel could not find the ${opts.displayName} command.`,
        );
      const existing = opts.readEntry(await readOptionalFile(opts.configPath(input.ctx)));
      if (existing === undefined) return;
      if (!sameLaunch(existing, input.expected) && !sameLaunch(existing, input.record?.spec)) {
        throw new HarnessSetupError(
          'conflict',
          `The gezel server in ${label} was not set up by Gezel, so Gezel left it in place.`,
        );
      }
      await input.ctx.run(binary, opts.removeArgs);
    },
  };
}

export function claudeCodeAdapter(
  binary: (ctx: HarnessClientContext) => Promise<string | null>,
): HarnessClientAdapter {
  return commandAdapter({
    client: 'claude-code',
    binary,
    displayName: 'claude',
    // User-scope servers live at the top level of ~/.claude.json; Gezel only reads it.
    configPath: (ctx) => join(ctx.userHome, '.claude.json'),
    readEntry: (content) => readJsonMember(content, ['mcpServers', 'gezel']),
    addArgs: (spec) => ['mcp', 'add', '--scope', 'user', 'gezel', '--', spec.command, ...spec.args],
    removeArgs: ['mcp', 'remove', '--scope', 'user', 'gezel'],
  });
}

export function codexAdapter(
  binary: (ctx: HarnessClientContext) => Promise<string | null>,
): HarnessClientAdapter {
  return commandAdapter({
    client: 'codex',
    binary,
    displayName: 'codex',
    configPath: (ctx) => join(ctx.env.CODEX_HOME || join(ctx.userHome, '.codex'), 'config.toml'),
    readEntry: (content) => readTomlMcpServer(content, 'gezel'),
    addArgs: (spec) => ['mcp', 'add', 'gezel', '--', spec.command, ...spec.args],
    removeArgs: ['mcp', 'remove', 'gezel'],
  });
}
