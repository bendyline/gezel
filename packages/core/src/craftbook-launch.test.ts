import { describe, expect, it } from 'vitest';
import {
  MIN_TASK_DESCRIPTION_LENGTH,
  composeCraftbookLaunch,
  composeCraftbookTaskDescription,
  craftbookReferenceSubject,
  fillMainContentParam,
  isRuntimeTemplateDefault,
  launchFormParamSchema,
  mainContentParamKey,
  paramAlternatives,
  paramAsksUser,
  paramFormSchema,
  stringifyCraftbookParamValues,
  unmetParamAlternatives,
  withoutUnaskedParams,
} from './craftbook-launch.js';

const deckSchema = {
  type: 'object',
  properties: {
    sourcePath: { type: 'string' },
    topic: { type: 'string' },
    content: { type: 'string' },
    audience: { type: 'string' },
  },
};

describe('mainContentParamKey', () => {
  it('names topic by convention and nothing else', () => {
    expect(mainContentParamKey(deckSchema)).toBe('topic');
    expect(mainContentParamKey({ properties: { content: { type: 'string' } } })).toBeNull();
    expect(mainContentParamKey({ properties: { workPath: { type: 'string' } } })).toBeNull();
    expect(mainContentParamKey(undefined)).toBeNull();
  });

  it('prefers the fromMessage annotation over the topic convention', () => {
    expect(
      mainContentParamKey({
        properties: {
          topic: { type: 'string' },
          brief: { type: 'string', fromMessage: true },
        },
      }),
    ).toBe('brief');
    expect(
      fillMainContentParam({
        paramSchema: { properties: { brief: { type: 'string', fromMessage: true } } },
        message: 'Compile the field notes',
      }),
    ).toEqual({ brief: 'Compile the field notes' });
    expect(
      mainContentParamKey({ properties: { brief: { type: 'string', fromMessage: 'yes' } } }),
    ).toBeNull();
  });
});

describe('fillMainContentParam', () => {
  it('fills the main parameter only when no source form was supplied', () => {
    expect(
      fillMainContentParam({ paramSchema: deckSchema, message: 'A deck about Delft' }),
    ).toEqual({ topic: 'A deck about Delft' });
    expect(
      fillMainContentParam({
        paramSchema: deckSchema,
        params: { sourcePath: 'brief.docx' },
        message: 'A deck about Delft',
      }),
    ).toEqual({ sourcePath: 'brief.docx' });
    expect(
      fillMainContentParam({
        paramSchema: deckSchema,
        params: { topic: 'Delft' },
        message: 'A deck about Delft',
      }),
    ).toEqual({ topic: 'Delft' });
  });

  it('treats a whitespace-only supplied source as absent', () => {
    expect(
      fillMainContentParam({ paramSchema: deckSchema, params: { topic: '  ' }, message: 'Delft' }),
    ).toEqual({ topic: 'Delft' });
  });

  it('leaves a book without a main parameter untouched', () => {
    expect(
      fillMainContentParam({
        paramSchema: { properties: { workPath: { type: 'string' } } },
        params: { workPath: '.' },
        message: 'Compile the notes',
      }),
    ).toEqual({ workPath: '.' });
  });
});

describe('craftbookReferenceSubject', () => {
  it('is the main parameter when the launch brings no source of its own', () => {
    expect(
      craftbookReferenceSubject({ paramSchema: deckSchema, params: { topic: ' quiche ' } }),
    ).toBe('quiche');
  });

  it('stands down when the launch supplies its own source', () => {
    expect(
      craftbookReferenceSubject({
        paramSchema: deckSchema,
        params: { topic: 'quiche', sourcePath: 'brief.docx' },
      }),
    ).toBeNull();
    expect(
      craftbookReferenceSubject({
        paramSchema: deckSchema,
        params: { topic: 'quiche', content: 'Eggs, cream, lardons.' },
      }),
    ).toBeNull();
    expect(
      craftbookReferenceSubject({
        paramSchema: deckSchema,
        params: { topic: 'quiche' },
        inputs: { notes: { from: 'workspace', path: 'notes' } },
      }),
    ).toBeNull();
  });

  it('is null with no main parameter or an empty one', () => {
    expect(
      craftbookReferenceSubject({ paramSchema: deckSchema, params: { topic: '' } }),
    ).toBeNull();
    expect(
      craftbookReferenceSubject({
        paramSchema: { properties: { workPath: { type: 'string' } } },
        params: { workPath: '.' },
      }),
    ).toBeNull();
  });
});

