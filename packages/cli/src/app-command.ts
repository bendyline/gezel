/**
 * `gezel app` — manage AI Apps (.gezapp) on this machine. Every subcommand
 * talks to the daemon over the global `/api/ai-apps` surface (the daemon is
 * the single registry writer); the CLI's job is review, confirmation, and
 * honest reporting. Loaded through the variable-dynamic-import seam in
 * bin/gezel.ts so it stays out of ordinary CLI startup.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  AiAppDetail,
  AiAppStatus,
  AppliedProjectType,
  GezappDependency,
  ImportAiAppResult,
  Project,
  ProjectTypeApplyPlan,
  ProjectTypeStatusResponse,
} from '@bendyline/gezel';
import { compareSemver } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import { CliError, ensureProjectForFolder } from './connection.js';

export interface AppOutputOptions {
  json?: boolean;
}

function resolveInputPath(file: string): string {
  return isAbsolute(file) ? file : join(process.cwd(), file);
}

/** Semver compare that never throws — unknown formats sort lexically. */
function semverDelta(a: string, b: string): number {
  try {
    return compareSemver(a, b);
  } catch {
    return a.localeCompare(b);
  }
}

/** Map a daemon error (`{ error }` detail) onto a clean CLI message. */
function apiMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const details = (err as { details?: unknown }).details;
    if (details && typeof details === 'object' && 'error' in details) {
      const message = (details as { error?: unknown }).error;
      if (typeof message === 'string' && message.length > 0) return message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

async function confirm(prompt: string, refusal: string, yes?: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) throw new CliError(refusal);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') throw new CliError('Cancelled.');
  } finally {
    rl.close();
  }
}

function formatDependency(dependency: GezappDependency): string {
  const need = dependency.required ? 'required' : 'optional';
  return `${dependency.kind} ${dependency.id}@${dependency.version} (${need})`;
}

function printReview(result: ImportAiAppResult): void {
  const m = result.manifest;
  const publisher = m.publisher.url ? `${m.publisher.name} <${m.publisher.url}>` : m.publisher.name;
  console.log(`${m.name} ${m.entry.version} — ${publisher} (${m.signature.status})`);
  if (m.description) console.log(`  ${m.description}`);
  if (result.previous) {
    const delta = semverDelta(m.entry.version, result.previous.version);
    if (delta > 0) console.log(`  replaces installed ${result.previous.version}`);
    else if (delta < 0) console.log(`  DOWNGRADE from installed ${result.previous.version}`);
    else console.log(`  already installed at ${result.previous.version}`);
    if (!result.previous.enabled) {
      console.log('  note: currently disabled — installing re-enables it');
    }
  }
  console.log(
    `  items: ${result.items.map((item) => `${item.kind} ${item.id}@${item.version}`).join(', ')}`,
  );
  if (result.dependencies.length > 0) {
    console.log(`  dependency locks: ${result.dependencies.map(formatDependency).join(', ')}`);
  }
  const requiredMissing = result.missingDependencies.filter((dependency) => dependency.required);
  if (result.missingDependencies.length > 0) {
    console.log(
      `  missing dependencies: ${result.missingDependencies.map(formatDependency).join(', ')}`,
    );
  } else if (result.dependencies.length > 0) {
    console.log('  missing dependencies: none');
  }
  if (requiredMissing.length > 0) {
    console.log('  WARNING: required dependencies are unavailable — install will be refused.');
  }
}

function printInstallOutcome(result: ImportAiAppResult): void {
  const installed = result.installed;
  if (!installed) return;
  if (installed.alreadyPresent) {
    console.log(`${installed.appId}@${installed.version} is already installed — no changes.`);
    return;
  }
  const upgrade = result.previous ? ` (${result.previous.version} kept on disk for rollback)` : '';
  console.log(`Installed ${installed.appId}@${installed.version}${upgrade}.`);
}

async function readGezappFile(file: string): Promise<Buffer> {
  const path = resolveInputPath(file);
  try {
    return await readFile(path);
  } catch {
    throw new CliError(`cannot read .gezapp file: ${path}`);
  }
}

async function previewImport(client: GezelClient, bytes: Buffer): Promise<ImportAiAppResult> {
  try {
    return await client.importAiAppPackage(bytes);
  } catch (err) {
    throw new CliError(`.gezapp rejected: ${apiMessage(err)}`);
  }
}

