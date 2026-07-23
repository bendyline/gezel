import type { MetaFormValue } from '@bendyline/gezel';
import type { SquisqAnnotatedSchema } from '@bendyline/squisq';
import { useMemo } from 'react';
import { GezelJsonEditor } from '../GezelJsonEditor.js';

/**
 * The Properties tab of the script editor: a squisq `JsonEditor` over the
 * script's meta block, modeled as a single value object (see
 * `MetaFormValue` in core's `source-split`). The parent (`ScriptEditorTabs`)
 * converts the form value to/from `ScriptMeta` and serializes it into the
 * `export const meta = defineScript({...})` statement.
 *
 * inputs/outputs are arrays of descriptors discriminated by `type` — squisq
 * renders each as a `card-stack` whose item schema is a `oneOf` over the field
 * types, so the user picks "string / number / choice / …" per field and only
 * that type's options show.
 */
export function ScriptMetaForm({
  value,
  onChange,
  readOnly,
  issues,
}: {
  value: MetaFormValue;
  onChange: (next: MetaFormValue) => void;
  readOnly?: boolean;
  issues?: string[];
}) {
  const schema = useMemo(() => buildScriptMetaSchema(), []);

  return (
    <div className="script-meta-form">
      <GezelJsonEditor
        schema={schema}
        value={value}
        onChange={readOnly ? undefined : (next) => onChange((next ?? {}) as MetaFormValue)}
        density="compact"
      />
      {issues && issues.length > 0 && (
        <ul className="script-meta-form__issues small">
          {issues.map((m, i) => (
            <li key={`${i}:${m}`} className="error">
              {m}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ──────────────────────────── squisq schema ─────────────────────────────── */

const NAME_PROP: SquisqAnnotatedSchema = {
  type: 'string',
  title: 'Name',
  pattern: '^[a-zA-Z][\\w-]*$',
  squisq: { width: 'half', help: 'Becomes a key on the input/output object.' },
};
const DESC_PROP: SquisqAnnotatedSchema = {
  type: 'string',
  title: 'Description',
  squisq: { control: 'multiline', help: 'What it is, for teammates and the test-run form.' },
};
const REQUIRED_PROP: SquisqAnnotatedSchema = { type: 'boolean', title: 'Required' };
const JSON_TEXT: SquisqAnnotatedSchema = {
  type: 'string',
  squisq: { control: 'multiline', help: 'JSON (parsed on save).' },
};

/** One `oneOf` branch for an input type: shared props + the type-specific ones. */
function inputBranch(
  type: string,
  title: string,
  extra: Record<string, SquisqAnnotatedSchema>,
): SquisqAnnotatedSchema {
  return {
    type: 'object',
    title,
    required: ['name', 'type', 'description'],
    properties: {
      name: NAME_PROP,
      type: { type: 'string', const: type, title: 'Type', squisq: { width: 'half' } },
      description: DESC_PROP,
      required: REQUIRED_PROP,
      ...extra,
    },
  };
}

function outputBranch(
  type: string,
  title: string,
  extra: Record<string, SquisqAnnotatedSchema>,
): SquisqAnnotatedSchema {
  return {
    type: 'object',
    title,
    required: ['name', 'type', 'description'],
    properties: {
      name: NAME_PROP,
      type: { type: 'string', const: type, title: 'Type', squisq: { width: 'half' } },
      description: DESC_PROP,
      ...extra,
    },
  };
}

export function buildScriptMetaSchema(): SquisqAnnotatedSchema {
  return {
    type: 'object',
    required: ['name', 'description'],
    properties: {
      name: {
        type: 'string',
        title: 'Script name',
        pattern: '^[a-zA-Z][\\w-]*$',
        squisq: { width: 'half', help: 'Letters, digits, _ or -; must start with a letter.' },
      },
      description: {
        type: 'string',
        title: 'Description',
        minLength: 10,
        squisq: { control: 'multiline', help: 'At least 10 characters.' },
      },
      kind: {
        type: 'string',
        title: 'Kind',
        enum: ['action', 'gate'],
        default: 'action',
        squisq: {
          control: 'segmented',
          width: 'half',
          enumLabels: { action: 'Action', gate: 'Gate' },
          help: 'Gate scripts return a decision for a step gate.',
        },
      },
      inputs: {
        type: 'array',
        title: 'Inputs',
        squisq: { control: 'card-stack', addLabel: 'Add input', itemLabel: { fromField: 'name' } },
        items: {
          type: 'object',
          required: ['name', 'type', 'description'],
          oneOf: [
            inputBranch('string', 'Text', {
              default: { type: 'string', title: 'Default' },
              pattern: { type: 'string', title: 'Pattern (regex)' },
              multiline: { type: 'boolean', title: 'Multiline' },
            }),
            inputBranch('number', 'Number', {
              default: { type: 'number', title: 'Default' },
              min: { type: 'number', title: 'Min', squisq: { width: 'third' } },
              max: { type: 'number', title: 'Max', squisq: { width: 'third' } },
              integer: { type: 'boolean', title: 'Integer only', squisq: { width: 'third' } },
            }),
            inputBranch('boolean', 'Boolean', {
              default: { type: 'boolean', title: 'Default' },
            }),
            inputBranch('choice', 'Choice', {
              default: { type: 'string', title: 'Default' },
              options: {
                type: 'array',
                title: 'Options',
                minItems: 1,
                squisq: {
                  control: 'card-stack',
                  addLabel: 'Add option',
                  itemLabel: { fromField: 'value' },
                },
                items: {
                  type: 'object',
                  required: ['value'],
                  properties: {
                    value: { type: 'string', title: 'Value', squisq: { width: 'half' } },
                    label: { type: 'string', title: 'Label', squisq: { width: 'half' } },
                  },
                },
              },
            }),
            inputBranch('ref', 'Reference', {
              kind: {
                type: 'string',
                title: 'Refers to',
                enum: ['gezel', 'task', 'artifact', 'document'],
                squisq: { control: 'segmented' },
              },
            }),
            inputBranch('json', 'JSON', {
              defaultJson: { ...JSON_TEXT, title: 'Default (JSON)' },
              schemaJson: { ...JSON_TEXT, title: 'Schema (JSON)' },
            }),
          ],
        },
      },
      outputs: {
        type: 'array',
        title: 'Outputs',
        squisq: { control: 'card-stack', addLabel: 'Add output', itemLabel: { fromField: 'name' } },
        items: {
          type: 'object',
          required: ['name', 'type', 'description'],
          oneOf: [
            outputBranch('string', 'Text', { nullable: { type: 'boolean', title: 'Nullable' } }),
            outputBranch('number', 'Number', { nullable: { type: 'boolean', title: 'Nullable' } }),
            outputBranch('boolean', 'Boolean', {
              nullable: { type: 'boolean', title: 'Nullable' },
            }),
            outputBranch('array', 'Array', {
              itemType: {
                type: 'string',
                title: 'Item type',
                enum: ['string', 'number', 'boolean', 'object'],
                squisq: { control: 'segmented' },
              },
            }),
            outputBranch('object', 'Object', {
              schemaJson: { ...JSON_TEXT, title: 'Schema (JSON)' },
            }),
            outputBranch('json', 'JSON', { schemaJson: { ...JSON_TEXT, title: 'Schema (JSON)' } }),
          ],
        },
      },
      requires: {
        type: 'array',
        title: 'Allowed to (capabilities)',
        squisq: {
          control: 'chip-bin',
          addLabel: 'Add capability',
          help: 'e.g. network, llm, tasks.write, credential:github.token',
        },
        items: { type: 'string' },
      },
    },
  };
}
