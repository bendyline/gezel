import { describe, expect, it, vi } from 'vitest';
import {
  bundlePreviewModules,
  isPreviewCompiledPath,
  previewImportProblem,
  previewImportSpecifier,
  resolvePreviewImport,
} from './modules.js';

describe('how a preview reads an import', () => {
  it('finds the TypeScript file an import names the way build tools do', () => {
    expect(resolvePreviewImport('./gameEngine', 'src/main.ts')).toEqual({
      kind: 'file',
      candidates: [
        'src/gameEngine.ts',
        'src/gameEngine.tsx',
        'src/gameEngine.js',
        'src/gameEngine.mjs',
        'src/gameEngine.jsx',
        'src/gameEngine.json',
        'src/gameEngine/index.ts',
        'src/gameEngine/index.tsx',
        'src/gameEngine/index.js',
      ],
    });
    expect(resolvePreviewImport('./tank.js', 'src/main.ts')).toEqual({
      kind: 'file',
      candidates: ['src/tank.js', 'src/tank.ts', 'src/tank.tsx'],
    });
    expect(resolvePreviewImport('../config/settings.ts', 'src/tank/index.ts')).toEqual({
      kind: 'file',
      candidates: ['src/config/settings.ts'],
    });
    expect(resolvePreviewImport('./tanks/', 'src/main.ts')).toEqual({
      kind: 'file',
      candidates: ['src/tanks/index.ts', 'src/tanks/index.tsx', 'src/tanks/index.js'],
    });
  });

  it('tries an asset by its exact name before module forms', () => {
    const found = resolvePreviewImport('./sprites/tank.png', 'main.ts');
    expect(found.kind === 'file' && found.candidates[0]).toBe('sprites/tank.png');
  });

  it('refuses what a preview cannot load, and says why', () => {
    expect(resolvePreviewImport('phaser', 'main.ts')).toEqual({ kind: 'package', name: 'phaser' });
    expect(resolvePreviewImport('@pixi/core/lib', 'main.ts')).toEqual({
      kind: 'package',
      name: '@pixi/core',
    });
    expect(resolvePreviewImport('https://cdn.example/x.js', 'main.ts')).toEqual({ kind: 'url' });
    expect(resolvePreviewImport('../../x', 'src/main.ts')).toEqual({ kind: 'outside' });
    expect(previewImportProblem('src/main.ts', 'phaser', { kind: 'package', name: 'phaser' })).toBe(
      'src/main.ts imports the npm package "phaser". A preview runs only files in the project, so add the library\'s file to the project and import it by path.',
    );
    expect(
      previewImportProblem('src/main.ts', './game/Game', { kind: 'file', candidates: [] }),
    ).toBe("src/main.ts imports ./game/Game, which isn't in the project.");
  });

  it('writes the import a host rewrites to the file it found', () => {
    expect(previewImportSpecifier('src/main.ts', 'src/gameEngine.ts')).toBe('./gameEngine.ts');
    expect(previewImportSpecifier('src/tank/index.ts', 'src/config/settings.ts')).toBe(
      '../config/settings.ts',
    );
    expect(previewImportSpecifier('main.ts', 'src/a/b.ts')).toBe('./src/a/b.ts');
  });

  it('compiles TypeScript and JSX, not declarations or plain scripts', () => {
    expect(isPreviewCompiledPath('src/main.ts')).toBe(true);
    expect(isPreviewCompiledPath('App.tsx')).toBe(true);
    expect(isPreviewCompiledPath('types.d.ts')).toBe(false);
    expect(isPreviewCompiledPath('game.js')).toBe(false);
  });
});

describe('a linked preview bundle', () => {
  it('runs each module once, in import order, sharing its exports', () => {
    const log: string[] = [];
    const bundle = bundlePreviewModules(
      [
        {
          path: 'src/main.ts',
          code: 'var engine = require("./engine"); var tank = require("./tank"); log("main " + engine.count() + " " + tank.name);',
          requires: { './engine': 'src/engine.ts', './tank': 'src/tank.ts' },
        },
        {
          path: 'src/tank.ts',
          code: 'var engine = require("./engine"); engine.count(); exports.name = "Sherman";',
          requires: { './engine': 'src/engine.ts' },
        },
        {
          path: 'src/engine.ts',
          code: 'log("engine"); var n = 0; exports.count = function () { return ++n; };',
          requires: {},
        },
      ],
      ['src/main.ts'],
    );
    new Function('log', bundle)((line: string) => log.push(line));
    expect(log).toEqual(['engine', 'main 2 Sherman']);
  });

  it('reports an entry that throws and still runs the next', () => {
    vi.useFakeTimers();
    try {
      const ran: string[] = [];
      const bundle = bundlePreviewModules(
        [
          { path: 'broken.ts', code: 'throw new Error("boom");', requires: {} },
          { path: 'fine.ts', code: 'ran.push("fine");', requires: {} },
        ],
        ['broken.ts', 'fine.ts'],
      );
      new Function('ran', bundle)(ran);
      expect(ran).toEqual(['fine']);
      expect(() => vi.runAllTimers()).toThrow('boom');
    } finally {
      vi.useRealTimers();
    }
  });
});