async function confirmImport(client: GezelClient, bytes: Buffer): Promise<ImportAiAppResult> {
  try {
    return await client.importAiAppPackage(bytes, { confirm: true });
  } catch (err) {
    throw new CliError(apiMessage(err));
  }
}

export async function runAppAdd(
  client: GezelClient,
  file: string,
  opts: AppOutputOptions & { yes?: boolean; force?: boolean },
): Promise<void> {
  const bytes = await readGezappFile(file);
  const preview = await previewImport(client, bytes);
  if (!opts.json) printReview(preview);
  if (
    preview.previous &&
    semverDelta(preview.manifest.entry.version, preview.previous.version) < 0
  ) {
    if (!opts.force) {
      throw new CliError(
        `refusing to downgrade ${preview.manifest.entry.projectType} from ${preview.previous.version} to ${preview.manifest.entry.version} — pass --force to allow it`,
      );
    }
    if (!opts.json) console.log('  --force: downgrading anyway.');
  }
  await confirm(
    'Install? [y/N] ',
    'Refusing to install without confirmation. Pass --yes.',
    opts.yes || opts.json,
  );
  const result = await confirmImport(client, bytes);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printInstallOutcome(result);
}

export async function runAppUpdate(
  client: GezelClient,
  file: string,
  opts: AppOutputOptions & { force?: boolean },
): Promise<void> {
  const bytes = await readGezappFile(file);
  const preview = await previewImport(client, bytes);
  const appId = preview.manifest.entry.projectType;
  if (!preview.previous) {
    throw new CliError(`${appId} is not installed — use \`gezel app add\` first`);
  }
  const delta = semverDelta(preview.manifest.entry.version, preview.previous.version);
  if (delta < 0 && !opts.force) {
    throw new CliError(
      `refusing to downgrade ${appId} from ${preview.previous.version} to ${preview.manifest.entry.version} — pass --force to allow it`,
    );
  }
  if (!opts.json) printReview(preview);
  const result = await confirmImport(client, bytes);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.installed?.alreadyPresent && delta === 0) {
    console.log(`${appId} is already up to date (${preview.manifest.entry.version}).`);
    return;
  }
  printInstallOutcome(result);
}

export async function runAppList(client: GezelClient, opts: AppOutputOptions): Promise<void> {
  const { apps } = await client.listAiApps();
  if (opts.json) {
    console.log(JSON.stringify(apps, null, 2));
    return;
  }
  if (apps.length === 0) {
    console.log('No AI Apps installed. Add one with: gezel app add <file.gezapp>');
    return;
  }
  console.log(`${'APP'.padEnd(28)} ${'VERSION'.padEnd(10)} ${'INSTALLED'.padEnd(12)} STATE`);
  for (const app of apps) {
    const installed = app.installedAt.slice(0, 10);
    const state = app.enabled ? 'enabled' : 'disabled';
    const name = app.name && app.name !== app.appId ? `  ${app.name}` : '';
    console.log(
      `${app.appId.padEnd(28)} ${app.version.padEnd(10)} ${installed.padEnd(12)} ${state}${name}`,
    );
  }
}

function printDetail(detail: AiAppDetail): void {
  console.log(`${detail.name ?? detail.appId} ${detail.version}`);
  if (detail.description) console.log(`  ${detail.description}`);
  if (detail.publisher) {
    const publisher = detail.publisher.url
      ? `${detail.publisher.name} <${detail.publisher.url}>`
      : detail.publisher.name;
    console.log(`  publisher: ${publisher}`);
  }
  console.log(`  app id: ${detail.appId}`);
  console.log(`  state: ${detail.enabled ? 'enabled' : 'disabled'}`);
  console.log(`  installed: ${detail.installedAt}`);
  console.log(`  package sha256: ${detail.packageSha256.slice(0, 16)}…`);
  console.log(`  items: ${detail.itemCount}, dependency locks: ${detail.dependencyCount}`);
  if (detail.missingDependencies.length > 0) {
    console.log(
      `  missing dependencies: ${detail.missingDependencies.map(formatDependency).join(', ')}`,
    );
  }
  if (detail.versionsOnDisk.length > 0) {
    console.log(`  versions on disk: ${detail.versionsOnDisk.join(', ')}`);
  }
  if (detail.appliedProjects.length > 0) {
    console.log('  applied to:');
    for (const project of detail.appliedProjects) {
      const lag =
        project.version && semverDelta(detail.version, project.version) > 0
          ? ` (outfitted with ${project.version} — update available)`
          : '';
      console.log(`    ${project.name} [${project.id}]${lag}`);
    }
  }
  if (!detail.manifest) {
    console.log('  WARNING: install receipt is unreadable — reinstall to repair.');
  }
}

