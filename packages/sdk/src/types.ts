/**
 * Descriptor types mirroring `packages/core/src/schemas/script.ts`. We
 * intentionally duplicate the shapes here (rather than taking a runtime
 * dep on `@bendyline/gezel`) so the SDK stays tiny and vendor-friendly —
 * scripts can import this package without pulling in all of core.
 */

/**
 * A permission a script must declare in `meta.requires` before it may
 * use the corresponding {@link import('./index.js').GezelSDK | `gezel`}
 * namespace. The runtime denies any call whose capability is absent from
 * the list (`CAPABILITY_DENIED`). The mapping is:
 *
 * - `llm` → `gezel.llm.oneShot`
 * - `network` → `gezel.mcp.call`, `gezel.http.authed`
 * - `workspace.read` / `workspace.write` → `gezel.fs.*`
 * - `artifacts.read` / `artifacts.write` → `gezel.artifacts.*`
 * - `documents.read` / `documents.write` → `gezel.documents.*`
 * - `tasks.read` / `tasks.write` → `gezel.task.*`
 * - `memory.read` / `memory.write` → `gezel.memory.*`
 *
 * `gezel.http.authed` additionally needs a `credential:<name>` entry
 * (declared as a raw string in `requires`) naming each credential it uses.
 */
export type ScriptCapability =
  | 'llm'
  | 'network'
  | 'workspace.read'
  | 'workspace.write'
  | 'artifacts.read'
  | 'artifacts.write'
  | 'documents.read'
  | 'documents.write'
  | 'tasks.read'
  | 'tasks.write'
  | 'memory.read'
  | 'memory.write'
  | 'index.read'
  | 'index.refresh';

/** A free-text string input field. */
export interface ScriptStringInput {
  type: 'string';
  /** Human-readable label/help shown in the input form. */
  description: string;
  /** When `true`, the value must be supplied. Defaults to `false`. */
  required?: boolean;
  /** Default value used when none is supplied. */
  default?: string;
  /** Optional regular-expression source the value must match. */
  pattern?: string;
  /** Render a multi-line text area instead of a single-line field. */
  multiline?: boolean;
}

/** A numeric input field. */
export interface ScriptNumberInput {
  type: 'number';
  /** Human-readable label/help shown in the input form. */
  description: string;
  /** When `true`, the value must be supplied. Defaults to `false`. */
  required?: boolean;
  /** Default value used when none is supplied. */
  default?: number;
  /** Inclusive minimum accepted value. */
  min?: number;
  /** Inclusive maximum accepted value. */
  max?: number;
  /** Require a whole number (reject fractional values). */
  integer?: boolean;
}

/** A boolean (checkbox) input field. */
export interface ScriptBooleanInput {
  type: 'boolean';
  /** Human-readable label/help shown in the input form. */
  description: string;
  /** When `true`, the value must be supplied. Defaults to `false`. */
  required?: boolean;
  /** Default value used when none is supplied. */
  default?: boolean;
}

/** One selectable option in a {@link ScriptChoiceInput}. */
export interface ScriptChoiceOption {
  /** The value stored/passed when this option is selected. */
  value: string;
  /** Optional display label; falls back to `value` when omitted. */
  label?: string;
}

/**
 * A single-select input constrained to a fixed list of options. Declare
 * `options` `as const` to get literal-typed inference on the resolved
 * input value.
 */
export interface ScriptChoiceInput<
  O extends readonly ScriptChoiceOption[] = readonly ScriptChoiceOption[],
> {
  type: 'choice';
  /** Human-readable label/help shown in the input form. */
  description: string;
  /** When `true`, the value must be supplied. Defaults to `false`. */
  required?: boolean;
  /** Default selected `value`; must be one of `options`. */
  default?: string;
  /** The allowed options. */
  options: O;
}

/**
 * A reference picker — selects an existing entity by id. The resolved
 * input value is the referenced entity's id (a string).
 */
export interface ScriptRefInput {
  type: 'ref';
  /** Human-readable label/help shown in the input form. */
  description: string;
  /** When `true`, the value must be supplied. Defaults to `false`. */
  required?: boolean;
  /** Which kind of entity may be referenced. */
  kind: 'gezel' | 'task' | 'artifact' | 'document';
}

