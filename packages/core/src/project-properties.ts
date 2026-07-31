/**
 * Well-known project properties — shared per-project configuration values
 * stored in `project.properties` (see `ProjectSchema`). A property is a
 * plain string keyed by a dotted id. Craftbook params bridge to them via
 * a `projectProperty: '<id>'` annotation on a `paramSchema` property: the
 * enable form prefills the param from the project property and writes the
 * submitted value back, so the next book (or the same book next night)
 * shares it.
 *
 * The registry below improves display (labels, suggestions) — it does NOT
 * gate: unknown ids are legal and render with the raw id as the label.
 * Add entries here when a second consumer appears for a value; a
 * craftbook-private knob should stay a plain param.
 */

export type ProjectPropertyKind = 'string' | 'enum';

export interface ProjectPropertyDefinition {
  /** Dotted id, e.g. `content.language`. Stable — persisted in project.json. */
  id: string;
  label: string;
  description: string;
  kind: ProjectPropertyKind;
  /** For `enum`: the allowed values. For `string`: optional quick-pick suggestions. */
  options?: string[];
}

export const PROJECT_PROPERTY_DEFINITIONS: ProjectPropertyDefinition[] = [
  {
    id: 'content.language',
    label: 'Designated language',
    description:
      'The language this project’s content targets — e.g. what a translator gezel translates into. Free text; a language name or BCP-47 tag both work.',
    kind: 'string',
    options: ['Nederlands', 'English', 'Deutsch', 'Français', 'Español', '日本語'],
  },
  {
    id: 'content.audience',
    label: 'Target audience',
    description:
      'Who the project’s output is for — tone and reading-level guidance for writing and review craftbooks.',
    kind: 'string',
  },
];

export function projectPropertyDefinition(id: string): ProjectPropertyDefinition | undefined {
  return PROJECT_PROPERTY_DEFINITIONS.find((d) => d.id === id);
}

/**
 * The `paramSchema` property annotation linking a craftbook param to a
 * project property. Sits beside `type`/`description`/`squisq` inside a
 * JSON-Schema property object:
 *
 *   "language": { "type": "string", "projectProperty": "content.language" }
 */
export const PARAM_PROJECT_PROPERTY_KEY = 'projectProperty';

/** Read the annotation off one paramSchema property object, if present. */
export function paramProjectProperty(paramSchemaProperty: unknown): string | undefined {
  if (typeof paramSchemaProperty !== 'object' || paramSchemaProperty === null) return undefined;
  const value = (paramSchemaProperty as Record<string, unknown>)[PARAM_PROJECT_PROPERTY_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
