import { describe, expect, it } from 'vitest';
import {
  INPUT_DEFAULT_MAX_FILES,
  INPUT_HARD_MAX_BYTES,
  INPUT_HARD_MAX_FILES,
  craftbookInputParams,
  effectiveInputLimits,
  inputAccepts,
  inputSourceFromParamValue,
  isInputJunkName,
  isTaskInputArtifactPath,
  normalizeInputPath,
  paramInputSpec,
  taskInputReadTools,
  touchesTaskInputArtifactPath,
  withoutInputParams,
} from './craftbook-inputs.js';

const ebookSchema = {
  type: 'object',
  required: ['source', 'audience'],
  properties: {
    source: {
      type: 'string',
      title: 'Source content',
      description: 'The notes to compile.',
      input: { kind: 'folder', accept: ['.MD', '.docx'] },
    },
    audience: { type: 'string' },
    workPath: { type: 'string', default: '{{task.dir}}' },
  },
};

describe('craftbookInputParams', () => {
  it('finds annotated params, lower-cases extensions, and reads required', () => {
    expect(craftbookInputParams(ebookSchema)).toEqual([
      {
        key: 'source',
        title: 'Source content',
        description: 'The notes to compile.',
        required: true,
        spec: { kind: 'folder', accept: ['.md', '.docx'] },
      },
    ]);
  });

  it('ignores a malformed annotation rather than inventing an input', () => {
    expect(paramInputSpec({ type: 'string', input: { kind: 'directory' } })).toBeUndefined();
    expect(
      paramInputSpec({ type: 'string', input: { kind: 'file', accept: ['md'] } }),
    ).toBeUndefined();
    expect(craftbookInputParams(undefined)).toEqual([]);
  });
});

describe('withoutInputParams', () => {
  it('drops inputs from properties and required, leaving everything else', () => {
    const rest = withoutInputParams(ebookSchema) as typeof ebookSchema;
    expect(Object.keys(rest.properties)).toEqual(['audience', 'workPath']);
    expect(rest.required).toEqual(['audience']);
  });

  it('returns a schema without inputs untouched', () => {
    const plain = { properties: { topic: { type: 'string' } } };
    expect(withoutInputParams(plain)).toBe(plain);
  });
});

describe('effectiveInputLimits', () => {
  it('lets a book tighten the ceilings but never raise them', () => {
    expect(effectiveInputLimits({ kind: 'folder' }).maxFiles).toBe(INPUT_DEFAULT_MAX_FILES);
    expect(effectiveInputLimits({ kind: 'folder', maxFiles: 20 }).maxFiles).toBe(20);
    expect(effectiveInputLimits({ kind: 'folder', maxFiles: 10 ** 9 }).maxFiles).toBe(
      INPUT_HARD_MAX_FILES,
    );
    expect(effectiveInputLimits({ kind: 'folder', maxBytes: 10 ** 12 }).maxBytes).toBe(
      INPUT_HARD_MAX_BYTES,
    );
    expect(effectiveInputLimits({ kind: 'file', maxFiles: 50 }).maxFiles).toBe(1);
  });
});

describe('inputSourceFromParamValue', () => {
  it('reads a plain string as a workspace path and a prefixed one as an artifacts path', () => {
    expect(inputSourceFromParamValue('./notes/drafts/')).toEqual({
      from: 'workspace',
      path: 'notes/drafts',
    });
    expect(inputSourceFromParamValue('artifacts:tasks/7/chapters')).toEqual({
      from: 'artifacts',
      path: 'tasks/7/chapters',
    });
    expect(inputSourceFromParamValue('.')).toEqual({ from: 'workspace', path: '' });
    expect(inputSourceFromParamValue('  ')).toBeNull();
    expect(inputSourceFromParamValue('artifacts:')).toBeNull();
  });

  it('normalizes separators', () => {
    expect(normalizeInputPath('notes\\drafts\\')).toBe('notes/drafts');
  });
});

describe('file rules', () => {
  it('filters by extension, case-insensitively, and treats no accept list as any file', () => {
    const spec = { kind: 'folder' as const, accept: ['.md'] };
    expect(inputAccepts(spec, 'a/B.MD')).toBe(true);
    expect(inputAccepts(spec, 'a/b.txt')).toBe(false);
    expect(inputAccepts({ kind: 'folder' }, 'anything.bin')).toBe(true);
  });

  it('treats dotfiles and sync droppings as junk', () => {
    expect(isInputJunkName('.DS_Store')).toBe(true);
    expect(isInputJunkName('~$chapter.docx')).toBe(true);
    expect(isInputJunkName('chapter.docx')).toBe(false);
  });
});

describe('task input paths', () => {
  it('marks the inputs folder and its contents, not the rest of the task folder', () => {
    expect(isTaskInputArtifactPath('tasks/12/inputs/source/a.md')).toBe(true);
    expect(isTaskInputArtifactPath('tasks/12/inputs')).toBe(true);
    expect(isTaskInputArtifactPath('tasks/12/outline.md')).toBe(false);
    expect(isTaskInputArtifactPath('notes/inputs/x.md')).toBe(false);
  });

  it('counts moving or deleting the task folder as touching its inputs', () => {
    expect(touchesTaskInputArtifactPath('tasks/12')).toBe(true);
    expect(touchesTaskInputArtifactPath('tasks/12/inputs/source')).toBe(true);
    expect(touchesTaskInputArtifactPath('tasks/12/outline.md')).toBe(false);
  });

  it('names the reading tools of the drawer that holds the input', () => {
    expect(
      taskInputReadTools({ drawer: 'artifacts', kind: 'folder', hasOfficeDocuments: true }),
    ).toEqual(['list_artifacts', 'read_artifact', 'read_doc_as_markdown']);
    expect(taskInputReadTools({ drawer: 'workspace', kind: 'file' })).toEqual(['read_file']);
  });
});
