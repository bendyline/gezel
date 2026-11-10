import type { SquisqAnnotatedSchema } from '@bendyline/squisq';
import { describe, expect, it } from 'vitest';
import { projectTypeParamForm, projectTypeParamsForSubmit } from './project-type-params.js';

// The Cash Flow Planner's questions, as the catalog ships them.
const cashFlow: SquisqAnnotatedSchema = {
  type: 'object',
  properties: {
    business: {
      type: 'string',
      title: 'What kind of business is this?',
      description: "e.g. 'a three-person electrical contractor', 'a design studio'.",
      default: 'the business',
    },
    currency: {
      type: 'string',
      title: 'Which currency is the cash in?',
      description: 'A three-letter code, e.g. USD, EUR or GBP.',
      default: 'USD',
    },
  },
  required: ['business', 'currency'],
};

describe('project type questions', () => {
  it('shows a typed answer’s default as a hint, never as an answer', () => {
    const { schema, initial } = projectTypeParamForm(cashFlow);
    expect(initial).not.toHaveProperty('business');
    expect(schema?.properties?.business?.squisq?.placeholder).toBe('the business');
  });

  it('asks for the currency from a list that starts on the type’s default', () => {
    const { schema, initial } = projectTypeParamForm(cashFlow);
    const currency = schema?.properties?.currency;
    expect(initial.currency).toBe('USD');
    expect(currency?.squisq?.control).toBe('combobox');
    expect(currency?.enum).toEqual(expect.arrayContaining(['USD', 'EUR', 'GBP', 'JPY']));
    expect(currency?.squisq?.enumLabels?.EUR).toBe('EUR — Euro');
    // The type's "three-letter code" help describes typing.
    expect(currency?.description).toBeUndefined();
  });

  it('keeps an unlisted default currency choosable', () => {
    const { schema } = projectTypeParamForm({
      type: 'object',
      properties: { currency: { type: 'string', default: 'xof' } },
    });
    expect(schema?.properties?.currency?.enum?.[0]).toBe('XOF');
  });

  it('leaves choices, numbers and dates as they were', () => {
    const level = { type: 'string', enum: ['easy', 'hard'], default: 'easy' };
    const date = { type: 'string', format: 'date', default: '2026-12-31' };
    const { schema, initial } = projectTypeParamForm({
      type: 'object',
      properties: { level, date, rounds: { type: 'number', default: 3 } },
    });
    expect(schema?.properties?.level).toEqual(level);
    expect(schema?.properties?.date).toEqual(date);
    expect(initial).toEqual({ level: 'easy', date: '2026-12-31', rounds: 3 });
  });

  it('creates the project with the default for a question left blank', () => {
    expect(projectTypeParamsForSubmit(cashFlow, { currency: 'EUR' })).toEqual({
      business: 'the business',
      currency: 'EUR',
    });
    expect(projectTypeParamsForSubmit(cashFlow, { business: '  ', currency: 'USD' })).toEqual({
      business: 'the business',
      currency: 'USD',
    });
    expect(projectTypeParamsForSubmit(cashFlow, { business: 'a bakery' }).business).toBe(
      'a bakery',
    );
  });
});
