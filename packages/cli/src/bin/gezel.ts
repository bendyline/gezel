import { basename } from 'node:path';
import { GEZEL_VERSION } from '@bendyline/gezel';
import {
  type LlamaCppInstallEvent,
  type MlxInstallEvent,
  streamChatEvents,
} from '@bendyline/gezel-client';
import {
  GezelClient,
  createTrustingFetch,
  discoverOrSpawn,
  isProcessAlive,
  readRuntime,
  resolveDaemonEntry,
  stopOwnedDaemon,
  stopProcessByPid,
} from '@bendyline/gezel-client/node';
import { Command } from 'commander';
import {
  CliError,
  type CliGlobals,
  applyHome,
  connectForRun,
  connectOwned,
  describeMachineEngineBroker,
  ensureCliProjectLead,
  findHealthySystemService,
  resolveDevHome,
  resolveRunProject,
  resolveStartPortEnv,
  resolveTuiProject,
  shouldPreferCanonicalPort,
  validateGlobals,
} from '../connection.js';
import {
  CLI_ENGAGEMENT_MODE_USAGE,
  cliEngagementModeOption,
  parseCliEngagementMode,
} from '../engagement-mode.js';
import { floatOpt, intOpt, resolvePromptText, saveArtifact } from '../generate.js';
import {
  formatNativeList,
  formatNativeStatus,
  installNativeToolkit,
  parseNativeVariant,
} from '../native-command.js';

const program = new Command();
program
  .name('gezel')
  .description('Gezel — build a community of agents that do things.')
  .version(GEZEL_VERSION)
  .option(
    '--connect <url>',
    'Connect to this Gezel service (first use asks for approval in the Gezel app).',
  )
  .option('--token <token>', 'Bearer token for --connect (must have CLI access).')
  .option(
    '--standalone',
    'Skip legacy full-product machine-service compatibility and use the per-user daemon.',
  )
  .option('--home <dir>', 'Use this user-owned Gezel home (default: $GEZEL_HOME or ~/.gezel).')
  .option(
    '--project [folder]',
    'Use this folder as the active project (default and bare flag: cwd).',
  );

/** Global flags, read off the root program. */
const cliGlobals = (): CliGlobals => program.opts() as CliGlobals;

// Apply --home before any command runs so the daemon spawn env, readRuntime,
// and in-proc startService all resolve the same home.
program.hook('preAction', () => {
  const globals = cliGlobals();
  validateGlobals(globals);
  applyHome(globals);
});

// Default command: a bare `gezel` (no subcommand) launches the interactive
// TUI bound to the current folder's project. Honors developer mode for the
// home dir (.gezel-dev). Otherwise it prefers the Electron-installed system
// legacy full-product service during rolling upgrades, then uses the app SDK
// to authorize against the per-user daemon. Ink/React are lazily imported so
// the other subcommands don't pay their load cost.
program.action(async () => {
  const globals = cliGlobals();
  resolveDevHome(globals);
  const client = await connectOwned(globals);
  const projectId = await resolveTuiProject(client, globals);
  const gezelId = await ensureCliProjectLead(client, projectId);
  let projectName = basename(process.cwd()) || 'workspace';
  try {
    const { projects } = await client.listProjects();
    projectName = projects.find((p) => p.id === projectId)?.name ?? projectName;
  } catch {
    /* fall back to the folder name */
  }
  const { launchTui } = await import('../tui/index.js');
  await launchTui({ client, projectId, projectName, gezelId });
});

