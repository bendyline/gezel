import type { CraftbookTemplateManifest } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  craftbookCommandName,
  renderCraftbookCommand,
  seedableParamDefault,
} from './craftbook-command.js';

// Only the fields the renderer reads; cast through the manifest type.
function manifest(partial: {
  id: string;
  command?: string;
  paramSchema?: Record<string, unknown>;
}): CraftbookTemplateManifest {
  return partial as unknown as CraftbookTemplateManifest;
}

const review = manifest({
  id: 'pull-request-review',
  command: 'pr-review',
  paramSchema: {
    type: 'object',
    properties: {
      focus: { type: 'string' },
      intensity: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
  },
});

describe('craftbookCommandName', () => {
  it('prefers the explicit command alias', () => {
    expect(craftbookCommandName(review)).toBe('pr-review');
  });
  it('falls back to the id when no command', () => {
    expect(craftbookCommandName(manifest({ id: 'investigate' }))).toBe('investigate');
  });
});

describe('renderCraftbookCommand', () => {
  it('renders the bare command for a parameterless craftbook', () => {
    expect(renderCraftbookCommand(manifest({ id: 'qa' }), {})).toBe('qa');
  });

  it('renders positional tokens in declaration order', () => {
    expect(renderCraftbookCommand(review, { focus: 'security', intensity: 'high' })).toBe(
      'pr-review security high',
    );
  });

  it('switches to key=value once an earlier optional param is empty', () => {
    expect(renderCraftbookCommand(review, { focus: '', intensity: 'high' })).toBe(
      'pr-review intensity=high',
    );
  });

  it('quotes values containing whitespace', () => {
    expect(renderCraftbookCommand(review, { focus: 'auth and crypto', intensity: 'high' })).toBe(
      'pr-review "auth and crypto" high',
    );
  });

  it('omits a false boolean and emits the key for a true one', () => {
    const m = manifest({
      id: 'b',
      command: 'b',
      paramSchema: { type: 'object', properties: { deep: { type: 'boolean' } } },
    });
    expect(renderCraftbookCommand(m, { deep: 'false' })).toBe('b');
    expect(renderCraftbookCommand(m, { deep: 'true' })).toBe('b true');
  });
});

describe('seedableParamDefault', () => {
  it('returns a plain declared default', () => {
    expect(seedableParamDefault({ default: 'medium' })).toBe('medium');
    expect(seedableParamDefault({ default: false })).toBe(false);
    expect(seedableParamDefault({ default: 3 })).toBe(3);
  });

  it('returns undefined when nothing is declared', () => {
    expect(seedableParamDefault(undefined)).toBeUndefined();
    expect(seedableParamDefault({})).toBeUndefined();
  });

  it('withholds a default that is itself a runtime template', () => {
    // Seeding this renders it back into the staged command as an explicit
    // param, which bypasses the server's default resolution and reaches
    // the gate as a literal the unresolved-placeholder guard rejects.
    expect(seedableParamDefault({ default: '{{task.dir}}' })).toBeUndefined();
    expect(seedableParamDefault({ default: '{{ task.dir }}' })).toBeUndefined();
    expect(seedableParamDefault({ default: 'reviews/{{task.num}}' })).toBeUndefined();
  });

  it('leaves the whole schema unseeded end-to-end, so no token is staged', () => {
    const m = manifest({
      id: 'security-architecture-review',
      paramSchema: { type: 'object', properties: { workPath: { default: '{{task.dir}}' } } },
    });
    expect(renderCraftbookCommand(m, {})).toBe('security-architecture-review');
  });
});
