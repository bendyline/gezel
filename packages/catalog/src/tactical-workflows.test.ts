import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeCraftbookDoc } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { gildePackageRoot } from './gilde-data.js';
import {
  type TacticalBook,
  TacticalBookSchema,
  TacticalWaveConfigSchema,
  lintTacticalBook,
  mergeTacticalIdentity,
  tacticalCraftbookDoc,
} from './tactical-workflows.js';

const gildeRoot = gildePackageRoot();
const authoringRoot = join(gildeRoot, 'authoring', 'tactical');
const dataRoot = join(gildeRoot, 'data', 'craftbook-templates');
const wave = TacticalWaveConfigSchema.parse(
  JSON.parse(readFileSync(join(authoringRoot, 'wave.json'), 'utf8')) as unknown,
);

function readBook(id: string): TacticalBook {
  return TacticalBookSchema.parse(
    JSON.parse(readFileSync(join(authoringRoot, 'books', `${id}.json`), 'utf8')) as unknown,
  );
}

describe('tactical craftbook compiler', () => {
  it.each(wave.books)(
    '$id@$version regenerates the pinned Gilde document byte-for-byte',
    (release) => {
      const book = readBook(release.id);
      expect(lintTacticalBook(book)).toEqual([]);

      const generated = tacticalCraftbookDoc(book, release);
      const committed = readFileSync(
        join(
          dataRoot,
          release.id.slice(0, 2),
          release.id,
          'versions',
          release.version,
          'craftbook.json',
        ),
        'utf8',
      );

      expect(serializeCraftbookDoc(generated, 'json')).toBe(committed);
      expect(generated.paramSchema).toMatchObject({
        type: 'object',
        properties: {
          workPath: { type: 'string', default: '{{task.dir}}' },
        },
      });
    },
  );

  it('rejects fleet hazards before compiling a document', () => {
    const book = readBook(wave.books[0]!.id);
    const unsafe: TacticalBook = {
      ...book,
      doc: { ...book.doc, commands: undefined },
      workflow: {
        ...book.workflow,
        phases: book.workflow.phases.map((phase, index) =>
          index === 0
            ? {
                ...phase,
                prompt: `${phase.prompt}\nWrite {{diffpack.filesDir}}/notes.md in propose mode.`,
                output: { ...phase.output, path: 'src/synthetic-fix.ts' },
              }
            : phase,
        ),
        review: { ...book.workflow.review, reviewPath: 'review.md' },
      },
    };

    expect(lintTacticalBook(unsafe)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('references a {{diffpack.*}} token'),
        expect.stringContaining('must carry no mode prose'),
        expect.stringContaining('synthetic source path'),
        expect.stringContaining('must live under {{workPath}}/'),
        expect.stringContaining('declares no matching `commands` need'),
      ]),
    );
    expect(() => tacticalCraftbookDoc(unsafe, wave.books[0]!)).toThrow(unsafe.id);
    expect(() => tacticalCraftbookDoc(book, { ...wave.books[0]!, id: 'different-book' })).toThrow(
      /does not match wave entry/,
    );
  });

  it('updates compiler-owned identity fields without erasing curated metadata', () => {
    const book = readBook(wave.books[0]!.id);
    expect(
      mergeTacticalIdentity(
        {
          name: 'Stale name',
          logo: 'custom.webp',
          maintainer: { name: 'Curator' },
          yankedVersions: ['1.0.0'],
          workflow: 'build-loop',
        },
        book,
      ),
    ).toMatchObject({
      schemaVersion: 1,
      kind: 'craftbook-template',
      id: book.id,
      name: book.name,
      description: book.description,
      role: book.role,
      category: book.category,
      tags: book.tags,
      logo: 'custom.webp',
      maintainer: { name: 'Curator' },
      yankedVersions: ['1.0.0'],
      workflow: 'build-loop',
      license: 'MIT',
    });
  });
});
