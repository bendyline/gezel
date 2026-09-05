import type { GezelClient } from '@bendyline/gezel-client';
import { GezelApiError } from '@bendyline/gezel-client';
import { describe, expect, it, vi } from 'vitest';
import { createProjectContentContainer } from './artifacts-container.js';
import { createDocumentsContentContainer } from './documents-container.js';

const endpoints = {
  workspace: [
    'readProjectWorkspaceFile',
    'fetchProjectWorkspaceBlob',
    'writeProjectWorkspaceFile',
    'writeProjectWorkspaceBinary',
    'rmProjectWorkspacePath',
    'listProjectWorkspace',
  ],
  artifacts: [
    'readProjectArtifact',
    'fetchProjectArtifactBlob',
    'writeProjectArtifact',
    'writeProjectArtifactBinary',
    'deleteProjectArtifact',
    'listProjectArtifacts',
  ],
  library: [
    'readDocument',
    'fetchDocumentBlob',
    'writeDocument',
    'writeDocumentBinary',
    'deleteDocument',
    'listDocuments',
  ],
} as const;

describe.each(['workspace', 'artifacts', 'library'] as const)(
  '%s container authority',
  (source) => {
    it('routes every operation through only its own scope and preserves binary bytes', async () => {
      const calls = Object.fromEntries(
        Object.values(endpoints)
          .flat()
          .map((name) => [name, vi.fn()]),
      );
      const [read, blob, write, binary, remove, list] = endpoints[source];
      calls[read]!.mockResolvedValue({ content: 'hello' });
      const bytes = new Uint8Array([0, 128, 255]);
      calls[blob]!.mockResolvedValue(new Blob([bytes]));
      calls[list]!.mockResolvedValue({
        files: [
          { path: 'notes/brief_files/index.md', isDirectory: false },
          { path: 'notes/other_files/index.md', isDirectory: false },
          { path: 'notes/brief_files/folder', isDirectory: true },
        ],
      });
      const options = {
        client: calls as unknown as GezelClient,
        root: 'notes/brief_files',
        referencePrefix: 'brief_files',
      };
      const container =
        source === 'library'
          ? createDocumentsContentContainer(options)
          : createProjectContentContainer({ ...options, projectId: 'project', source });
      expect(await container.readDocument()).toBe('hello');
      expect(await container.getDocumentPath()).toBe('index.md');
      const entries = await container.listFiles();
      expect(entries.map((entry) => entry.path)).toEqual(['index.md']);
      expect(new Uint8Array((await container.readFile('brief_files/picture.png'))!)).toEqual(bytes);
      await container.writeDocument('updated');
      await container.writeFile('brief_files/picture.png', bytes);
      await container.removeFile('brief_files/picture.png');
      const leading = source === 'library' ? [] : ['project'];
      expect(calls[binary]).toHaveBeenCalledWith(
        ...leading,
        'notes/brief_files/picture.png',
        bytes,
        'image/png',
      );
      expect(calls[write]).toHaveBeenCalledWith(
        ...leading,
        ...(source === 'workspace'
          ? [{ path: 'notes/brief_files/index.md', content: 'updated' }]
          : ['notes/brief_files/index.md', 'updated']),
      );
      expect(calls[remove]).toHaveBeenCalledWith(
        ...leading,
        'notes/brief_files/picture.png',
        ...(source === 'workspace' ? [{ recursive: true }] : []),
      );
      for (const other of Object.keys(endpoints) as (keyof typeof endpoints)[]) {
        if (other !== source)
          for (const endpoint of endpoints[other]) expect(calls[endpoint]).not.toHaveBeenCalled();
      }
      calls[read]!.mockRejectedValue(new GezelApiError('denied', 403));
      await expect(container.readFile('index.md')).rejects.toMatchObject({ status: 403 });
    });
  },
);
