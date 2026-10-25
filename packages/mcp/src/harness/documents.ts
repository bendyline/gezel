import { createHash } from 'node:crypto';
import { constants, existsSync, readFileSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  HARNESS_DOCUMENT_TOOL_NAMES,
  HARNESS_DOCUMENT_TOOL_NOTES,
  type HarnessDocumentToolName,
} from '@bendyline/gezel';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { argumentHelp, missingArguments } from './arguments.js';
import snapshot from './docblocks-tools.json';
import { absoluteFromApp, relativeInside } from './paths.js';
import { type HarnessBinding, type HarnessSession, boundProjectId } from './session.js';
import { failure, guarded } from './tools.js';

/**
 * DocBlocks' document tools, passed through to an outside app. Gezel ships
 * DocBlocks; an app has no way to set it up on its own. The harness lists the
 * tools from a snapshot of the shipped version's schemas, so listing never
 * waits on a process, and starts DocBlocks under the app's account on the
 * first call, one per bound folder: its artifacts live in that process until
 * saved. It reads the bound project's folder and writes only Gezel's output
 * folder, so Gezel still never writes into the person's folder.
 */

type JsonSchema = Record<string, unknown>;
interface SnapshotTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
}

const TOOLS = (snapshot as { tools: SnapshotTool[] }).tools;
/** Arguments DocBlocks parses as a document source, per tool. */
const SOURCE_ARGS: Partial<Record<HarnessDocumentToolName, readonly string[]>> = {
  convert_document: ['source'],
  get_authoring_context: ['source'],
  inspect_document: ['source'],
  preview_document: ['source'],
};
/** A render to MP4 can run for minutes; progress resets this. */
const CALL_TIMEOUT_MS = 10 * 60_000;
const OUTDATED =
  "This version of Gezel can't make documents for other apps yet. Update Gezel, then try again.";

/**
 * `save_artifact`'s destination as an app writes it: a file name. DocBlocks'
 * own shape needs an opaque root id from `list_roots`, which a gezel already
 * holds and an app would have to fetch first.
 */
function appSaveSchema(schema: JsonSchema): JsonSchema {
  const destination = (schema.properties as Record<string, { anyOf?: JsonSchema[] }>).destination;
  const path = (destination?.anyOf?.[0]?.properties as Record<string, JsonSchema> | undefined)
    ?.path;
  return {
    ...schema,
    properties: {
      ...(schema.properties as Record<string, unknown>),
      destination: {
        type: 'object',
        properties: {
          path: {
            ...path,
            description:
              "A file name, or a path inside Gezel's output folder, such as report.docx.",
          },
          ifExists: { type: 'string', enum: ['error', 'replace'], default: 'error' },
          expectedSha256: {
            type: 'string',
            pattern: '^[a-f0-9]{64}$',
            description: "With ifExists replace: the current file's SHA-256.",
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  };
}

/** A schema that accepts any arguments and lists as `json`: DocBlocks validates the call itself. */
function listedAs(json: JsonSchema) {
  const schema = z.object({}).loose();
  (schema._zod as { toJSONSchema?: () => JsonSchema }).toJSONSchema = () => structuredClone(json);
  return schema;
}

/** One DocBlocks process with this binding's folders. */
class DocblocksRuntime {
  private constructor(
    private readonly client: Client,
    readonly readRoot: string | null,
    readonly outputDir: string,
    readonly writeRootId: string,
  ) {}

  static async start(binding: HarnessBinding): Promise<DocblocksRuntime> {
    const docs = binding.info?.documents;
    if (!docs) throw new Error(OUTDATED);
    const readRoot = binding.info?.project?.workingDir ?? null;
    const outputDir = await outputDirFor(binding);
    const args = [docs.entry, 'mcp'];
    if (readRoot) args.push('--allow-read', readRoot);
    args.push('--allow-write', outputDir);
    const env: Record<string, string> = {};
    if (docs.browsersPath) env.PLAYWRIGHT_BROWSERS_PATH = docs.browsersPath;
    if (process.env.SQUISQ_FFMPEG) env.SQUISQ_FFMPEG = process.env.SQUISQ_FFMPEG;
    const client = new Client({ name: 'gezel-harness', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args, env, stderr: 'ignore' }),
    );
    const listed = await client.callTool({ name: 'list_roots', arguments: {} });
    const writeRootId = writableRoot(listed as CallToolResult);
    if (!writeRootId) {
      await client.close().catch(() => {});
      throw new Error("Gezel's document tools started without a folder to save into.");
    }
    return new DocblocksRuntime(client, readRoot, outputDir, writeRootId);
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    })) as CallToolResult;
  }

  close(): Promise<void> {
    return this.client.close().catch(() => {});
  }
}