program
  .command('start')
  .description('Start the Gezel daemon (no-op if already running)')
  .option(
    '--port <port>',
    'Bind to a specific port (spawns a fresh daemon, does not adopt a running one)',
  )
  .option(
    '--foreground',
    'Run the daemon attached to this terminal — stdio streams to this shell, Ctrl+C stops it. Useful for development and CI.',
  )
  .option(
    '--web',
    'Serve the web UI over HTTP on loopback and print a one-time browser URL (spawns a fresh HTTP daemon).',
  )
  .option('--open', 'With --web, open the printed URL in your default browser.')
  .action(async (opts: { port?: string; foreground?: boolean; web?: boolean; open?: boolean }) => {
    const port = opts.port ? Number.parseInt(opts.port, 10) : undefined;
    if (port !== undefined && !Number.isFinite(port)) {
      console.error(`invalid --port: ${opts.port}`);
      process.exitCode = 1;
      return;
    }

    // Web mode serves HTTP on loopback (a browser can't trust our
    // self-signed cert) and mints a dedicated browser token. Both flow
    // to the spawned daemon as env so they apply to fresh + foreground.
    const userEnv = { ...process.env };
    delete userEnv.GEZEL_SERVICE_ROLE;
    delete userEnv.GEZEL_SYSTEM_SCOPE;
    delete userEnv.GEZEL_PORT;
    const spawnEnv: NodeJS.ProcessEnv = {
      ...userEnv,
      GEZEL_SERVICE_ROLE: 'user',
    };
    // Explicit --port hard-binds. With a machine service registered the
    // daemon stays ephemeral ('0') — the broker owns canonical 6228.
    // Otherwise GEZEL_PORT is omitted so gezeld prefers 6228 with
    // ephemeral fallback, giving standalone installs the stable
    // third-party /v1 base URL.
    const portEnv = resolveStartPortEnv(port, await shouldPreferCanonicalPort());
    if (portEnv !== undefined) spawnEnv.GEZEL_PORT = portEnv;
    if (opts.web) {
      spawnEnv.GEZEL_WEB = '1';
      spawnEnv.GEZEL_INSECURE_TRANSPORT = '1';
    }

    if (opts.foreground) {
      await startForeground(spawnEnv);
      return;
    }

    // Force a fresh spawn when the user pinned a port or asked for web
    // mode: adopting a running daemon would silently ignore --port, or
    // (for --web) hand back a possibly-HTTPS daemon whose URL a browser
    // can't use. Otherwise adopt-or-spawn as usual.
    if (port !== undefined || opts.web) {
      const entry = resolveDaemonEntry(import.meta.url);
      const result = await discoverOrSpawn({
        daemonEntry: entry,
        detached: true,
        env: spawnEnv,
        // Always spawn fresh — don't adopt a running daemon that may be
        // on the wrong port / transport. (forceSpawn keeps the readiness
        // poll working, unlike a null readRuntimeFn override.)
        forceSpawn: true,
        // A cold first boot (fresh home: layout + default gezels +
        // native probe + catalog) routinely exceeds the 5s default, so
        // the spawn would time out while the daemon is still coming up —
        // and in --web mode the user would never see their URL. Give it
        // real headroom.
        timeoutMs: 20_000,
      });
      const health = await result.client.health();
      console.log(
        `gezeld running (version ${health.version}) on port ${new URL(result.baseUrl).port}`,
      );
      if (opts.web) await printWebUrl(result.baseUrl, opts.open === true);
      return;
    }

    const client = await connectOwned(cliGlobals());
    const health = await client.health();
    console.log(`gezeld running (version ${health.version})`);
  });

/**
 * Read the daemon's per-launch web-UI token from its runtime file and
 * print the one-time browser URL (optionally opening it). The detached
 * daemon's own stdout isn't visible to this process, so we reconstruct
 * the URL the daemon logged. `baseUrl` is the actual bound origin (honors
 * any ephemeral fallback).
 */
async function printWebUrl(baseUrl: string, open: boolean): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const { gezelPaths } = await import('@bendyline/gezel/paths');
  let token: string;
  try {
    token = (await readFile(gezelPaths().runtime.webUiToken, 'utf8')).trim();
  } catch {
    console.error('web UI: could not read the web-ui token from the runtime files.');
    return;
  }
  if (!token) {
    console.error('web UI: the web-ui token file was empty.');
    return;
  }
  const url = `${new URL(baseUrl).origin}/?token=${encodeURIComponent(token)}`;
  console.log('');
  console.log(`  Gezel web UI →  ${url}`);
  console.log('');
  if (open) await openInBrowser(url);
}

/** Open a URL in the default browser, cross-platform, best-effort. */
async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd builtin; the empty "" is the window title so a
      // URL isn't mistaken for one.
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
  } catch (err) {
    console.error(`could not open a browser automatically: ${(err as Error).message}`);
  }
}

async function startForeground(env: NodeJS.ProcessEnv): Promise<void> {
  const { spawn } = await import('node:child_process');
  const entry = resolveDaemonEntry(import.meta.url);

  // `env` is prepared by the caller (GEZEL_PORT / GEZEL_WEB / transport).
  // Keep a dedicated stdin ownership pipe while inheriting output. EOF gives
  // gezeld a graceful, cross-platform stop channel and the OS closes the same
  // pipe if this foreground owner crashes. In web mode the daemon still
  // prints its one-time URL to this stdout.
  const child = spawn(process.execPath, [entry], {
    detached: false,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...env, GEZEL_SHUTDOWN_ON_STDIN_EOF: '1' },
  });

  let stopping: Promise<void> | undefined;
  const requestStop = () => {
    stopping ??= stopOwnedDaemon(child);
    void stopping;
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  try {
    await new Promise<void>((resolve) => {
      child.on('exit', (code) => {
        process.exitCode = code ?? 0;
        resolve();
      });
    });
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
  }
}

