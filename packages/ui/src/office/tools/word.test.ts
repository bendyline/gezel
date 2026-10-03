import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WordPicture, officeWordDocument } from './word.js';

const TOKEN = `GEZELDIAGRAM${'a'.repeat(32)}`;
const placeholderParagraph = `<p style="text-align:center">${TOKEN}</p>`;
const picture: WordPicture = {
  placeholder: TOKEN,
  base64: 'UE5H',
  widthPt: 300,
  heightPt: 120,
  altText: 'Diagram',
};

interface Paragraph {
  text: string;
}

/**
 * Just enough of Office.js for the insert paths: every call queues an
 * operation that runs at `sync()`, and an operation that throws drops the
 * rest of its batch, as Word does. Paragraphs are plain strings.
 */
function fakeWord(
  initial: string[],
  opts: {
    /** Word rejects the picture when the batch runs. */
    failPicture?: boolean;
    /** The placeholder went in, but search cannot see it. */
    blindSearch?: boolean;
    /** The range the insert returned can no longer be deleted. */
    failUndo?: boolean;
    /** Paragraphs [start, start + count) are selected; count 0 is a cursor. */
    selection?: { start: number; count: number };
  } = {},
) {
  const paragraphs: Paragraph[] = initial.map((text) => ({ text }));
  const selection = opts.selection ?? { start: paragraphs.length, count: 0 };
  let queue: Array<() => void> = [];
  const enqueue = (op: () => void) => queue.push(op);
  const parse = (html: string) =>
    [...html.matchAll(/<(p|h\d)[^>]*>(.*?)<\/\1>/g)].map((m) => ({ text: m[2]! }));
  const insertAt = (index: number, created: Paragraph[]) => paragraphs.splice(index, 0, ...created);
  const remove = (gone: Paragraph[]) => {
    for (const p of gone) paragraphs.splice(paragraphs.indexOf(p), 1);
  };

  const insertedRange = (created: Paragraph[]) => ({
    delete: () =>
      enqueue(() => {
        if (opts.failUndo) throw new Error('ItemNotFound');
        remove(created);
      }),
    insertOoxml: (ooxml: string) =>
      enqueue(() => {
        if (opts.failUndo) throw new Error('ItemNotFound');
        const at = paragraphs.indexOf(created[0]!);
        remove(created);
        insertAt(
          at,
          (JSON.parse(ooxml) as string[]).map((text) => ({ text })),
        );
      }),
  });
  const insertHtml = (
    html: string,
    index: () => number,
    replaced: () => Paragraph[] = () => [],
  ) => {
    const created: Paragraph[] = [];
    enqueue(() => {
      const at = index();
      remove(replaced());
      created.push(...parse(html));
      insertAt(at, created);
    });
    return insertedRange(created);
  };
  const selected = () => paragraphs.slice(selection.start, selection.start + selection.count);
  const found = (paragraph: Paragraph, token: string) => ({
    insertInlinePictureFromBase64: () => {
      enqueue(() => {
        if (opts.failPicture) throw new Error('GeneralException: the picture is invalid.');
        paragraph.text = paragraph.text.replace(token, '[picture]');
      });
      return {} as Record<string, unknown>;
    },
    delete: () =>
      enqueue(() => {
        paragraph.text = paragraph.text.replace(token, '');
      }),
  });

  const ctx = {
    sync: async () => {
      const batch = queue;
      queue = [];
      for (const op of batch) op();
    },
    document: {
      body: {
        insertHtml: (html: string, where: string) =>
          insertHtml(html, () => (where === 'Start' ? 0 : paragraphs.length)),
        search: (token: string) => {
          const results = {
            items: [] as Array<ReturnType<typeof found>>,
            load: () =>
              enqueue(() => {
                results.items = opts.blindSearch
                  ? []
                  : paragraphs.filter((p) => p.text.includes(token)).map((p) => found(p, token));
              }),
          };
          return results;
        },
      },
      getSelection: () => {
        const range = {
          text: '',
          inlinePictures: { items: [], load: () => {} },
          load: () =>
            enqueue(() => {
              range.text = selected()
                .map((p) => p.text)
                .join('\n');
            }),
          getOoxml: () => {
            const result = { value: '' };
            enqueue(() => {
              result.value = JSON.stringify(selected().map((p) => p.text));
            });
            return result;
          },
          insertHtml: (html: string, where: string) =>
            where === 'Replace'
              ? insertHtml(html, () => selection.start, selected)
              : insertHtml(html, () => selection.start + selection.count),
        };
        return range;
      },
    },
  };
  vi.stubGlobal('Word', {
    run: async <T>(batch: (context: typeof ctx) => Promise<T>) => {
      const result = await batch(ctx);
      await ctx.sync();
      return result;
    },
    InsertLocation: { start: 'Start', end: 'End', replace: 'Replace' },
  });
  return { texts: () => paragraphs.map((p) => p.text) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('placing a diagram in Word', () => {
  it('swaps the placeholder for the picture', async () => {
    const doc = fakeWord(['Intro.']);
    await officeWordDocument().insert(placeholderParagraph, 'end', true, [picture]);
    expect(doc.texts()).toEqual(['Intro.', '[picture]']);
  });

  it('takes the whole insert back out when Word rejects the picture', async () => {
    const doc = fakeWord(['Intro.'], { failPicture: true });
    await expect(
      officeWordDocument().insert(
        `<h1>Tree</h1>${placeholderParagraph}<p>After.</p>`,
        'end',
        true,
        [picture],
      ),
    ).rejects.toThrow(/the picture is invalid\), so the document was left as it was/);
    expect(doc.texts()).toEqual(['Intro.']);
  });

  it('takes the insert back out when the placeholder cannot be found', async () => {
    const doc = fakeWord(['Intro.', 'Outro.'], {
      blindSearch: true,
      selection: { start: 0, count: 1 },
    });
    await expect(
      officeWordDocument().insert(placeholderParagraph, 'cursor', true, [picture]),
    ).rejects.toThrow(/placeholder was not found\), so the document was left as it was/);
    expect(doc.texts()).toEqual(['Intro.', 'Outro.']);
  });

  it('puts a replaced selection back when the diagram cannot be placed', async () => {
    const doc = fakeWord(['Intro.', 'Selected words.', 'Outro.'], {
      failPicture: true,
      selection: { start: 1, count: 1 },
    });
    await expect(
      officeWordDocument().replaceSelection(`<p>New.</p>${placeholderParagraph}`, true, [picture]),
    ).rejects.toThrow(/left as it was/);
    expect(doc.texts()).toEqual(['Intro.', 'Selected words.', 'Outro.']);
  });

  it('leaves nothing behind for an empty selection', async () => {
    const doc = fakeWord(['Intro.'], { failPicture: true });
    await expect(
      officeWordDocument().replaceSelection(placeholderParagraph, true, [picture]),
    ).rejects.toThrow(/left as it was/);
    expect(doc.texts()).toEqual(['Intro.']);
  });

  it('still removes the placeholder when the insert itself cannot be undone', async () => {
    const doc = fakeWord(['Intro.'], { failPicture: true, failUndo: true });
    await expect(
      officeWordDocument().insert(`${placeholderParagraph}<p>After.</p>`, 'end', true, [picture]),
    ).rejects.toThrow(/The text went in without it/);
    expect(doc.texts()).toEqual(['Intro.', '', 'After.']);
    expect(doc.texts().join('\n')).not.toContain('GEZELDIAGRAM');
  });
});