export async function runAppShow(
  client: GezelClient,
  appId: string,
  opts: AppOutputOptions,
): Promise<void> {
  let detail: AiAppDetail;
  try {
    detail = await client.getAiApp(appId);
  } catch (err) {
    throw new CliError(apiMessage(err));
  }
  if (opts.json) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }
  printDetail(detail);
}

export async function runAppRemove(
  client: GezelClient,
  appId: string,
  opts: { yes?: boolean; keepFiles?: boolean },
): Promise<void> {
  const { apps } = await client.listAiApps();
  const current: AiAppStatus | undefined = apps.find((app) => app.appId === appId);
  if (!current) throw new CliError(`AI App not found: ${appId}`);
  await confirm(
    `Remove ${current.name ?? appId} ${current.version}${opts.keepFiles ? ' (keeping files)' : ''}? [y/N] `,
    'Refusing to remove without confirmation. Pass --yes.',
    opts.yes,
  );
  let removed: Awaited<ReturnType<GezelClient['removeAiApp']>>;
  try {
    removed = await client.removeAiApp(appId, { keepFiles: opts.keepFiles ?? false });
  } catch (err) {
    throw new CliError(apiMessage(err));
  }
  const versions =
    removed.removedVersions.length > 0
      ? `removed ${removed.removedVersions.join(', ')}`
      : 'no version dirs removed';
  const kept =
    removed.keptVersions.length > 0 ? `; kept on disk: ${removed.keptVersions.join(', ')}` : '';
  console.log(`Uninstalled ${appId} (${versions}${kept}).`);
  if (removed.appliedProjects.length > 0) {
    console.log(
      `${removed.appliedProjects.length} project(s) were outfitted by this app — they keep their copied gezels, scripts, and files, but the app's pages and updates are gone.`,
    );
  }
}

export async function runAppSetEnabled(
  client: GezelClient,
  appId: string,
  enabled: boolean,
): Promise<void> {
  try {
    const { entry } = await client.setAiAppEnabled(appId, enabled);
    console.log(`${enabled ? 'Enabled' : 'Disabled'} ${entry.appId}@${entry.version}.`);
  } catch (err) {
    throw new CliError(apiMessage(err));
  }
}

// ── apply an app to a folder ──

/** Match a project bound to this folder, mirroring `ensureProjectForFolder`. */
function findProjectForFolder(projects: Project[], folder: string): Project | undefined {
  const wd = resolve(folder);
  return projects.find(
    (project) =>
      !!project.workingDir &&
      (process.platform === 'win32'
        ? project.workingDir.toLowerCase() === wd.toLowerCase()
        : project.workingDir === wd),
  );
}

/** `--param key=value` pairs → params object (split on the first `=`). */
export function parseParamFlags(flags: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const flag of flags) {
    const eq = flag.indexOf('=');
    if (eq <= 0) throw new CliError(`invalid --param "${flag}" — expected key=value`);
    params[flag.slice(0, eq)] = flag.slice(eq + 1);
  }
  return params;
}

function printPlan(plan: ProjectTypeApplyPlan): void {
  const roles = plan.gezels.map(
    (gezel) =>
      `${gezel.templateId}${gezel.voorman ? ' (voorman' : ' ('}${gezel.reuse ? ', reused)' : gezel.voorman ? ', new)' : 'new)'}`,
  );
  if (roles.length > 0) console.log(`  roles:      ${roles.join(', ')}`);
  if (plan.scripts.length > 0) console.log(`  scripts:    ${plan.scripts.join(', ')}`);
  if (plan.seeds.length > 0) {
    const seeds = plan.seeds.map((seed) =>
      seed.state === 'keep-modified'
        ? `${seed.path} (kept — you modified it)`
        : `${seed.path} (${seed.state})`,
    );
    console.log(`  seeds:      ${seeds.join(', ')}`);
  }
  if (plan.toolsets.installNow.length > 0) {
    console.log(`  toolsets:   ${plan.toolsets.installNow.join(', ')}`);
  }
  if (plan.toolsets.deferred.length > 0) {
    console.log(
      `  deferred:   ${plan.toolsets.deferred.join(', ')} (install explicitly from the catalog)`,
    );
  }
  if (plan.craftbooks.length > 0) console.log(`  craftbooks: ${plan.craftbooks.join(', ')}`);
  for (const schedule of plan.schedules) {
    const cadence = schedule.cron ? `cron ${schedule.cron}` : 'night shift';
    const consent =
      schedule.consent === 'auto' ? 'armed on apply' : 'created paused; enable when asked';
    console.log(`  schedule:   ${schedule.craftbook} (${cadence} — ${consent})`);
  }
  if (plan.pages) console.log('  pages:      Output page included');
}

