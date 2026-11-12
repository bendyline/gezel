import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const knowledge = vi.hoisted(() => ({
  findDuckdbBinary: vi.fn(async (): Promise<string | null> => null),
  exportCatalogParquet: vi.fn(async (_options: { duckdb: { binaryPath: string } }) => ({
    catalogId: 'field-notes',
    version: '1.0.0',
    files: [],
    duckdbVersion: '1.5.5',
  })),
}));

vi.mock('@bendyline/gezel-knowledge', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...knowledge,
}));

const { runKnowledgeExportParquet } = await import('./knowledge-command.js');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-export-parquet-'));
  vi.stubEnv('GEZEL_HOME', join(dir, 'home'));
  vi.stubEnv('GEZEL_DUCKDB_BIN', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  knowledge.exportCatalogParquet.mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('gezel knowledge export-parquet without DuckDB', () => {
  it('names the command that downloads DuckDB, not a desktop feature', async () => {
    const error = await runKnowledgeExportParquet(dir, {}).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error?.name).toBe('CliError');
    expect(error?.message).toContain('gezel native install --engine duckdb');
    expect(error?.message).toContain('--download');
    expect(error?.message).not.toContain('data feature');
    expect(knowledge.exportCatalogParquet).not.toHaveBeenCalled();
  });

  it('downloads DuckDB with --download and exports with it', async () => {
    const fetchDuckdb = vi.fn(async () => join(dir, 'engines', 'duckdb', 'duckdb.exe'));
    await runKnowledgeExportParquet(dir, { out: join(dir, 'out') }, { fetchDuckdb });
    expect(fetchDuckdb).toHaveBeenCalledOnce();
    expect(knowledge.exportCatalogParquet.mock.calls[0]?.[0].duckdb.binaryPath).toBe(
      join(dir, 'engines', 'duckdb', 'duckdb.exe'),
    );
  });

  it('downloads nothing when DuckDB is already on this computer', async () => {
    knowledge.findDuckdbBinary.mockResolvedValueOnce('/usr/local/bin/duckdb');
    const fetchDuckdb = vi.fn(async () => undefined);
    await runKnowledgeExportParquet(dir, { out: join(dir, 'out') }, { fetchDuckdb });
    expect(fetchDuckdb).not.toHaveBeenCalled();
    expect(knowledge.exportCatalogParquet.mock.calls[0]?.[0].duckdb.binaryPath).toBe(
      '/usr/local/bin/duckdb',
    );
  });
});