/** A free-form JSON input field, optionally validated against a schema. */
export interface ScriptJsonInput {
  type: 'json';
  /** Human-readable label/help shown in the input form. */
  description: string;
  /** When `true`, the value must be supplied. Defaults to `false`. */
  required?: boolean;
  /** Default value used when none is supplied. */
  default?: unknown;
  /** Optional JSON Schema the supplied value is validated against. */
  schema?: unknown;
}

/** Any input field descriptor; discriminated by its `type`. */
export type ScriptInputField =
  | ScriptStringInput
  | ScriptNumberInput
  | ScriptBooleanInput
  | ScriptChoiceInput
  | ScriptRefInput
  | ScriptJsonInput;

/** A script's input descriptors, keyed by input name (`meta.inputs`). */
export type ScriptInputs = Record<string, ScriptInputField>;

/** A string field of the script's output. */
export interface ScriptStringOutput {
  type: 'string';
  /** Human-readable description of this output field. */
  description: string;
  /** Allow `null` as a value for this field. */
  nullable?: boolean;
}
/** A numeric field of the script's output. */
export interface ScriptNumberOutput {
  type: 'number';
  /** Human-readable description of this output field. */
  description: string;
  /** Allow `null` as a value for this field. */
  nullable?: boolean;
}
/** A boolean field of the script's output. */
export interface ScriptBooleanOutput {
  type: 'boolean';
  /** Human-readable description of this output field. */
  description: string;
  /** Allow `null` as a value for this field. */
  nullable?: boolean;
}
/** An array field of the script's output. */
export interface ScriptArrayOutput {
  type: 'array';
  /** Human-readable description of this output field. */
  description: string;
  /** The type of each element in the array. */
  itemType: 'string' | 'number' | 'boolean' | 'object';
}
/** An object field of the script's output. */
export interface ScriptObjectOutput {
  type: 'object';
  /** Human-readable description of this output field. */
  description: string;
  /** Optional JSON Schema describing the object's shape. */
  schema?: unknown;
}
/** A free-form JSON field of the script's output. */
export interface ScriptJsonOutput {
  type: 'json';
  /** Human-readable description of this output field. */
  description: string;
  /** Optional JSON Schema the value conforms to. */
  schema?: unknown;
}

/** Any output field descriptor; discriminated by its `type`. */
export type ScriptOutputField =
  | ScriptStringOutput
  | ScriptNumberOutput
  | ScriptBooleanOutput
  | ScriptArrayOutput
  | ScriptObjectOutput
  | ScriptJsonOutput;

/** A script's output descriptors, keyed by field name (`meta.outputs`). */
export type ScriptOutputs = Record<string, ScriptOutputField>;

/**
 * The metadata block every script exports (conventionally via
 * {@link import('./index.js').defineScript | `defineScript`}). It names
 * the script, declares its typed inputs/outputs, and lists the
 * capabilities the runtime must grant. The input/output descriptors also
 * drive type inference for `gezel.input` and the `gezel.output(...)`
 * payload (see {@link InferInput} / {@link InferOutput}).
 *
 * @typeParam I - The `inputs` descriptor map (or `undefined`).
 * @typeParam O - The `outputs` descriptor map (or `undefined`).
 */
export interface ScriptMeta<
  I extends ScriptInputs | undefined = ScriptInputs | undefined,
  O extends ScriptOutputs | undefined = ScriptOutputs | undefined,
> {
  /** Unique script name, used to invoke it (including from `gezel.script.run`). */
  name: string;
  /** One-line description of what the script does. */
  description: string;
  /**
   * What the script is for. `gate` = it is meant to be attached to a
   * craftbook step's gate and stamps a {@link GateScriptResult} via
   * `gezel.output(...)`. Absent = 'action'.
   */
  kind?: 'action' | 'gate';
  /** Typed input descriptors; surfaced on `gezel.input`. */
  inputs?: I;
  /** Typed output descriptors; describe the `gezel.output(...)` payload. */
  outputs?: O;
  /**
   * Capabilities this script needs. Each maps to a `gezel` namespace
   * (see {@link ScriptCapability}); the runtime denies any call whose
   * capability is missing here. For `gezel.http.authed`, also add a raw
   * `credential:<name>` string for each credential used.
   */
  requires?: ScriptCapability[];
}

