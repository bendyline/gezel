import { describe, expect, it } from 'vitest';
import {
  MIN_TASK_DESCRIPTION_LENGTH,
  composeCraftbookLaunch,
  composeCraftbookTaskDescription,
  fillMainContentParam,
  mainContentParamKey,
  stringifyCraftbookParamValues,
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
