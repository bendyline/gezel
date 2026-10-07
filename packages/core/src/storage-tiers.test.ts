import { describe, expect, it } from 'vitest';
import { storageTierFor } from './storage-tiers.js';

describe('storage tiers', () => {
  it('keeps the person’s work in Work', () => {
    for (const path of [
      'gezels/nadia/gezel.md',
      'gezels/nadia/sessions/a.json',
      'gezels/nadia/memories/daily/2026-10-01.md',
      'projects/default/project.json',
      'projects/default/workspace/notes.md',
      'projects/default/artifacts/tasks/3/report.md',
      'projects/default/artifacts/prompts/2026-10-01-0001/message.md',
      'projects/default/history.jsonl',
      'documents/guidelines.md',
      'memories/daily/2026-10-07.md',
      'tasks/history/1.json',
      'history.jsonl',
    ])
      expect(storageTierFor(path), path).toBe('work');
  });

  it('keeps settings, journals, engines and derived caches on the device', () => {
    for (const path of [
      '',
      'config.json',
      '.transactions/abc/journal.json',
      'runtime/port',
      'engines/llama-cpp/models/x.gguf',
      'logs/service-2026-10-01.log',
      'index/global.db',
      'gezels/nadia/memories/index/mem.db',
      'memories/index/mem.db',
      'projects/default/artifacts/shadow/report.docx_files/report.md',
      'projects/default/artifacts/tabular/sheet.xlsx_tables/tables/a',
      'projects/default/input-staging/x/meta.json',
      'projects/default/digest-state.json',
      'projects/default/workspace/.gezel/index/index.db',
    ])
      expect(storageTierFor(path), path).toBe('device');
  });
});