describe('composeCraftbookTaskDescription', () => {
  it('keeps a long enough message verbatim', () => {
    const message = 'Please build a short deck about the history of Delft for new hires.';
    expect(composeCraftbookTaskDescription({ message, craftbookName: 'Deck' })).toBe(message);
  });

  it('pads a short message and stands in for an empty one', () => {
    const padded = composeCraftbookTaskDescription({ message: 'Delft', craftbookName: 'Deck' });
    expect(padded.startsWith('Delft\n\n')).toBe(true);
    expect(padded.length).toBeGreaterThanOrEqual(MIN_TASK_DESCRIPTION_LENGTH);
    expect(composeCraftbookTaskDescription({ craftbookName: 'Deck' })).toBe(
      'Run the "Deck" craftbook against this project.',
    );
  });
});

describe('composeCraftbookLaunch', () => {
  it('fills from the raw message so padding never reaches the parameter', () => {
    const result = composeCraftbookLaunch({
      message: 'Delft',
      craftbookName: 'Deck',
      paramSchema: deckSchema,
      params: { audience: 'new hires' },
    });
    expect(result.params).toEqual({ audience: 'new hires', topic: 'Delft' });
    expect(result.description).toContain('Run the "Deck" craftbook');
  });
});

describe('stringifyCraftbookParamValues', () => {
  it('coerces scalars and drops empties and structures', () => {
    expect(
      stringifyCraftbookParamValues({
        a: 'x',
        b: 3,
        c: true,
        d: '',
        e: null,
        f: undefined,
        g: { nested: 1 },
      }),
    ).toEqual({ a: 'x', b: '3', c: 'true' });
  });
});

describe('paramAsksUser', () => {
  it('asks for a plain parameter', () => {
    expect(paramAsksUser({ type: 'string', default: 'medium' })).toBe(true);
    expect(paramAsksUser({ type: 'string' })).toBe(true);
  });

  it('does not ask for a parameter whose default the daemon resolves', () => {
    expect(paramAsksUser({ type: 'string', default: '{{task.dir}}' })).toBe(false);
    expect(paramAsksUser({ type: 'string', default: 'pdf/task-{{ task.num }}/report.md' })).toBe(
      false,
    );
    expect(paramAsksUser({ type: 'string', default: '{{outputDir}}/deck.pptx' })).toBe(false);
  });

  it('lets the askUser annotation win either way', () => {
    expect(paramAsksUser({ type: 'string', default: '', askUser: false })).toBe(false);
    expect(paramAsksUser({ type: 'string', default: '{{task.dir}}', askUser: true })).toBe(true);
  });

  it('ignores a non-boolean annotation and malformed properties', () => {
    expect(paramAsksUser({ type: 'string', askUser: 'no' })).toBe(true);
    expect(paramAsksUser(null)).toBe(true);
    expect(paramAsksUser('string')).toBe(true);
  });
});

describe('isRuntimeTemplateDefault', () => {
  it('matches only strings carrying a template token', () => {
    expect(isRuntimeTemplateDefault('{{task.dir}}')).toBe(true);
    expect(isRuntimeTemplateDefault('reports/{{task.num}}')).toBe(true);
    expect(isRuntimeTemplateDefault('reports')).toBe(false);
    expect(isRuntimeTemplateDefault('{{ }}')).toBe(false);
    expect(isRuntimeTemplateDefault(3)).toBe(false);
    expect(isRuntimeTemplateDefault(undefined)).toBe(false);
  });
});

