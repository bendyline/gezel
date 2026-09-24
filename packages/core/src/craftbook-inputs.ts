import type { Craftbook } from './schemas/craftbook.js';
import {
  type CraftbookParamInput,
  CraftbookParamInputSchema,
  type TaskInputRecord,
  type TaskInputSource,
} from './schemas/task-inputs.js';
import { isSyncJunkName } from './sync-junk.js';

/**
 * Craftbook inputs: which params name the files a run works on, how a plain
 * string value maps to a source, and the limits every surface enforces. The
 * UI, the service, the CLI, and the MCP server all read inputs through here
 * so they cannot disagree about what a book asked for.
 */

/** The `paramSchema` property annotation that marks a param as an input. */
export const PARAM_INPUT_KEY = 'input';

export const INPUT_DEFAULT_MAX_FILES = 1_000;
export const INPUT_HARD_MAX_FILES = 5_000;
export const INPUT_DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
export const INPUT_HARD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const INPUT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** String-param prefix that names an artifacts-drawer source. */
export const ARTIFACTS_INPUT_PREFIX = 'artifacts:';

/** Extensions `read_doc_as_markdown` converts. Mirrors the service's converter. */
const OFFICE_DOCUMENT_EXTENSIONS = new Set(['.docx', '.pdf', '.pptx', '.xlsx']);

export interface CraftbookInputParam {
  key: string;
  title: string;
  description?: string;
  required: boolean;
  spec: CraftbookParamInput;
}

export interface InputLimits {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
}

/** Read and validate the `input` annotation off one paramSchema property. */
export function paramInputSpec(paramSchemaProperty: unknown): CraftbookParamInput | undefined {
  if (typeof paramSchemaProperty !== 'object' || paramSchemaProperty === null) return undefined;
  const raw = (paramSchemaProperty as Record<string, unknown>)[PARAM_INPUT_KEY];
  if (raw === undefined) return undefined;
  const parsed = CraftbookParamInputSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const accept = parsed.data.accept?.map((ext) => ext.toLowerCase());
  return { ...parsed.data, ...(accept ? { accept } : {}) };
}

function schemaProperties(paramSchema: Craftbook['paramSchema']): Record<string, unknown> {
  const properties = paramSchema?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : {};
}

function schemaRequired(paramSchema: Craftbook['paramSchema']): string[] {
  const required = paramSchema?.required;
  return Array.isArray(required)
    ? required.filter((key): key is string => typeof key === 'string')
    : [];
}

/** Every input param a craftbook declares, in declaration order. */
export function craftbookInputParams(paramSchema: Craftbook['paramSchema']): CraftbookInputParam[] {
  const required = new Set(schemaRequired(paramSchema));
  const out: CraftbookInputParam[] = [];
  for (const [key, property] of Object.entries(schemaProperties(paramSchema))) {
    const spec = paramInputSpec(property);
    if (!spec) continue;
    const prop = property as { title?: unknown; description?: unknown };
    out.push({
      key,
      title: typeof prop.title === 'string' && prop.title.trim() ? prop.title : key,
      ...(typeof prop.description === 'string' && prop.description.trim()
        ? { description: prop.description }
        : {}),
      required: required.has(key),
      spec,
    });
  }
  return out;
}

/**
 * The paramSchema with its input params removed — what a generic form
 * renders once the launcher has taken the inputs out to render its own
 * source picker. `required` is filtered to match, so the form does not
 * demand a field it no longer shows.
 */
export function withoutInputParams(
  paramSchema: Craftbook['paramSchema'],
): Craftbook['paramSchema'] {
  if (!paramSchema) return paramSchema;
  const properties = schemaProperties(paramSchema);
  const inputKeys = new Set(
    Object.entries(properties)
      .filter(([, property]) => paramInputSpec(property))
      .map(([key]) => key),
  );
  if (inputKeys.size === 0) return paramSchema;
  const next: Record<string, unknown> = {
    ...paramSchema,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([key]) => !inputKeys.has(key)),
    ),
  };
  if (Array.isArray(paramSchema.required)) {
    next.required = schemaRequired(paramSchema).filter((key) => !inputKeys.has(key));
  }
  return next;
}

