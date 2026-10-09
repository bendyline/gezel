/**
 * The nightly photo-album pass against real photos.
 *
 * `photo-library-nightly`'s own `test.json` can only seed text, so it proves
 * the honest empty pass and nothing else: a book that reads capture dates out
 * of EXIF needs JPEGs that carry them. This scenario builds those bytes at
 * load time — three outings, two inside the book's look-back window and one
 * well outside it — and runs the real craftbook task.
 *
 * Dates are relative to when the scenario is built, so the window holds on
 * whatever day the eval runs.
 */

import { craftbookScenarioFromSpec } from '../craftbooks/scenario.ts';
import { craftbookEvalSpecMap } from '../craftbooks/specs.ts';
import type { CraftbookEvalSpec } from '../craftbooks/types.ts';
import type { EvalScenario } from '../types.ts';

/** A 16x12 baseline JPEG; the scenario splices an Exif segment in after SOI. */
const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9PjsBCgsLDg0OHBAQHDsoIig7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O//AABEIAAwAEAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/ALAT/pmfzr01JvqzkVP+6Icdto+rUnfz/AXu9LBKBHjCjn1qIjqpQtZDRJ/sr+VNszU/I//Z',
  'base64',
);

/** Little-endian TIFF with Make, Model and an Exif IFD holding DateTimeOriginal. */
function exifSegment(taken: Date, make: string, model: string): Buffer {
  const ascii = (s: string) => Buffer.from(`${s}\0`, 'latin1');
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const stamp = ascii(
    `${taken.getFullYear()}:${pad2(taken.getMonth() + 1)}:${pad2(taken.getDate())} ${pad2(taken.getHours())}:${pad2(taken.getMinutes())}:${pad2(taken.getSeconds())}`,
  );
  const makeBytes = ascii(make);
  const modelBytes = ascii(model);
  const ifd0At = 8;
  const ifd0Size = 2 + 3 * 12 + 4;
  const exifAt = ifd0At + ifd0Size;
  const exifSize = 2 + 1 * 12 + 4;
  let dataAt = exifAt + exifSize;
  const blobs: Buffer[] = [];
  const place = (b: Buffer): number => {
    const at = dataAt;
    blobs.push(b);
    dataAt += b.length;
    return at;
  };
  const entry = (tag: number, type: number, count: number, value: number) => {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(tag, 0);
    e.writeUInt16LE(type, 2);
    e.writeUInt32LE(count, 4);
    e.writeUInt32LE(value, 8);
    return e;
  };
  const ifd = (entries: Buffer[]) => {
    const count = Buffer.alloc(2);
    count.writeUInt16LE(entries.length);
    return Buffer.concat([count, ...entries, Buffer.alloc(4)]);
  };
  const ifd0 = ifd([
    entry(0x010f, 2, makeBytes.length, place(makeBytes)),
    entry(0x0110, 2, modelBytes.length, place(modelBytes)),
    entry(0x8769, 4, 1, exifAt),
  ]);
  const exif = ifd([entry(0x9003, 2, stamp.length, place(stamp))]);
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const tiff = Buffer.concat([header, ifd0, exif, ...blobs]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([marker, body]);
}

function photo(taken: Date, make: string, model: string): Buffer {
  return Buffer.concat([
    BASE_JPEG.subarray(0, 2),
    exifSegment(taken, make, model),
    BASE_JPEG.subarray(2),
  ]);
}

interface Outing {
  folder: string;
  daysAgo: number;
  count: number;
  camera: [string, string];
}

/** Two outings inside the 45-day window, one far outside it. */
const OUTINGS: Outing[] = [
  { folder: 'beach', daysAgo: 9, count: 10, camera: ['Apple', 'iPhone 15 Pro'] },
  { folder: 'birthday', daysAgo: 23, count: 8, camera: ['FUJIFILM', 'X-T5'] },
  { folder: 'winter', daysAgo: 140, count: 8, camera: ['Apple', 'iPhone 15 Pro'] },
];

function localDay(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function outingStart(outing: Outing, now: Date): Date {
  const start = new Date(now);
  start.setDate(start.getDate() - outing.daysAgo);
  start.setHours(13, 0, 0, 0);
  return start;
}

export function photoAlbumSpecs(now = new Date()): CraftbookEvalSpec[] {
  // Absent until the content pin carries the book; never break the registry.
  const source = craftbookEvalSpecMap().get('photo-library-nightly');
  if (!source) return [];

  const files: NonNullable<CraftbookEvalSpec['setup']>['files'] = [];
  for (const outing of OUTINGS) {
    const start = outingStart(outing, now);
    for (let i = 0; i < outing.count; i++) {
      const taken = new Date(start.getTime() + i * 7 * 60_000);
      files.push({
        path: `Camera/${outing.folder}/IMG_${String(i + 1).padStart(4, '0')}.jpg`,
        content: `${outing.folder} photo ${i + 1}`,
        contentBase64: photo(taken, ...outing.camera).toString('base64'),
        mimeType: 'image/jpeg',
      });
    }
  }
  const [beach, birthday, winter] = OUTINGS.map((o) => localDay(outingStart(o, now)));
  const objective =
    'Propose one Squisq slideshow album for each of the two recent outings, built only from photos the index lists, and none for the outing outside the window.';

  return [
    {
      ...source,
      scenarioId: 'photo-albums-real-photos',
      title: 'Nightly albums from photos with capture dates',
      objective,
      mode: 'workflow',
      repairPolicy: 'runtime',
      setup: {
        ...source.setup!,
        projectName: 'Photo Albums — real photos',
        about:
          'A family photo folder. The camera roll holds three outings: a beach afternoon, a birthday, and a winter walk months ago.',
        missionObjectives: objective,
        files,
      },
      success: {
        summary: objective,
        checks: [
          {
            kind: 'fileCount',
            ext: ['md'],
            min: 2,
            dir: 'albums',
            artifact: true,
          },
          {
            kind: 'contains',
            file: '{{task.dir}}/albums.md',
            pattern: `albums/${beach}-`,
            label: 'an album for the beach outing',
            artifact: true,
          },
          {
            kind: 'contains',
            file: '{{task.dir}}/albums.md',
            pattern: `albums/${birthday}-`,
            label: 'an album for the birthday',
            artifact: true,
          },
          {
            kind: 'notContains',
            file: '{{task.dir}}/albums.md',
            pattern: `albums/${winter}-`,
            label: 'no album for the outing outside the window',
            artifact: true,
          },
        ],
        taskGraph: { requireCraftbookTask: true, requireTerminalStep: true },
      },
      coverage: {
        status: 'implemented',
        validatedMode: 'workflow',
        notes:
          'Real JPEGs with EXIF capture dates; checks the outing window and that album paths come from the index.',
      },
      qualityFocus: [
        'albums name only photos the index lists',
        'outings outside the look-back window are left alone',
      ],
    },
  ];
}

export function photoAlbumScenarios(): EvalScenario[] {
  return photoAlbumSpecs().map((spec) => craftbookScenarioFromSpec(spec));
}