function printApplied(applied: AppliedProjectType, projectName: string): void {
  const parts: string[] = [];
  if (applied.gezelsCreated.length > 0) {
    parts.push(`${applied.gezelsCreated.length} gezel(s)`);
  }
  if (applied.scriptsInstalled.length > 0) {
    parts.push(`${applied.scriptsInstalled.length} script(s)`);
  }
  if (applied.workspaceSeeded.length > 0) {
    parts.push(`${applied.workspaceSeeded.length} seeded file(s)`);
  }
  if (applied.toolsetsInstalled.length > 0) {
    parts.push(`${applied.toolsetsInstalled.length} toolset(s)`);
  }
  if (applied.craftbooksInstalled.length > 0) {
    parts.push(`${applied.craftbooksInstalled.length} craftbook(s)`);
  }
  if (applied.schedulesCreated.length > 0) {
    parts.push(`${applied.schedulesCreated.length} schedule(s)`);
  }
  console.log(
    `Applied ${applied.typeId}@${applied.version} to "${projectName}"${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.`,
  );
  if (applied.seedsSkipped.length > 0) {
    console.log(`Kept your modified file(s): ${applied.seedsSkipped.join(', ')}.`);
  }
  if (applied.deferred.toolsets.length > 0) {
    console.log(
      `Deferred toolset(s): ${applied.deferred.toolsets.join(', ')} — install them from the catalog when needed.`,
    );
  }
  if (applied.schedulesCreated.some((schedule) => schedule.status === 'paused')) {
    console.log('Schedules were created paused — enable them when Gezel asks.');
  }
  console.log('Run `gezel` in this folder to start.');
}

export async function runAppApply(
  client: GezelClient,
  appId: string,
  folder: string,
  opts: AppOutputOptions & {
    yes?: boolean;
    force?: boolean;
    refresh?: boolean;
    version?: string;
    param?: string[];
  },
): Promise<void> {
  const { apps } = await client.listAiApps();
  const app = apps.find((candidate) => candidate.appId === appId);
  if (!app) {
    throw new CliError(`AI App not installed: ${appId} — install it with \`gezel app add\``);
  }
  if (!app.enabled) {
    throw new CliError(
      `AI App ${appId} is disabled — enable it with \`gezel app enable ${appId}\``,
    );
  }
  const params = parseParamFlags(opts.param ?? []);

  const { projects } = await client.listProjects();
  const existing = findProjectForFolder(projects, folder);
  const projectId = existing?.id ?? (await ensureProjectForFolder(client, folder));
  const project = await client.getProject(projectId);
  if (!opts.json) {
    console.log(
      `Folder: ${resolve(folder)} → project "${project.name}"${existing ? '' : ' (new)'}`,
    );
  }

  const provenance = project.projectType;
  if (provenance && provenance.id !== appId && !opts.force) {
    throw new CliError(
      `this folder's project already has "${provenance.id}" applied — pass --force to apply ${appId} over it`,
    );
  }
  const targetVersion = opts.version ?? app.version;
  if (provenance?.id === appId && provenance.version === targetVersion && !opts.refresh) {
    console.log(`${appId}@${targetVersion} is already applied here — pass --refresh to re-apply.`);
    return;
  }

  const body = {
    typeId: appId,
    ...(opts.version ? { version: opts.version } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    seedPolicy: 'preserve' as const,
    reuseRosterGezels: true,
  };
  let plan: ProjectTypeApplyPlan;
  try {
    plan = await client.preflightProjectType(projectId, body);
  } catch (err) {
    throw new CliError(`cannot apply ${appId}: ${apiMessage(err)}`);
  }
  if (!opts.json) {
    console.log(`Applying ${plan.typeId} ${plan.version}:`);
    printPlan(plan);
  }
  await confirm(
    'Apply? [y/N] ',
    'Refusing to apply without confirmation. Pass --yes.',
    opts.yes || opts.json,
  );
  let applied: AppliedProjectType;
  try {
    applied = await client.applyProjectType(projectId, body);
  } catch (err) {
    throw new CliError(apiMessage(err));
  }
  if (opts.json) {
    console.log(JSON.stringify(applied, null, 2));
    return;
  }
  printApplied(applied, project.name);
}

export async function runAppStatus(
  client: GezelClient,
  folder: string,
  opts: AppOutputOptions,
): Promise<void> {
  const { projects } = await client.listProjects();
  const project = findProjectForFolder(projects, folder);
  if (!project) {
    console.log(`No gezel project is linked to ${resolve(folder)}.`);
    console.log('Apply an app here with: gezel app apply <appId>');
    return;
  }
  const status: ProjectTypeStatusResponse = await client.projectTypeStatus(project.id);
  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`Folder: ${resolve(folder)} → project "${project.name}"`);
  if (!status.provenance) {
    console.log('No AI App is applied to this project.');
    return;
  }
  const applied = `${status.provenance.id} ${status.provenance.version} (applied ${status.provenance.appliedAt.slice(0, 10)})`;
  if (status.installedApp) {
    const state = status.installedApp.enabled ? 'enabled' : 'disabled';
    console.log(`App: ${applied} — installed ${status.installedApp.version}, ${state}`);
    if (status.updateAvailable) {
      console.log(`Update available: gezel app apply ${status.provenance.id}`);
    }
  } else {
    console.log(`App: ${applied} — no longer installed (project keeps its copies)`);
  }
  if (status.seeds.length > 0) {
    const counts = new Map<string, number>();
    for (const seed of status.seeds) counts.set(seed.state, (counts.get(seed.state) ?? 0) + 1);
    const summary = ['ok', 'modified', 'missing', 'untracked']
      .filter((state) => counts.has(state))
      .map((state) => `${counts.get(state)} ${state}`)
      .join(', ');
    console.log(`Seeds: ${summary}`);
    for (const seed of status.seeds) {
      if (seed.state !== 'ok') console.log(`  ${seed.path} — ${seed.state}`);
    }
  }
}