/** The book's limits clamped to the runtime ceilings. */
export function effectiveInputLimits(spec: CraftbookParamInput): InputLimits {
  const maxFiles =
    spec.kind === 'file'
      ? 1
      : Math.min(spec.maxFiles ?? INPUT_DEFAULT_MAX_FILES, INPUT_HARD_MAX_FILES);
  const maxBytes = Math.min(spec.maxBytes ?? INPUT_DEFAULT_MAX_BYTES, INPUT_HARD_MAX_BYTES);
  return { maxFiles, maxBytes, maxFileBytes: Math.min(INPUT_MAX_FILE_BYTES, maxBytes) };
}

/** Forward-slashed, no leading `./` or `/`, no trailing `/`. `''` is the root. */
export function normalizeInputPath(path: string): string {
  return path
    .trim()
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/^\.$/, '');
}

/**
 * A plain string param value as an input source — the path every launch
 * surface without a picker (MCP, CLI, terminal, evals) takes. Empty → none.
 */
export function inputSourceFromParamValue(value: string | undefined): TaskInputSource | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith(ARTIFACTS_INPUT_PREFIX)) {
    const path = normalizeInputPath(trimmed.slice(ARTIFACTS_INPUT_PREFIX.length));
    return path ? { from: 'artifacts', path } : null;
  }
  return { from: 'workspace', path: normalizeInputPath(trimmed) };
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** True when the book's `accept` list admits this file. */
export function inputAccepts(spec: CraftbookParamInput, path: string): boolean {
  if (!spec.accept) return true;
  return spec.accept.includes(extensionOf(path));
}

/** Names never worth handing a gezel: sync/OS junk and dotfiles. */
export function isInputJunkName(name: string): boolean {
  return name.startsWith('.') || isSyncJunkName(name);
}

export function isOfficeDocumentPath(path: string): boolean {
  return OFFICE_DOCUMENT_EXTENSIONS.has(extensionOf(path));
}

/**
 * The tools that open an input where it lives. A step whose task has inputs
 * keeps these through every narrowing short of the book's own step policy —
 * an input nobody can read is the same failure as a missing input.
 */
export function taskInputReadTools(
  input: Pick<TaskInputRecord, 'drawer' | 'kind' | 'hasOfficeDocuments'>,
): string[] {
  const artifacts = input.drawer === 'artifacts';
  return [
    ...(input.kind === 'folder' ? [artifacts ? 'list_artifacts' : 'list_dir'] : []),
    artifacts ? 'read_artifact' : 'read_file',
    ...(input.hasOfficeDocuments ? ['read_doc_as_markdown'] : []),
  ];
}

/** Artifacts-relative folder an uploaded input is adopted into. */
export function taskInputArtifactDir(taskDir: string, param: string): string {
  return `${taskDir}/inputs/${param}`;
}

/** Artifacts-relative manifest path for one input. */
export function taskInputManifestPath(taskDir: string, param: string): string {
  return `${taskDir}/inputs/${param}.json`;
}

/**
 * True for artifacts-relative paths at or under a task's `inputs/` folder.
 * Gezel-only write denial: a run must not "fix" its own source to satisfy a
 * gate, but the user may still edit what they supplied.
 */
export function isTaskInputArtifactPath(path: string): boolean {
  const segments = normalizeInputPath(path)
    .split('/')
    .filter((s) => s.length > 0);
  return (
    segments.length >= 3 &&
    segments[0]?.toLowerCase() === 'tasks' &&
    segments[2]?.toLowerCase() === 'inputs'
  );
}

/**
 * True when moving or deleting `path` would carry a task's inputs with it:
 * the inputs folder, anything inside it, or the `tasks/<num>` folder that
 * holds it. Writes and mkdirs use {@link isTaskInputArtifactPath} instead —
 * creating the task folder is harmless.
 */
export function touchesTaskInputArtifactPath(path: string): boolean {
  const segments = normalizeInputPath(path)
    .split('/')
    .filter((s) => s.length > 0);
  if (segments[0]?.toLowerCase() !== 'tasks') return false;
  return segments.length <= 2 || segments[2]?.toLowerCase() === 'inputs';
}

/** Human-readable byte count for prompts and UI summaries. */
export function formatInputBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "37 files (2.1 MB)" / "1 file (40 KB)". */
export function describeInputSize(
  record: Pick<TaskInputRecord, 'fileCount' | 'totalBytes'>,
): string {
  const files = `${record.fileCount} file${record.fileCount === 1 ? '' : 's'}`;
  return `${files} (${formatInputBytes(record.totalBytes)})`;
}