describe('withoutUnaskedParams', () => {
  const schema = {
    type: 'object',
    properties: {
      findingsPath: { type: 'string', default: '', askUser: false },
      focus: { type: 'string' },
      workPath: { type: 'string', default: '{{task.dir}}' },
      reviewId: { type: 'string', askUser: false },
    },
    required: ['focus', 'reviewId'],
  };

  it('removes unasked properties and filters required to match', () => {
    const next = withoutUnaskedParams(schema) as typeof schema;
    expect(Object.keys(next.properties)).toEqual(['focus']);
    expect(next.required).toEqual(['focus']);
    expect(next.type).toBe('object');
  });

  it('returns the same schema when every property is asked', () => {
    const plain = { type: 'object', properties: { topic: { type: 'string' } } };
    expect(withoutUnaskedParams(plain)).toBe(plain);
  });

  it('passes an absent schema through', () => {
    expect(withoutUnaskedParams(undefined)).toBeUndefined();
  });
});

const deckWithRule = {
  type: 'object',
  anyOf: [
    { required: ['sourcePath'], properties: { sourcePath: { type: 'string', minLength: 1 } } },
    { required: ['topic'], properties: { topic: { type: 'string', minLength: 1 } } },
    { required: ['content'], properties: { content: { type: 'string', minLength: 1 } } },
  ],
  properties: {
    workPath: { type: 'string', default: '{{task.dir}}' },
    sourcePath: { type: 'string', title: 'Source file' },
    topic: { type: 'string', title: 'Topic' },
    content: { type: 'string', title: 'Source material' },
    audience: { type: 'string', title: 'Audience', default: 'general audience' },
  },
};

describe('paramFormSchema', () => {
  it('drops the top-level alternatives rule so the form renders real fields', () => {
    const form = paramFormSchema(deckWithRule) as Record<string, unknown>;
    expect(form.anyOf).toBeUndefined();
    expect(Object.keys(form.properties as object)).toEqual([
      'sourcePath',
      'topic',
      'content',
      'audience',
    ]);
    expect(deckWithRule.anyOf).toHaveLength(3);
  });

  it('omits the keys a surface fills itself, from properties and required', () => {
    const form = paramFormSchema({ ...deckWithRule, required: ['topic', 'audience'] }, [
      'topic',
    ]) as { properties: object; required: string[] };
    expect(Object.keys(form.properties)).toEqual(['sourcePath', 'content', 'audience']);
    expect(form.required).toEqual(['audience']);
  });

  it('launchFormParamSchema also drops input params', () => {
    const form = launchFormParamSchema({
      type: 'object',
      oneOf: [{ required: ['notes'] }],
      properties: {
        notes: { type: 'string', input: { kind: 'folder' } },
        title: { type: 'string' },
      },
    }) as Record<string, unknown>;
    expect(form.oneOf).toBeUndefined();
    expect(Object.keys(form.properties as object)).toEqual(['title']);
  });
});

describe('paramAlternatives', () => {
  it('reads each branch as the keys it requires', () => {
    expect(paramAlternatives(deckWithRule)).toEqual([['sourcePath'], ['topic'], ['content']]);
  });

  it('has no rule when a branch requires nothing, or none is declared', () => {
    expect(paramAlternatives({ anyOf: [{ required: ['a'] }, {}] })).toEqual([]);
    expect(paramAlternatives({ properties: {} })).toEqual([]);
    expect(paramAlternatives(undefined)).toEqual([]);
  });
});

describe('unmetParamAlternatives', () => {
  it('reports every alternative when none is given', () => {
    expect(unmetParamAlternatives(deckWithRule, { topic: '  ', audience: 'execs' })).toEqual([
      ['sourcePath'],
      ['topic'],
      ['content'],
    ]);
  });

  it('is met by any one non-blank alternative', () => {
    expect(unmetParamAlternatives(deckWithRule, { content: 'Q3 numbers' })).toBeNull();
  });

  it('counts a key the caller fills, like the composer message', () => {
    expect(unmetParamAlternatives(deckWithRule, {}, ['topic'])).toBeNull();
  });

  it('never holds a launch on a key the form does not ask for', () => {
    const schema = {
      anyOf: [{ required: ['reviewId'] }, { required: ['focus'] }],
      properties: { reviewId: { type: 'string', askUser: false }, focus: { type: 'string' } },
    };
    expect(unmetParamAlternatives(schema, {})).toBeNull();
  });

  it('is null for a book without the rule', () => {
    expect(unmetParamAlternatives(deckSchema, {})).toBeNull();
  });
});