// ── serve an app as a shareable mini-site ──

export interface AppServeCliOptions extends AppOutputOptions {
  port?: number;
  host?: string;
  allowHost: string[];
  chat?: boolean;
  public?: boolean;
  key?: string;
  detach?: boolean;
  open?: boolean;
  all?: boolean;
}

async function openUrlInBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Best-effort — the share link is already printed.
  }
}

async function resolveServeProject(
  client: GezelClient,
  appId: string | undefined,
  folder: string,
): Promise<string> {
  const { projects } = await client.listProjects();
  if (!appId) {
    const existing = findProjectForFolder(projects, folder);
    const projectId = existing?.id ?? (await ensureProjectForFolder(client, folder));
    const project = await client.getProject(projectId);
    if (!project.projectType) {
      throw new CliError(
        `no AI App is applied to ${resolve(folder)} — run \`gezel app apply <appId>\` first`,
      );
    }
    return projectId;
  }
  const matches = projects.filter((project) => project.projectType?.id === appId);
  if (matches.length === 0) {
    throw new CliError(`no project has ${appId} applied — run \`gezel app apply ${appId}\` first`);
  }
  if (matches.length > 1) {
    const names = matches.map((project) => `"${project.name}"`).join(', ');
    throw new CliError(
      `${appId} is applied to several projects (${names}) — run from the folder you want, or pass --project <folder>`,
    );
  }
  const only = matches[0];
  if (!only) throw new CliError(`no project has ${appId} applied`);
  return only.id;
}

