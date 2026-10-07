import { describe, expect, it } from 'vitest';
import { renderDigestBody, spliceIntoText } from '../recognition/digest.js';
import {
  imageFormat,
  imageMimeType,
  portableImageDigest,
  portableImageRecognition,
  portableImageRefs,
  sha256Hex,
} from './vision.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const SHA = 'a'.repeat(64);

describe('portable vision helpers', () => {
  it('finds image refs in reading order, once each, inside the project only', () => {
    expect(
      portableImageRefs(
        [
          '![a](artifacts/prompts/2026-10-06-0001/message_files/a.jpg)',
          '![b](<artifacts/prompts/2026-10-06-0001/message_files/b.PNG>)',
          '![a again](artifacts/prompts/2026-10-06-0001/message_files/a.jpg)',
          '[not an image](artifacts/notes.md)',
          '![remote](https://example.com/x.png)',
          '![doc](documents/shared.png)',
        ].join('\n'),
      ),
    ).toEqual([
      'artifacts/prompts/2026-10-06-0001/message_files/a.jpg',
      'artifacts/prompts/2026-10-06-0001/message_files/b.PNG',
    ]);
  });

  it('sniffs the format from the bytes and the mime type from the name', () => {
    expect(imageFormat(JPEG)).toBe('jpeg');
    expect(imageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('png');
    expect(imageFormat(new Uint8Array([1, 2, 3]))).toBe('unknown');
    expect(imageMimeType('x/photo.JPG')).toBe('image/jpeg');
    expect(imageMimeType('x/scan.heic')).toBe('image/heic');
  });

  it('hashes like the desktop index does', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('grades a reading by what it could say', () => {
    const at = '2026-10-06T10:00:00.000Z';
    const base = { bytes: JPEG, sha256: SHA, durationMs: 12.4, at };
    expect(
      portableImageRecognition({
        ...base,
        reading: { description: 'A dog.', models: ['llama-cpp:smolvlm2-500m'] },
      }),
    ).toMatchObject({ status: 'ok', engine: 'llama-cpp', modes: ['describe'], durationMs: 12 });
    expect(
      portableImageRecognition({ ...base, reading: { text: 'EXIT', models: ['apple-vision'] } }),
    ).toMatchObject({ status: 'partial', engine: 'system', modes: ['ocr'], ocrText: 'EXIT' });
    expect(portableImageRecognition({ ...base, reading: { models: [] } })).toMatchObject({
      status: 'static-only',
      modelId: 'none',
    });
  });

  it('renders labels into the same digest block the desktop splices', () => {
    const recognition = portableImageRecognition({
      bytes: JPEG,
      sha256: SHA,
      durationMs: 5,
      at: '2026-10-06T10:00:00.000Z',
      reading: {
        labels: ['tomato', 'plant'],
        width: 800,
        height: 600,
        models: ['apple-vision'],
      },
    });
    expect(renderDigestBody(recognition)).toContain('Scene labels: tomato, plant');
    expect(renderDigestBody(recognition)).toContain('JPEG 800×600');
    const ref = 'artifacts/prompts/2026-10-06-0001/message_files/a.jpg';
    const spliced = spliceIntoText(`Ripe?\n\n![Photo](${ref})`, [
      portableImageDigest(ref, recognition),
    ]);
    expect(spliced).toContain('![Photo](attached-image-1)');
    expect(spliced).toContain('<image-digest ref="attached-image-1">');
  });
});