program
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    const globals = cliGlobals();
    if (globals.connect) {
      const client = await connectOwned(globals);
      const health = await client.health();
      console.log(
        `gezeld explicit service port=${new URL(globals.connect).port || '(default)'} health=ok version=${health.version}`,
      );
      return;
    }
    const system = await findHealthySystemService(globals);
    if (system) {
      const client = new GezelClient({
        baseUrl: system.baseUrl,
        token: '',
        fetch: system.fetch,
      });
      const health = await client.health();
      console.log(
        `gezeld system service port=${system.port} health=ok version=${health.version} startedAt=${health.startedAt}`,
      );
      return;
    }
    const broker = await describeMachineEngineBroker();
    if (broker.present && broker.healthy && broker.serviceRole === 'machine-engine') {
      console.log(
        `gezeld machine engine broker port=${broker.port} health=ok version=${broker.version} (compute only — the product API is the per-user daemon below)`,
      );
    } else if (broker.present && broker.healthy === false) {
      console.log(
        `gezeld machine service: runtime files present but unreachable (port ${broker.port})`,
      );
    }
    const runtime = await readRuntime();
    if (!runtime) {
      console.log('gezeld is not running');
      return;
    }
    const alive = isProcessAlive(runtime.pid);
    console.log(`gezeld pid=${runtime.pid} port=${runtime.port} alive=${alive}`);
    if (!alive) return;
    const client = new GezelClient({
      baseUrl: runtime.baseUrl,
      // Health is intentionally unauthenticated; diagnostics do not need to
      // consume the per-launch first-party runtime credential.
      token: '',
      ...(runtime.cert ? { fetch: createTrustingFetch({ cert: runtime.cert }) } : {}),
    });
    try {
      const health = await client.health();
      const engineNote =
        health.machineEngineConnected !== undefined
          ? ` machineEngine=${health.machineEngineConnected ? 'connected' : 'unavailable'}`
          : '';
      console.log(
        `health ok: version=${health.version} startedAt=${health.startedAt}${engineNote}`,
      );
    } catch (err) {
      console.error(`health failed: ${(err as Error).message}`);
    }
  });

program
  .command('stop')
  .description('Stop the user-owned Gezel daemon')
  .action(async () => {
    const globals = cliGlobals();
    if (globals.connect) {
      throw new CliError('gezel stop cannot stop an explicit remote service.');
    }
    const system = await findHealthySystemService(globals);
    if (system) {
      console.log(
        `The Electron-installed system service is running on port ${system.port} and is managed by the operating system. Use --standalone to target a user-owned runtime instead.`,
      );
      return;
    }
    const runtime = await readRuntime();
    if (!runtime) {
      console.log('gezeld is not running');
      return;
    }
    const stopped = await stopProcessByPid(runtime.pid);
    if (stopped) {
      console.log(`stopped gezeld pid=${runtime.pid}`);
    } else {
      console.error(`failed to confirm gezeld pid=${runtime.pid} stopped`);
      process.exitCode = 1;
    }
  });

program
  .command('mode [mode]')
  .description('Show or set AI activity (read-only, reactive, reactive+tasks, or full-play)')
  .action(async (requested?: string) => {
    const next = requested ? parseCliEngagementMode(requested) : null;
    if (requested && !next) {
      throw new CliError(
        `Invalid mode: ${requested}. Usage: gezel mode <${CLI_ENGAGEMENT_MODE_USAGE}>`,
      );
    }

    const client = await connectOwned(cliGlobals());
    if (!next) {
      const config = await client.getConfig();
      const current = cliEngagementModeOption(config.aiEngagementMode);
      console.log(`${current.name} — ${current.description}`);
      return;
    }

    const updated = await client.updateConfig({ aiEngagementMode: next });
    const current = cliEngagementModeOption(updated.aiEngagementMode);
    console.log(`AI mode → ${current.name} — ${current.description}`);
  });

program
  .command('run [prompt...]')
  .description('Run a prompt through a gezel and print the reply')
  .option('-g, --gezel <ref>', "gezel id or name (default: this project's voorman)")
  .action(async (promptParts: string[], opts: { gezel?: string }) => {
    const prompt = (promptParts ?? []).join(' ').trim();
    if (!prompt) {
      console.error('usage: gezel run "<prompt>"');
      process.exitCode = 1;
      return;
    }
    const conn = await connectForRun(cliGlobals());
    try {
      const { client } = conn;
      const projectId = await resolveRunProject(client, cliGlobals());
      const gezelId = opts.gezel ?? (await ensureCliProjectLead(client, projectId));
      const session = await client.createChatSession({ gezelId, projectId });
      await client.sendToChatSession(session.id, prompt);
      let printed = false;
      let errored = false;
      for await (const ev of streamChatEvents({
        url: client.sessionEventsUrl(session.id),
        headers: client.authHeader(),
        fetch: client.getFetch(),
      })) {
        if (ev.type === 'delta') {
          process.stdout.write(ev.content);
          printed = true;
        } else if (ev.type === 'complete') {
          // Fallback for providers that send the whole message at once.
          if (!printed && ev.message.content) {
            process.stdout.write(ev.message.content);
            printed = true;
          }
        } else if (ev.type === 'error') {
          console.error(`\n${ev.error}`);
          errored = true;
        }
      }
      if (printed) process.stdout.write('\n');
      if (errored) process.exitCode = 1;
    } finally {
      if (conn.stop) await conn.stop();
    }
  });

const agent = program.command('agent').description('Manage agents');

agent
  .command('list')
  .description('List agents')
  .action(async () => {
    const client = await connectOwned(cliGlobals());
    const res = await client.listGezels();
    for (const a of res.gezels) {
      console.log(`${a.id.padEnd(20)}  ${a.name}`);
    }
  });