async function runAppServeStart(
  client: GezelClient,
  appId: string | undefined,
  folder: string,
  opts: AppServeCliOptions,
): Promise<void> {
  const projectId = await resolveServeProject(client, appId, folder);
  let started: Awaited<ReturnType<GezelClient['startAppServe']>>;
  try {
    started = await client.startAppServe({
      projectId,
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.allowHost.length > 0 ? { allowedHosts: opts.allowHost } : {}),
      ...(opts.chat ? { chat: true } : {}),
      ...(opts.public ? { public: true } : {}),
      ...(opts.key ? { siteKey: opts.key } : {}),
    });
  } catch (err) {
    throw new CliError(apiMessage(err));
  }
  if (opts.json) {
    console.log(JSON.stringify(started, null, 2));
    if (opts.detach) return;
  } else {
    console.log('');
    console.log(`  Serving "${started.typeName}" (${started.typeId}@${started.typeVersion})`);
    console.log(`  project: ${started.projectName} - site: ${started.siteId}`);
    console.log('');
    console.log(`  Share link:  ${started.shareUrl}`);
    if (!started.public) {
      console.log('               (the link carries the site key - anyone with it can visit)');
    }
    console.log('');
    if (started.chat) {
      console.log(
        '  Chat: on - visitors get their own conversation with the project lead (no tools).',
      );
    }
    console.log('  To reach the internet, put a tunnel in front, e.g.:');
    console.log(`    ngrok http ${started.port}`);
    console.log(`    cloudflared tunnel --url http://127.0.0.1:${started.port}`);
    console.log('    (for a proxy hostname, restart with --allow-host your.domain)');
    console.log('');
  }
  if (opts.open) await openUrlInBrowser(started.shareUrl);
  if (opts.detach) {
    console.log('Serving continues in the daemon - `gezel app serve stop` to end it.');
    return;
  }

  await new Promise<void>((resolvePromise) => {
    let stopping = false;
    // Assigned at the bottom of this closure; every reader runs strictly
    // after the interval exists (signals and polls are asynchronous).
    const clearPoll = (): void => {
      clearInterval(timer);
    };
    const finish = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      clearPoll();
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      const visitors = await client
        .getAppServeSite(started.siteId)
        .then((site) => site.visitors)
        .catch(() => 0);
      await client.stopAppServeSite(started.siteId).catch(() => {});
      if (process.stderr.isTTY) process.stderr.write('\n');
      console.log(
        `Stopped.${visitors > 0 ? ` ${visitors} visitor(s) were connected; their chat sessions were archived.` : ''}`,
      );
      resolvePromise();
    };
    const onSignal = (): void => {
      void finish();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const poll = async (): Promise<void> => {
      const site = await client.getAppServeSite(started.siteId).catch(() => null);
      if (!site) {
        // Stopped from elsewhere (another CLI, the API) — wind down.
        if (!stopping && process.stderr.isTTY) process.stderr.write('\n');
        if (!stopping) console.log('The site was stopped from elsewhere.');
        stopping = true;
        clearPoll();
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        resolvePromise();
        return;
      }
      if (process.stderr.isTTY) {
        process.stderr.write(
          `\r  visitors ${site.visitors} - views ${site.counters.pageViews} - invokes ${site.counters.invokes} - chat ${site.counters.chatMessages}        Ctrl+C stops serving  `,
        );
      }
    };
    const timer = setInterval(() => void poll(), 5_000);
    void poll();
  });
}

async function runAppServeStatus(client: GezelClient, opts: AppOutputOptions): Promise<void> {
  const { sites } = await client.listAppServeSites();
  if (opts.json) {
    console.log(JSON.stringify(sites, null, 2));
    return;
  }
  if (sites.length === 0) {
    console.log('No app sites are being served. Start one with: gezel app serve');
    return;
  }
  for (const site of sites) {
    const chat = site.chat ? ', chat on' : '';
    console.log(
      `${site.siteId}  ${site.typeId}@${site.typeVersion}  ${site.url}  (project "${site.projectName}", ${site.visitors} visitor(s)${chat})`,
    );
  }
}

async function runAppServeStop(
  client: GezelClient,
  target: string | undefined,
  opts: { all?: boolean },
): Promise<void> {
  const { sites } = await client.listAppServeSites();
  if (sites.length === 0) {
    console.log('No app sites are being served.');
    return;
  }
  let victims = sites;
  if (!opts.all) {
    if (target) {
      victims = sites.filter((site) => site.siteId === target || site.typeId === target);
      if (victims.length === 0) throw new CliError(`no served site matches "${target}"`);
    } else if (sites.length > 1) {
      throw new CliError(
        `several sites are serving (${sites.map((site) => site.siteId).join(', ')}) — name one or pass --all`,
      );
    }
  }
  for (const site of victims) {
    await client.stopAppServeSite(site.siteId).catch((err) => {
      throw new CliError(apiMessage(err));
    });
    console.log(`Stopped ${site.siteId} (${site.typeId}).`);
  }
}

/** `gezel app serve [target...]` — `status` and `stop` are reserved verbs. */
export async function runAppServe(
  client: GezelClient,
  args: string[],
  folder: string,
  opts: AppServeCliOptions,
): Promise<void> {
  const [first, second] = args;
  if (first === 'status') return runAppServeStatus(client, opts);
  if (first === 'stop') return runAppServeStop(client, second, opts);
  return runAppServeStart(client, first, folder, opts);
}