/**
 * The structured verdict a GATE script stamps via `gezel.output(...)`.
 * Mirrors `GateScriptResultSchema` in @bendyline/gezel (the SDK stays
 * runtime-dependency-free, so the shape is mirrored, not imported).
 *
 *  - `approve` → the step may complete; optional `goto` overrides routing.
 *  - `reject`  → the step does NOT complete. `message` is REQUIRED and
 *    must be prescriptive — it is shown to the working LLM session
 *    verbatim as the instruction for what to fix. Optional `goto`
 *    re-activates a (usually earlier) step — this is how craftbooks loop.
 *  - `handoff` → on approve, a payload delivered to the next step.
 */
export interface GateScriptResult {
  /** `approve` lets the step complete; `reject` blocks it. */
  decision: 'approve' | 'reject';
  /**
   * On `reject`, **required** and prescriptive — shown verbatim to the
   * working LLM session as the instruction for what to fix. On
   * `approve`, an optional note.
   */
  message?: string;
  /**
   * Name of a step to route to. On `reject`, re-activates a (usually
   * earlier) step — this is how craftbooks loop. On `approve`, overrides
   * the default next step.
   */
  goto?: string;
  /** On `approve`, a payload delivered to the next step. */
  handoff?: { message: string; params?: Record<string, unknown> };
}

/* ─────────────────────── Type inference for gezel.input ─────────────────── */

type ResolvedInputValue<F> = F extends ScriptStringInput
  ? string
  : F extends ScriptNumberInput
    ? number
    : F extends ScriptBooleanInput
      ? boolean
      : F extends ScriptChoiceInput<infer O>
        ? O[number]['value']
        : F extends ScriptRefInput
          ? string
          : F extends ScriptJsonInput
            ? unknown
            : never;

type IsAlwaysPresent<F> = F extends { required: true }
  ? true
  : F extends { default: unknown }
    ? true
    : false;

type RequiredKeys<I> = {
  [K in keyof I]: IsAlwaysPresent<I[K]> extends true ? K : never;
}[keyof I];

type OptionalKeys<I> = {
  [K in keyof I]: IsAlwaysPresent<I[K]> extends true ? never : K;
}[keyof I];

/**
 * Derive the concrete `gezel.input` type from a `meta.inputs` descriptor
 * map: each field becomes its resolved value type, and fields that are
 * `required` or have a `default` become non-optional. Prefer the
 * {@link import('./index.js').InferredInput | `InferredInput<typeof meta>`}
 * alias in scripts.
 *
 * @typeParam I - The `meta.inputs` descriptor map.
 */
export type InferInput<I extends ScriptInputs | undefined> = I extends ScriptInputs
  ? { [K in RequiredKeys<I>]: ResolvedInputValue<I[K]> } & {
      [K in OptionalKeys<I>]?: ResolvedInputValue<I[K]>;
    }
  : Record<string, unknown>;

/* ───────────────────── Type inference for gezel.output ──────────────────── */

type ResolvedOutputValue<F> = F extends ScriptStringOutput
  ? string | (F extends { nullable: true } ? null : never)
  : F extends ScriptNumberOutput
    ? number | (F extends { nullable: true } ? null : never)
    : F extends ScriptBooleanOutput
      ? boolean | (F extends { nullable: true } ? null : never)
      : F extends ScriptArrayOutput
        ? unknown[]
        : F extends ScriptObjectOutput
          ? Record<string, unknown>
          : F extends ScriptJsonOutput
            ? unknown
            : never;

/**
 * Derive the concrete `gezel.output(...)` payload type from a
 * `meta.outputs` descriptor map: each field becomes its resolved value
 * type (with `null` added when `nullable` is set). Prefer the
 * {@link import('./index.js').InferredOutput | `InferredOutput<typeof meta>`}
 * alias in scripts.
 *
 * @typeParam O - The `meta.outputs` descriptor map.
 */
export type InferOutput<O extends ScriptOutputs | undefined> = O extends ScriptOutputs
  ? { [K in keyof O]: ResolvedOutputValue<O[K]> }
  : unknown;
