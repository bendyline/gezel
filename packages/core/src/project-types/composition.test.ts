import { describe, expect, it } from 'vitest';
import { nativeToolSpecs } from '../tools/native-tools.js';
import {
  normalizePagePath,
  pageReadIsDeclared,
  projectTypeHostGap,
  projectTypeModelTools,
  projectTypePageTools,
  projectTypePageUsesApiV1,
  projectTypeScriptHeader,
  projectTypeScriptProvenance,
  renderProjectTypeReactionSeed,
} from './composition.js';

const tool = (name: string) => ({ name, description: name, script: 'store' });

describe('project type composition rules', () => {
  it('splits the model surface from the page-only surface', () => {
    const manifest = {
      tools: [tool('make_move'), tool('user_move'), tool('get_board')],
      pages: { entry: 'board/index.html', tools: ['user_move', 'typo'] },
    };
    expect(projectTypeModelTools(manifest).map((t) => t.name)).toEqual(['make_move', 'get_board']);
    expect(projectTypePageTools(manifest).map((t) => t.name)).toEqual(['user_move']);
  });

  it('normalizes page paths and refuses any that could escape', () => {
    expect(normalizePagePath('./data//progress.json/')).toBe('data/progress.json');
    expect(normalizePagePath('')).toBe('');
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\0b'])
      expect(normalizePagePath(bad)).toBeNull();
  });

  it('admits a page read only for a declared file or subtree of the right source', () => {
    const scopes = [
      { source: 'workspace' as const, path: 'progress.json', subtree: false },
      { source: 'artifacts' as const, path: 'posts', subtree: true },
    ];
    expect(pageReadIsDeclared(scopes, 'workspace', 'progress.json')).toBe(true);
    expect(pageReadIsDeclared(scopes, 'workspace', 'progress.json.bak')).toBe(false);
    expect(pageReadIsDeclared(scopes, 'artifacts', 'progress.json')).toBe(false);
    expect(pageReadIsDeclared(scopes, 'artifacts', 'posts/1.json')).toBe(true);
    expect(pageReadIsDeclared(scopes, 'artifacts', 'postscript.json')).toBe(false);
  });

  it('names what a host lacks before it offers a type', () => {
    const host = { modelTier: 'small' as const, scripts: true, toolsets: false };
    expect(projectTypeHostGap({ tools: [], toolsets: [] }, host)).toBeUndefined();
    expect(
      projectTypeHostGap({ capabilityFloor: 'small', tools: [], toolsets: [] }, host),
    ).toBeUndefined();
    expect(
      projectTypeHostGap({ capabilityFloor: 'medium', tools: [], toolsets: [] }, host),
    ).toMatch(/larger model/);
    expect(
      projectTypeHostGap({ tools: [tool('x')], toolsets: [] }, { ...host, scripts: false }),
    ).toMatch(/scripts/);
    expect(
      projectTypeHostGap(
        { tools: [], toolsets: [{ id: 'web', need: 'required', autoAllow: [] }] },
        host,
      ),
    ).toMatch(/desktop/);
    // No model chosen yet: the floor cannot be judged, so it is not held against the type.
    expect(
      projectTypeHostGap(
        { capabilityFloor: 'large', tools: [], toolsets: [] },
        { scripts: true, toolsets: false },
      ),
    ).toBeUndefined();
  });

  it('recognizes a v1 page by its manifest or its source', () => {
    expect(projectTypePageUsesApiV1({ pages: { entry: 'a.html', api: 1 } })).toBe(true);
    expect(projectTypePageUsesApiV1({ pages: { entry: 'a.html' } }, 'makeDemoGezel({})')).toBe(
      true,
    );
    expect(
      projectTypePageUsesApiV1({ pages: { entry: 'a.html' } }, "fetch('/preview/' + capability)"),
    ).toBe(false);
  });

  it('labels a reaction seed with its type and renders run output into it', () => {
    expect(
      renderProjectTypeReactionSeed({
        typeName: 'Checkers',
        prompt:
          '{{personality}}: they played {{output.lastMove}} ({{output.stats.moves}}) via {{tool}}.',
        tool: 'user_move',
        params: { personality: 'zen' },
        output: { lastMove: 'c3-d4', stats: { moves: 3 } },
      }),
    ).toBe('[Checkers page]: zen: they played c3-d4 (3) via user_move.');
  });

  it('round-trips the script provenance header', () => {
    expect(projectTypeScriptProvenance(`${projectTypeScriptHeader('checkers', '1.2.0')}code`)).toBe(
      'checkers@1.2.0',
    );
    expect(projectTypeScriptProvenance('// @gezel-craftbook: x@1\ncode')).toBeNull();
  });

  it("keeps a project type's own tools in the narrowest native listing", () => {
    const specs = nativeToolSpecs(
      [
        { name: 'list_projects', description: 'List.', parameters: { type: 'object' } },
        { name: 'ask_user_question', description: 'Ask.', parameters: { type: 'object' } },
        { name: 'make_move', description: 'Move.', parameters: { type: 'object' }, core: true },
      ],
      'core',
    );
    expect(specs.map((spec) => spec.name)).toEqual(['ask_user_question', 'make_move']);
  });
});
