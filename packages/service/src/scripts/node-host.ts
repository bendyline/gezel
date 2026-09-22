/**
 * The desktop's side of the script runner port.
 *
 * The runner itself is the shared `PortableScriptRunner`; this supplies
 * what a Node host adds: sources read from disk per scope, provenance trust
 * from the catalog and from CLI-authorised hashes, the workspace-write
 * gate, the capability dispatcher with its desktop-only methods, atomic run
 * persistence, and a reading of a sandboxed child's stderr.
 */
import { readFile } from 'node:fs/promises';
import {
  MANAGED_WORKSPACE_WRITE_SETTING_LABEL,
  ScriptNotFoundError,
  type ScriptRun,
  type ScriptRunTrigger,
  type ScriptScope,
  createLogger,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type {
  PortableScriptContext,
  PortableScriptDefinition,
  ScriptExecutionResult,
} from '@bendyline/gezel-script-runtime';
import { projectScriptFile, userScriptFile } from '@bendyline/gezel/paths';
import type { Store } from '../fs/store.js';
import type { buildDispatcher } from './dispatcher.js';
import { parseScriptMeta } from './meta.js';
import { writeProjectScriptRun } from './runs.js';
import { scriptSourceHash } from './source.js';
import { stdlibScriptFile } from './stdlib-source.js';
import { computeScriptTrust } from './trust.js';

const log = createLogger('scripts');

type Dispatcher = Pick<ReturnType<typeof buildDispatcher>, 'dispatch'>;

export interface NodeScriptHostOptions {
  store: Store;
  catalog?: CatalogService;
  dispatcher: Dispatcher;
}

export class NodeScriptHost {
  private readonly store: Store;
  private readonly catalog: CatalogService | undefined;
  private dispatcher: Dispatcher;

  constructor(options: NodeScriptHostOptions) {
    this.store = options.store;
    this.catalog = options.catalog;
    this.dispatcher = options.dispatcher;
  }

  /** The dispatcher is rebuilt when late-bound services arrive. */
  setDispatcher(dispatcher: Dispatcher): void {
    this.dispatcher = dispatcher;
  }

  async resolve(
    name: string,
    scope: ScriptScope,
    context: { projectId: string; trigger: ScriptRunTrigger; inlineSource?: string },
  ): Promise<PortableScriptDefinition> {
    const inline = context.inlineSource !== undefined;
    let source: string;
    if (inline) source = context.inlineSource!;
    else {
      const file = await (scope === 'standard'
        ? stdlibScriptFile(name)
        : scope === 'user'
          ? userScriptFile(this.store.homePath, name)
          : // Craftbook-bundled scripts are installed into the project at
            // task creation; resolve the installed copy.
            projectScriptFile(this.store.homePath, context.projectId, name));
      try {
        source = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT')
          throw new ScriptNotFoundError(name, scope);
        throw err;
      }
    }
    const meta = parseScriptMeta(source, inline ? `<craftbook>/${name}.ts` : `${scope}/${name}.ts`);
    const trust = await computeScriptTrust(
      { catalog: this.catalog, readTask: this.store.readTask.bind(this.store) },
      {
        scope,
        source,
        scriptName: name,
        inline,
        projectId: context.projectId,
        trigger: context.trigger,
      },
    );
    if (trust.cliTrusted && !trust.provenanceTrusted)
      log.info(
        `[scripts] CLI-authorized custom script ${name}: using best-effort network isolation`,
      );
    return {
      source,
      originalSource: source,
      hash: scriptSourceHash(source),
      meta,
      scope,
      provenanceTrusted: trust.provenanceTrusted || trust.cliTrusted,
    };
  }

  readConfig() {
    return this.store.readConfig();
  }

  /**
   * Scripts count as gezel-initiated work: internal workspaces writable,
   * external directories opt-in, a per-project "edits off" respected.
   */
  async workspaceWriteAllowed(projectId: string): Promise<{ ok: boolean; reason?: string }> {
    const gate = await this.store.assertWorkspaceWritable(projectId, { initiatedByGezel: true });
    if (gate.ok) return { ok: true };
    return {
      ok: false,
      reason:
        gate.reason === 'external-consent-required'
          ? `gezel writes to this project's external working directory require "${MANAGED_WORKSPACE_WRITE_SETTING_LABEL}" in Project → Settings`
          : 'gezel workspace writes are turned off for this project (Project → Settings)',
    };
  }

  dispatch(context: PortableScriptContext, method: string, params: unknown): Promise<unknown> {
    return this.dispatcher.dispatch(
      {
        projectId: context.projectId,
        runId: context.runId,
        scriptName: context.scriptName,
        // Copies of the live ceiling: a handler reads them, the runner owns them.
        allowedCapabilities: new Set(context.capabilities.allowed),
        strippedCapabilities: new Map(context.capabilities.stripped),
        // The same set, so a secret a handler resolves reaches the runner's redaction.
        knownSecretValues: context.secrets,
      },
      method,
      params,
    );
  }

  async persistRun(run: ScriptRun): Promise<void> {
    await writeProjectScriptRun(this.store.homePath, run);
    if (run.finishedAt && run.status === 'error')
      log.error(
        `[script-run] runId=${run.id} project=${run.projectId} script=${run.scriptName} ` +
          `trigger=${run.trigger.kind} error=${run.error ?? 'unknown error'} ` +
          `logsTail=${JSON.stringify(tailText(run.logs, 1_500))}`,
      );
  }

  describeFailure(result: ScriptExecutionResult): string {
    return extractScriptFailureFromStderr(result.stderr) ?? formatScriptExitFailure(result);
  }
}

/** The script's own thrown line from a sandboxed child's stderr, when one is there. */
export function extractScriptFailureFromStderr(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const refusal = lines.find(
    (line) =>
      line.startsWith('[sandbox error]') ||
      line.startsWith('Error: script attempted to call') ||
      line.startsWith('Error: script called'),
  );
  if (refusal) return refusal;
  return lines.find((line) => /^(?:Error|[A-Za-z][A-Za-z0-9]*Error):\s+\S/.test(line));
}

function formatScriptExitFailure(result: ScriptExecutionResult): string {
  const exit = result.signal
    ? `script closed by signal ${result.signal}`
    : `script exited with code ${result.exitCode}`;
  const stderrTail = tailText(result.stderr, 600);
  return stderrTail.length > 0 ? `${exit}: ${stderrTail}` : `${exit} without stderr output`;
}

function tailText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…${trimmed.slice(trimmed.length - maxChars)}`;
}