agent
  .command('create <name>')
  .description('Create a new agent')
  .option('-d, --description <text>', 'description')
  .option('-m, --model <model>', 'model identifier')
  .action(async (name: string, opts: { description?: string; model?: string }) => {
    const client = await connectOwned(cliGlobals());
    const created = await client.createGezel({ name, ...opts });
    console.log(`created agent ${created.id}`);
  });

agent
  .command('show <id>')
  .description('Show an agent')
  .action(async (id: string) => {
    const client = await connectOwned(cliGlobals());
    const a = await client.getGezel(id);
    console.log(a.parsed.source);
  });

const env = program.command('env').description('Manage projects');

env
  .command('list')
  .description('List projects')
  .action(async () => {
    const client = await connectOwned(cliGlobals());
    const res = await client.listProjects();
    for (const e of res.projects) {
      console.log(`${e.id.padEnd(20)}  ${e.name}`);
    }
  });

env
  .command('create <name>')
  .option('-d, --description <text>', 'description')
  .option(
    '-a, --about <text>',
    'about — paragraphs about who the project is for + scope (min 60 chars)',
  )
  .option('-m, --mission <text>', 'mission objectives — concrete success criteria (min 40 chars)')
  .action(
    async (name: string, opts: { description?: string; about?: string; mission?: string }) => {
      const about =
        opts.about ??
        `${name} — fill in the about for this project. Add paragraphs about who it's for, what's in scope, and what's explicitly out of scope.`;
      const missionObjectives =
        opts.mission ??
        `${name} — fill in the mission objectives. Use concrete success criteria, usually as a bullet list.`;
      const client = await connectOwned(cliGlobals());
      const created = await client.createProject({
        name,
        ...(opts.description ? { description: opts.description } : {}),
        about,
        missionObjectives,
      });
      console.log(`created project ${created.id}`);
    },
  );

env
  .command('install <envId> <package>')
  .description('Install an npm package into a project (--ignore-scripts)')
  .option('-V, --version <version>', 'package version')
  .action(async (envId: string, pkg: string, opts: { version?: string }) => {
    const client = await connectOwned(cliGlobals());
    const res = await client.installPackage(envId, { name: pkg, version: opts.version });
    console.log(res.log);
    console.log(`installed ${pkg} into ${envId}`);
  });

const skills = program
  .command('skills')
  .description('Discover and convert SKILL.md skills into craftbooks');

skills
  .command('list')
  .description('List skills discovered in the project workspace')
  .action(async () => {
    const client = await connectOwned(cliGlobals());
    const projectId = await resolveRunProject(client, cliGlobals());
    const index = await client.getProjectSkills(projectId);
    if (index.skills.length === 0) {
      console.log('no skills discovered (.claude/skills, .gstack/skills, agents/skills)');
      return;
    }
    for (const s of index.skills) {
      console.log(
        `${s.name.padEnd(24)}  ${s.source}${s.description ? `  — ${s.description}` : ''}`,
      );
    }
  });

skills
  .command('import <source>')
  .description('Convert a discovered skill (by its workspace-relative SKILL.md path)')
  .option('--queue', 'queue script/persona-bearing results for review instead of reporting')
  .option('--no-llm', 'static conversion only — never call the model for shell blocks')
  .action(async (source: string, opts: { queue?: boolean; llm?: boolean }) => {
    const client = await connectOwned(cliGlobals());
    const projectId = await resolveRunProject(client, cliGlobals());
    const result = await client.convertProjectImport(projectId, source, {
      allowLlm: opts.llm !== false,
    });
    switch (result.status) {
      case 'written':
        console.log(`imported as craftbook ${result.craftbookId}`);
        break;
      case 'queued': {
        // Human at the keyboard: approve immediately unless --queue asked
        // for the review flow.
        if (opts.queue) {
          console.log(
            `queued for review (${result.scripts} script(s)${result.persona ? `, persona "${result.persona}"` : ''}) — approve in the Commands panel`,
          );
          break;
        }
        const approved = await client.approveProjectImport(projectId, source);
        console.log(
          `imported as craftbook ${approved.craftbookId} (${result.scripts} script(s)${result.persona ? `, persona "${result.persona}"` : ''})`,
        );
        break;
      }
      case 'user-edited':
        console.log('already imported and user-edited — left untouched');
        break;
      case 'not-found':
        console.error(`no discovered skill at ${source} — try \`gezel skills list\``);
        process.exitCode = 1;
        break;
      default:
        console.error(`conversion failed: ${result.notes.join('; ') || 'see the service log'}`);
        process.exitCode = 1;
    }
    for (const note of result.notes) console.log(`  note: ${note}`);
  });

