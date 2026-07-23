import type { CraftbookTemplateManifest } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { craftbookCommandName, renderCraftbookCommand } from './craftbook-command.js';

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
