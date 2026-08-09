import { describe, expect, it } from 'vitest';
import { validateConnectorConfig } from './config-validate.js';

const GITHUB_ISSUES_SCHEMA = {
  type: 'object',
  properties: {
    owner: { type: 'string', title: 'Repository owner' },
    repository: { type: 'string', title: 'Repository name' },
    apiBaseUrl: { type: 'string', title: 'API base URL (GitHub Enterprise only)' },
  },
  required: ['owner', 'repository'],
};

describe('validateConnectorConfig', () => {
  it('accepts a config satisfying the schema', () => {
    expect(
      validateConnectorConfig(GITHUB_ISSUES_SCHEMA, { owner: 'octocat', repository: 'hello' }),
    ).toEqual([]);
  });

  it('reports missing required fields with their titles', () => {
    const errors = validateConnectorConfig(GITHUB_ISSUES_SCHEMA, { owner: 'octocat' });
    expect(errors).toEqual(['repository: required (Repository name)']);
  });

  it('treats empty strings as missing for required fields', () => {
    expect(validateConnectorConfig(GITHUB_ISSUES_SCHEMA, { owner: '', repository: 'r' })).toEqual([
      'owner: required (Repository owner)',
    ]);
  });

  it('reports type mismatches on present fields', () => {
    const errors = validateConnectorConfig(GITHUB_ISSUES_SCHEMA, {
      owner: 'octocat',
      repository: 42,
    });
    expect(errors).toEqual(['repository: expected string, got integer']);
  });

  it('validates const and array items (the mail configSchema shapes)', () => {
    const schema = {
      type: 'object',
      properties: {
        provider: { type: 'string', const: 'gmail' },
        syncFolders: { type: 'array', items: { type: 'string' } },
      },
    };
    expect(validateConnectorConfig(schema, { provider: 'gmail', syncFolders: ['INBOX'] })).toEqual(
      [],
    );
    expect(validateConnectorConfig(schema, { provider: 'imap' })).toEqual([
      'provider: must be "gmail"',
    ]);
    expect(validateConnectorConfig(schema, { syncFolders: ['INBOX', 7] })).toEqual([
      'syncFolders[1]: expected string, got integer',
    ]);
  });

  it('ignores unknown keywords and missing schemas entirely', () => {
    expect(validateConnectorConfig(undefined, { anything: true })).toEqual([]);
    expect(
      validateConnectorConfig({ type: 'object', minProperties: 5 } as never, { a: 1 }),
    ).toEqual([]);
  });
});