/**
 * Where saved documents go: the project's artifacts in Gezel, beside its
 * generated images. A machine-wide Gezel keeps those where this account cannot
 * write, so then a folder of this account's own.
 */
async function outputDirFor(binding: HarnessBinding): Promise<string> {
  const artifactsDir = binding.info?.artifactsDir;
  if (artifactsDir) {
    const dir = join(artifactsDir, 'documents');
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, constants.W_OK);
      return dir;
    } catch {}
  }
  const dir = join(tmpdir(), 'gezel-documents', boundProjectId(binding) ?? 'default');
  await mkdir(dir, { recursive: true });
  return dir;
}

function writableRoot(listed: CallToolResult): string | null {
  const text = listed.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('');
  const structured = listed.structuredContent as { roots?: unknown } | undefined;
  let roots: unknown = structured?.roots;
  if (!Array.isArray(roots)) {
    try {
      roots = (JSON.parse(text) as { roots?: unknown }).roots;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(roots)) return null;
  const root = (roots as Array<{ id?: unknown; write?: unknown }>).find((r) => r.write === true);
  return typeof root?.id === 'string' ? root.id : null;
}

/**
 * A document source with the app's path made DocBlocks': relative to the one
 * read root, forward-slashed, no root id. An app names files by absolute path
 * or relative to the folder it works in, which may sit below that root.
 */
function appSource(
  binding: HarnessBinding,
  runtime: DocblocksRuntime,
  source: unknown,
): { source: unknown } | { error: string } {
  const path =
    typeof source === 'string' && !source.startsWith('docblocks://')
      ? source
      : source && typeof source === 'object' && (source as { kind?: unknown }).kind === 'file'
        ? (source as { path?: unknown }).path
        : undefined;
  if (typeof path !== 'string') return { source };
  if (!runtime.readRoot) {
    return { error: 'This app is not working in a Gezel folder, so pass Markdown, not a file.' };
  }
  const rel = relativeInside(runtime.readRoot, absoluteFromApp(binding, path));
  if (!rel) return { error: `${path} is not inside ${runtime.readRoot}.` };
  const rest = typeof source === 'object' ? (source as Record<string, unknown>) : {};
  const { rootId: _rootId, ...file } = rest;
  return { source: { ...file, kind: 'file', path: rel } };
}

function appDestination(
  runtime: DocblocksRuntime,
  destination: unknown,
):
  | { destination: Record<string, unknown>; saved: string; renamedFrom?: string }
  | { error: string } {
  const given =
    typeof destination === 'string'
      ? { path: destination }
      : destination && typeof destination === 'object'
        ? (destination as Record<string, unknown>)
        : null;
  const raw = typeof given?.path === 'string' ? given.path.trim() : '';
  if (!raw) return { error: 'save_artifact needs `destination: {"path": "report.docx"}`.' };
  const path = isAbsolute(raw)
    ? relativeInside(runtime.outputDir, resolve(raw))
    : raw.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
  if (!path) {
    return {
      error: `Gezel saves documents in its own folder (${runtime.outputDir}): pass a file name such as report.docx, then copy the file where it belongs.`,
    };
  }
  // Gezel's folder is a staging area the app copies out of, so a name taken
  // by an earlier save (the same deck made twice) gets a number, as a
  // download would, instead of DocBlocks refusing it. A replace needs the
  // current file's hash, which the app cannot know: Gezel reads it here.
  const target = join(runtime.outputDir, path);
  const replace = given?.ifExists === 'replace' && existsSync(target);
  const free = replace ? path : freeName(runtime.outputDir, path);
  const expectedSha256 = !replace
    ? null
    : typeof given?.expectedSha256 === 'string'
      ? given.expectedSha256
      : createHash('sha256').update(readFileSync(target)).digest('hex');
  return {
    destination: {
      rootId: runtime.writeRootId,
      path: free,
      ifExists: replace ? 'replace' : 'error',
      expectedSha256,
    },
    saved: join(runtime.outputDir, free),
    ...(free !== path ? { renamedFrom: path } : {}),
  };
}

/** `path`, or `name (2).ext` and up when that file already exists in `dir`. */
function freeName(dir: string, path: string): string {
  if (!existsSync(join(dir, path))) return path;
  const slash = path.lastIndexOf('/');
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${path.slice(0, slash + 1)}${stem} (${n})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

/** Register DocBlocks' document tools on the harness server. */
export function registerHarnessDocumentTools(server: McpServer, session: HarnessSession): void {
  const runtimes = new Map<string, Promise<DocblocksRuntime>>();
  session.onClose(async () => {
    const all = [...runtimes.values()];
    runtimes.clear();
    await Promise.all(all.map((p) => p.then((r) => r.close()).catch(() => {})));
  });
  const runtimeFor = (binding: HarnessBinding): Promise<DocblocksRuntime> => {
    let runtime = runtimes.get(binding.key);
    if (!runtime) {
      runtime = DocblocksRuntime.start(binding);
      runtimes.set(binding.key, runtime);
      runtime.catch(() => runtimes.delete(binding.key));
    }
    return runtime;
  };

  for (const name of HARNESS_DOCUMENT_TOOL_NAMES) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) continue;
    const inputSchema =
      name === 'save_artifact' ? appSaveSchema(tool.inputSchema) : tool.inputSchema;
    server.registerTool(
      name,
      {
        description: `${tool.description} ${HARNESS_DOCUMENT_TOOL_NOTES[name]}`,
        inputSchema: listedAs(inputSchema),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args: Record<string, unknown>) =>
        guarded(async () => {
          // These list DocBlocks' schema but accept anything, so the server's
          // own validation never answers a call that left something out.
          if (missingArguments(inputSchema, args).length > 0) {
            return failure(argumentHelp(name, inputSchema, args));
          }
          const binding = await session.bind();
          if (!binding.info?.documents) return failure(OUTDATED);
          let runtime: DocblocksRuntime;
          try {
            runtime = await runtimeFor(binding);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return failure(
              reason === OUTDATED ? reason : `Gezel could not start its document tools: ${reason}`,
            );
          }
          const forwarded: Record<string, unknown> = { ...args };
          for (const key of SOURCE_ARGS[name] ?? []) {
            if (forwarded[key] === undefined) continue;
            const mapped = appSource(binding, runtime, forwarded[key]);
            if ('error' in mapped) return failure(mapped.error);
            forwarded[key] = mapped.source;
          }
          let saved: string | null = null;
          let renamedFrom: string | undefined;
          if (name === 'save_artifact') {
            const mapped = appDestination(runtime, forwarded.destination);
            if ('error' in mapped) return failure(mapped.error);
            forwarded.destination = mapped.destination;
            saved = mapped.saved;
            renamedFrom = mapped.renamedFrom;
            await mkdir(dirname(saved), { recursive: true });
          }
          // Without the structured copy: Claude Code shows a result's
          // structuredContent instead of its content, which hid the note below
          // (trial t2: Sonnet 5.5 saved a deck, then searched the disk for it).
          const { structuredContent, ...result } = await runtime.call(name, forwarded);
          const failed =
            result.isError === true || (structuredContent as { kind?: unknown })?.kind === 'error';
          if (failed) result.isError = true;
          if (saved && !failed) {
            const renamed = renamedFrom
              ? `Gezel's folder already had a ${renamedFrom}, so this one is named ${basename(saved)}. `
              : '';
            result.content = [
              ...result.content,
              {
                type: 'text',
                text: `${renamed}Saved to ${saved}. Copy it into the folder with your own file tools if it belongs there.`,
              },
            ];
          }
          return result;
        }),
    );
  }
}