skills
  .command('convert <path>')
  .description('Convert a SKILL.md file to a craftbook document on stdout (no daemon)')
  .option('--md', 'emit the markdown encoding instead of JSON')
  .option('--released-at <iso>', 'stamp releasedAt (catalog authoring)')
  .action(async (path: string, opts: { md?: boolean; releasedAt?: string }) => {
    const { readFile: readFsFile } = await import('node:fs/promises');
    const { basename: base, dirname: dir } = await import('node:path');
    const { parseSkillDoc, skillToCraftbookDoc, serializeCraftbookDoc, craftbookFromDoc } =
      await import('@bendyline/gezel');
    const raw = await readFsFile(path, 'utf8');
    const skill = parseSkillDoc(raw, { fallbackName: base(dir(path)) });
    const result = skillToCraftbookDoc(skill, {
      ...(opts.releasedAt ? { releasedAt: opts.releasedAt } : {}),
    });
    const check = craftbookFromDoc(result.doc, { now: '1970-01-01T00:00:00.000Z' });
    if (!check.ok) {
      console.error('conversion produced an invalid craftbook:');
      for (const e of check.errors) console.error(`  ${e.where}: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(serializeCraftbookDoc(result.doc, opts.md ? 'markdown' : 'json'));
    for (const note of result.notes) console.error(`note: ${note}`);
    if (result.persona) console.error(`persona: ${result.persona.role}`);
  });

const handboek = program.command('handboek').description('The built-in documentation (Handboek)');

handboek
  .command('export')
  .description('Render the Handboek as a static HTML site for gezel.com (no daemon)')
  .requiredOption('--out <dir>', 'output directory')
  .option(
    '--css <href>',
    'extra stylesheet to link on every page; relative hrefs resolve against the export root. Repeatable.',
    (href: string, prior: string[]) => [...prior, href],
    [] as string[],
  )
  .option(
    '--site-url <url>',
    'URL of the surrounding site; adds a wordmark link back out of the docs',
  )
  .action(async (opts: { out: string; css: string[]; siteUrl?: string }) => {
    const { runHandboekExport } = await import('../handboek-export.js');
    const result = await runHandboekExport({
      out: opts.out,
      css: opts.css,
      siteUrl: opts.siteUrl,
    });
    console.log(`Handboek exported: ${result.pages} pages → ${result.out}`);
    for (const id of result.skipped) console.error(`  skipped (no body): ${id}`);
  });

const task = program.command('task').description('Manage tasks');

task
  .command('list')
  .description('List tasks across every project')
  .option('-s, --status <status>', 'filter by status (paused|active|complete|canceled)')
  .action(async (opts: { status?: string }) => {
    const client = await connectOwned(cliGlobals());
    const res = await client.listTasks(
      opts.status
        ? { status: opts.status as 'paused' | 'active' | 'complete' | 'canceled' }
        : undefined,
    );
    for (const t of res.tasks) {
      const assignee = t.assignee.kind === 'user' ? 'user' : t.assignee.gezelId;
      console.log(
        `${t.ref.padEnd(24)}  ${t.status.padEnd(10)}  ${assignee.padEnd(20)}  ${t.title}`,
      );
    }
  });

task
  .command('create <projectId> <title>')
  .description('Create a task with a single phase')
  .option('-a, --assignee <gezelId>', 'gezel id to assign (default: user)')
  .option('-p, --phase <name>', 'first phase name', 'Main')
  .option('-d, --description <text>', 'task description — what done looks like (min 40 chars)')
  .action(
    async (
      projectId: string,
      title: string,
      opts: { assignee?: string; phase: string; description?: string },
    ) => {
      const description =
        opts.description ??
        `${title} — fill in the task description. Cover what done looks like, key constraints, and any links the assignee will need.`;
      const client = await connectOwned(cliGlobals());
      const created = await client.createTask(projectId, {
        title,
        description,
        assignee: opts.assignee ? { kind: 'gezel', gezelId: opts.assignee } : { kind: 'user' },
        steps: [{ name: opts.phase }],
      });
      console.log(`created ${created.ref}`);
    },
  );

task
  .command('show <ref>')
  .description('Show one task (format: projectId/num)')
  .action(async (ref: string) => {
    const client = await connectOwned(cliGlobals());
    const t = await client.getTaskByRef(ref);
    console.log(JSON.stringify(t, null, 2));
  });

// ── Generation: create-image / create-video / create-audio ──────────
// One-shot calls into the configured generators. The prompt/text comes
// from the variadic argument or `--file <path>`; `--model` overrides the
// engine default. Output bytes are pulled back from the daemon and
// written to a local file (cwd by default, or `--output`).

interface GenCommonOpts {
  file?: string;
  model?: string;
  project?: string;
  output?: string;
}

program
  .command('create-image [prompt...]')
  .description('Generate an image from a prompt (or --file) via the configured image engine')
  .option('-f, --file <path>', 'read the prompt from a text file instead of the argument')
  .option('-m, --model <id>', 'image model catalog id (default: the engine default)')
  .option('-n, --negative <text>', 'negative prompt')
  .option('-W, --width <px>', 'width in pixels')
  .option('-H, --height <px>', 'height in pixels')
  .option('-s, --steps <n>', 'sampler steps (default: the model recommendation)')
  .option('--seed <n>', 'seed for reproducible output')
  .option('-p, --project <id>', 'project to write the artifact under', 'default')
  .option('-o, --output <path>', 'write the image here (default: ./<artifact name>)')
  .action(
    async (
      promptParts: string[],
      opts: GenCommonOpts & {
        negative?: string;
        width?: string;
        height?: string;
        steps?: string;
        seed?: string;
      },
    ) => {
      const prompt = await resolvePromptText(promptParts, opts.file, 'prompt');
      const client = await connectOwned(cliGlobals());
      const projectId = opts.project ?? 'default';
      const width = intOpt('width', opts.width);
      const height = intOpt('height', opts.height);
      const steps = intOpt('steps', opts.steps);
      const seed = intOpt('seed', opts.seed);
      console.error(`generating image${opts.model ? ` (model ${opts.model})` : ''}...`);
      let res: Awaited<ReturnType<typeof client.generateImage>>;
      try {
        res = await client.generateImage({
          prompt,
          projectId,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.negative ? { negativePrompt: opts.negative } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(steps !== undefined ? { steps } : {}),
          ...(seed !== undefined ? { seed } : {}),
        });
      } catch (err) {
        throw new CliError(
          `image generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const dest = await saveArtifact(client, projectId, res.artifactPath, opts.output);
      const m = res.meta;
      console.log(dest);
      console.error(
        `  model=${m.model} seed=${m.seed} steps=${m.steps} size=${m.widthPx}x${m.heightPx} time=${(m.durationMs / 1000).toFixed(1)}s`,
      );
    },
  );

program
  .command('create-video [prompt...]')
  .description('Generate a video from a prompt (or --file) via the configured video engine')
  .option('-f, --file <path>', 'read the prompt from a text file instead of the argument')
  .option('-m, --model <id>', 'video model catalog id (default: the engine default)')
  .option('-n, --negative <text>', 'negative prompt')
  .option('-W, --width <px>', 'width in pixels')
  .option('-H, --height <px>', 'height in pixels')
  .option('--frames <n>', 'number of frames')
  .option('--fps <n>', 'frames per second')
  .option('-s, --steps <n>', 'sampler steps')
  .option('--seed <n>', 'seed for reproducible output')
  .option('-p, --project <id>', 'project to write the artifact under', 'default')
  .option('-o, --output <path>', 'write the video here (default: ./<artifact name>)')
  .action(
    async (
      promptParts: string[],
      opts: GenCommonOpts & {
        negative?: string;
        width?: string;
        height?: string;
        frames?: string;
        fps?: string;
        steps?: string;
        seed?: string;
      },
    ) => {
      const prompt = await resolvePromptText(promptParts, opts.file, 'prompt');
      const client = await connectOwned(cliGlobals());
      const projectId = opts.project ?? 'default';
      const width = intOpt('width', opts.width);
      const height = intOpt('height', opts.height);
      const numFrames = intOpt('frames', opts.frames);
      const fps = intOpt('fps', opts.fps);
      const steps = intOpt('steps', opts.steps);
      const seed = intOpt('seed', opts.seed);
      console.error(
        `generating video${opts.model ? ` (model ${opts.model})` : ''} — this can take a while...`,
      );
      let res: Awaited<ReturnType<typeof client.generateVideo>>;
      try {
        res = await client.generateVideo({
          prompt,
          projectId,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.negative ? { negativePrompt: opts.negative } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(numFrames !== undefined ? { numFrames } : {}),
          ...(fps !== undefined ? { fps } : {}),
          ...(steps !== undefined ? { steps } : {}),
          ...(seed !== undefined ? { seed } : {}),
        });
      } catch (err) {
        throw new CliError(
          `video generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const dest = await saveArtifact(client, projectId, res.artifactPath, opts.output);
      const m = res.meta;
      console.log(dest);
      console.error(
        `  model=${m.model} seed=${m.seed} ${m.widthPx}x${m.heightPx} frames=${m.numFrames} fps=${m.fps} time=${(m.durationMs / 1000).toFixed(1)}s`,
      );
    },
  );

program
  .command('create-audio [text...]')
  .description('Synthesize speech from text (or --file) via the configured TTS engine')
  .option('-f, --file <path>', 'read the text from a file instead of the argument')
  .option('-m, --model <id>', 'TTS model catalog id (default: the engine default)')
  .option('--voice <id>', 'voice id (default: the model/gezel default)')
  .option('--speed <x>', 'speed multiplier, 0.25-4 (default: 1.0)')
  .option('-p, --project <id>', 'project to write the artifact under', 'default')
  .option('-o, --output <path>', 'write the audio here (default: ./<artifact name>)')
  .action(async (textParts: string[], opts: GenCommonOpts & { voice?: string; speed?: string }) => {
    const text = await resolvePromptText(textParts, opts.file, 'text');
    const client = await connectOwned(cliGlobals());
    const projectId = opts.project ?? 'default';
    const speed = floatOpt('speed', opts.speed);
    console.error('synthesizing speech...');
    let res: Awaited<ReturnType<typeof client.synthesizeSpeech>>;
    try {
      res = await client.synthesizeSpeech({
        text,
        projectId,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.voice ? { voice: opts.voice } : {}),
        ...(speed !== undefined ? { speed } : {}),
      });
    } catch (err) {
      throw new CliError(
        `speech synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const dest = await saveArtifact(client, projectId, res.artifactPath, opts.output);
    const m = res.meta;
    console.log(dest);
    console.error(
      `  voice=${m.voice} model=${m.model} ${m.durationSeconds.toFixed(1)}s @ ${m.sampleRate}Hz`,
    );
  });

// ── Native engine binaries ──────────────────────────────────────────
const native = program.command('native').description('Manage native engine binaries');

native
  .command('install')
  .description('Download, verify, and activate the native inference toolkit')
  .option('--variant <backend>', 'llama.cpp backend: cuda | vulkan | metal | cpu')
  .action(async (opts: { variant?: string }) => {
    // Validate before connecting so a typo never starts a daemon.
    const variant = parseNativeVariant(opts.variant);
    const client = await connectOwned(cliGlobals());
    const installed = await installNativeToolkit(client, {
      ...(variant ? { variant } : {}),
      output: { writeProgress: (text) => process.stderr.write(text) },
    });
    console.log(`native toolkit ready\n${formatNativeStatus(installed)}`);
  });

native
  .command('list')
  .description('List native executables and their install state')
  .action(async () => {
    const client = await connectOwned(cliGlobals());
    console.log(formatNativeList(await client.getNativeEngineStatus()));
  });

native
  .command('status')
  .description('Show native release, platform, backend, and toolkit status')
  .action(async () => {
    const client = await connectOwned(cliGlobals());
    console.log(formatNativeStatus(await client.getNativeEngineStatus()));
  });

// ── Image model management (pull/list for the create-image engine) ──
const image = program.command('image').description('Manage image-generation models');

image
  .command('status')
  .description('Show the image engine status and local model count')
  .action(async () => {
    const client = await connectOwned(cliGlobals());
    const { engine, modelCount } = await client.getImageEngineStatus();
    console.log(
      `engine: ${engine.provider ?? 'unknown'} (${engine.kind ?? '?'}) — ${engine.status}`,
    );
    if (engine.error) console.log(`  ${engine.error}`);
    console.log(`local models: ${modelCount}`);
  });

image
  .command('models')
  .description('List local image models')
  .action(async () => {
    const client = await connectOwned(cliGlobals());
    const { models } = await client.listInstalledImageModels();
    if (models.length === 0) {
      console.log('(no local image models — download one with `gezel image pull <id>`)');
      return;
    }
    for (const m of models) {
      console.log(
        `${m.id.padEnd(24)}  ${(m.approxSizeBytes / 1e9).toFixed(2).padStart(6)} GB  ${m.name}`,
      );
    }
  });

image
  .command('pull <id>')
  .description('Download an image model from the catalog (e.g. krea-2-turbo-q4)')
  .action(async (id: string) => {
    const client = await connectOwned(cliGlobals());
    let lastPct = -1;
    let pullError: string | undefined;
    await client.pullImageModel(id, (ev) => {
      if (ev.type === 'progress') {
        const total = ev.totalBytes ?? 0;
        const pct = total > 0 ? Math.floor((ev.bytesWritten / total) * 100) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          process.stderr.write(
            `\rpulling ${id}: ${String(pct).padStart(3)}%  ${(ev.bytesWritten / 1e9).toFixed(2)}/${(total / 1e9).toFixed(2)} GB`,
          );
        }
      } else if (ev.type === 'retrying') {
        process.stderr.write(`\n  retry ${ev.attempt}/${ev.maxAttempts}: ${ev.reason}\n`);
      } else if (ev.type === 'error') {
        pullError = ev.error;
        process.stderr.write('\n');
      } else if (ev.type === 'done' && !pullError) {
        process.stderr.write(`\rpulled ${id}${' '.repeat(48)}\n`);
      }
    });
    if (pullError) throw new CliError(`pull failed: ${pullError}`);
  });

image
  .command('rm <id>')
  .description('Delete a local image model')
  .action(async (id: string) => {
    const client = await connectOwned(cliGlobals());
    await client.deleteImageModel(id);
    console.log(`removed ${id}`);
  });

const model = program.command('model').description('Manage local chat models (MLX / llama)');

/**
 * Which local engine a `model` subcommand targets. Defaults to the
 * platform default — MLX on Apple Silicon, llama.cpp elsewhere — matching
 * the daemon's own `defaultProvider()` so a bare `gezel model pull <id>`
 * warms the engine the daemon will actually run. Override with
 * `--provider`. The download lands in the connected daemon's home
 * (`<home>/engines/<engine>/models/`); use `--home ~/.gezel-dev` to warm
 * the dev/eval source home.
 */
function resolveModelProvider(raw?: string): 'mlx' | 'llama-cpp' | 'ds4' {
  if (raw) {
    if (raw !== 'mlx' && raw !== 'llama-cpp' && raw !== 'ds4') {
      throw new CliError(`--provider must be one of mlx, llama-cpp, ds4 (got "${raw}")`);
    }
    return raw;
  }
  return process.platform === 'darwin' && process.arch === 'arm64' ? 'mlx' : 'llama-cpp';
}

model
  .command('list')
  .description('List local chat models for an engine')
  .option('-p, --provider <engine>', 'mlx | llama-cpp | ds4 (default: platform default)')
  .action(async (opts: { provider?: string }) => {
    const client = await connectOwned(cliGlobals());
    const provider = resolveModelProvider(opts.provider);
    const { models } =
      provider === 'mlx'
        ? await client.listMlxModels()
        : provider === 'ds4'
          ? await client.listDs4Models()
          : await client.listLlamaCppModels();
    if (models.length === 0) {
      console.log(`(no local ${provider} models — download one with \`gezel model pull <id>\`)`);
      return;
    }
    for (const m of models) {
      console.log(
        `${m.id.padEnd(28)}  ${(m.approxSizeBytes / 1e9).toFixed(2).padStart(6)} GB  ${m.name}`,
      );
    }
  });

model
  .command('pull <id>')
  .description('Download a local chat model from the catalog (e.g. gemma4-31b-q4)')
  .option('-p, --provider <engine>', 'mlx | llama-cpp | ds4 (default: platform default)')
  .action(async (id: string, opts: { provider?: string }) => {
    const client = await connectOwned(cliGlobals());
    const provider = resolveModelProvider(opts.provider);
    let lastPct = -1;
    let pullError: string | undefined;
    // MLX repos are multi-file (config + shards); the SSE carries
    // cumulative `bytesWrittenAll`/`totalBytesAll` across every file, while
    // the GGUF engines report a single `bytesWritten`/`totalBytes`. Render
    // whichever the event provides so one progress line covers both.
    const onEvent = (ev: MlxInstallEvent | LlamaCppInstallEvent): void => {
      if (ev.type === 'progress') {
        const written = 'bytesWrittenAll' in ev ? ev.bytesWrittenAll : ev.bytesWritten;
        const total = 'totalBytesAll' in ev ? ev.totalBytesAll : (ev.totalBytes ?? 0);
        const pct = total > 0 ? Math.floor((written / total) * 100) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          process.stderr.write(
            `\rpulling ${id} (${provider}): ${String(pct).padStart(3)}%  ${(written / 1e9).toFixed(2)}/${(total / 1e9).toFixed(2)} GB`,
          );
        }
      } else if (ev.type === 'retrying') {
        process.stderr.write(`\n  retry ${ev.attempt}/${ev.maxAttempts}: ${ev.reason}\n`);
      } else if (ev.type === 'error') {
        pullError = ev.error;
        process.stderr.write('\n');
      } else if (ev.type === 'done' && !pullError) {
        process.stderr.write(`\rpulled ${id} (${provider})${' '.repeat(48)}\n`);
      }
    };
    if (provider === 'mlx') {
      await client.installMlxModel(id, onEvent);
    } else if (provider === 'ds4') {
      await client.installDs4Model(id, onEvent);
    } else {
      await client.installLlamaCppModel(id, onEvent);
    }
    if (pullError) throw new CliError(`pull failed: ${pullError}`);
  });

program
  .command('doctor')
  .description('Check the Gezel installation')
  .action(async () => {
    const globals = cliGlobals();
    const system = globals.connect ? null : await findHealthySystemService(globals);
    const broker = globals.connect ? null : await describeMachineEngineBroker();
    const runtime = await readRuntime();
    console.log(`node: ${process.version}`);
    if (globals.connect) {
      console.log('machine service: skipped (--connect)');
    } else if (system) {
      console.log(`system service (product): healthy (${system.baseUrl})`);
    } else if (broker?.present && broker.healthy && broker.serviceRole === 'machine-engine') {
      console.log(
        `machine engine: healthy (${broker.baseUrl}) version=${broker.version} — compute broker; the product API is the per-user daemon`,
      );
    } else if (broker?.present && broker.healthy === false) {
      console.log(`machine service: runtime files present but unreachable (port ${broker.port})`);
    } else if (broker?.present) {
      console.log(
        `machine service: healthy (${broker.baseUrl}) role=${broker.serviceRole ?? 'legacy-full'} (not selected for this command)`,
      );
    } else {
      console.log('machine service: not installed');
    }
    console.log(`runtime file: ${runtime ? 'present' : 'missing'}`);
    if (runtime) {
      const alive = isProcessAlive(runtime.pid);
      console.log(`  port=${runtime.port} pid=${runtime.pid} alive=${alive}`);
      if (alive) {
        try {
          const client = new GezelClient({
            baseUrl: runtime.baseUrl,
            token: '',
            ...(runtime.cert ? { fetch: createTrustingFetch({ cert: runtime.cert }) } : {}),
          });
          const health = await client.health();
          const engineNote =
            health.machineEngineConnected !== undefined
              ? ` machine engine connected: ${health.machineEngineConnected ? 'yes' : 'no'}`
              : '';
          console.log(`  role=${health.serviceRole ?? 'user'}${engineNote}`);
        } catch {
          /* doctor's per-field probes stay best-effort */
        }
      }
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  // CliError is a user-facing failure (e.g. a guest connection trying to run
  // a management command) — print just the message, no stack.
  if (err instanceof CliError) console.error(err.message);
  else console.error(err);
  process.exit(1);
});
