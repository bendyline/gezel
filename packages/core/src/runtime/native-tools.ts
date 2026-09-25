import type { MobileNativeToolSchema } from '../mobile/inference.js';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const JSON_TEXT = 'A JSON object, written as text.';

function described<T extends MobileNativeToolSchema>(node: T, schema: Json, keep: boolean): T {
  const text = typeof schema.description === 'string' ? schema.description.trim() : '';
  if (node.kind === 'json')
    return {
      ...node,
      description: keep && text ? `${text.slice(0, 480)} ${JSON_TEXT}` : JSON_TEXT,
    };
  return keep && text ? { ...node, description: text.slice(0, 500) } : node;
}

function stringChoices(schema: Json): string[] | undefined {
  if (typeof schema.const === 'string') return [schema.const];
  const values = schema.enum;
  return Array.isArray(values) && values.length && values.every((v) => typeof v === 'string')
    ? (values as string[])
    : undefined;
}

function convert(raw: unknown, keep: boolean): { node: MobileNativeToolSchema; nullable: boolean } {
  const schema = isObject(raw) ? raw : {};
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf;
  if (Array.isArray(union)) {
    const variants = union.filter(isObject);
    const present = variants.filter((variant) => variant.type !== 'null');
    const nullable = present.length < variants.length;
    const strings = present.map(stringChoices);
    if (present.length && strings.every(Boolean))
      return {
        node: described(
          { kind: 'string', choices: [...new Set(strings.flat() as string[])] },
          schema,
          keep,
        ),
        nullable,
      };
    const choices = present.map((variant) => convert(variant, keep).node);
    if (choices.length === 1) return { node: described(choices[0]!, schema, keep), nullable };
    return {
      node: described(choices.length ? { kind: 'anyOf', choices } : { kind: 'json' }, schema, keep),
      nullable,
    };
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes('null');
  const type = types.find((value) => value !== 'null');
  const choices = stringChoices(schema);
  if (choices) return { node: described({ kind: 'string', choices }, schema, keep), nullable };
  if (type === 'string' || type === 'integer' || type === 'number' || type === 'boolean')
    return { node: described({ kind: type }, schema, keep), nullable };
  if (type === 'array') {
    const node: MobileNativeToolSchema = { kind: 'array', items: convert(schema.items, keep).node };
    if (Number.isInteger(schema.minItems)) node.minItems = schema.minItems as number;
    if (Number.isInteger(schema.maxItems)) node.maxItems = schema.maxItems as number;
    return { node: described(node, schema, keep), nullable };
  }
  const properties = isObject(schema.properties) ? Object.entries(schema.properties) : [];
  // An object with no declared keys is either an empty argument list or an
  // open map; only the explicitly closed one keeps a structured shape.
  if (
    (type === 'object' || properties.length) &&
    (properties.length || schema.additionalProperties === false)
  ) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return {
      node: described(
        {
          kind: 'object',
          properties: properties.map(([name, value]) => {
            const property = convert(value, keep);
            return {
              name,
              optional: !required.has(name) || property.nullable,
              schema: property.node,
            };
          }),
        },
        schema,
        keep,
      ),
      nullable,
    };
  }
  return { node: described({ kind: 'json' }, schema, keep), nullable };
}

/**
 * Tool parameters (JSON Schema, as the portable inventory publishes them) in
 * the ordered shape native tool-calling APIs are built from. `keepDescriptions`
 * false drops every description except the JSON-text hint a `json` value needs.
 */
export function nativeToolParameters(
  schema: unknown,
  keepDescriptions = true,
): MobileNativeToolSchema & { kind: 'object' } {
  const { node } = convert(schema, keepDescriptions);
  return node.kind === 'object' ? node : { kind: 'object', properties: [] };
}

/** Restores the values a native decoder could only produce as JSON text. */
export function decodeNativeToolArguments(schema: MobileNativeToolSchema, value: unknown): unknown {
  switch (schema.kind) {
    case 'json':
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    case 'object': {
      if (!isObject(value)) return value;
      const decoded: Json = { ...value };
      for (const property of schema.properties)
        if (Object.hasOwn(decoded, property.name))
          decoded[property.name] = decodeNativeToolArguments(
            property.schema,
            decoded[property.name],
          );
      return decoded;
    }
    case 'array':
      return Array.isArray(value)
        ? value.map((item) => decodeNativeToolArguments(schema.items, item))
        : value;
    case 'anyOf': {
      const object = isObject(value) && schema.choices.find((choice) => choice.kind === 'object');
      return object ? decodeNativeToolArguments(object, value) : value;
    }
    default:
      return value;
  }
}
