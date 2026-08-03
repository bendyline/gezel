import { describe, expect, it } from 'vitest';
import { closestFileNames } from './near-miss.js';

const DIR = ['customers_a.csv', 'customers_b.csv', 'legacy_export.csv', 'README.md'];

describe('closestFileNames', () => {
  it('resolves every wild-caught dot-mangle to the real file', () => {
    // The exact args gemma4-12b emitted while a sampler artifact suppressed
    // the literal dot — each got a bare "not found" and the trial died in
    // 47s. Every one must map back to its real neighbor.
    const mangles: Array<[string, string]> = [
      ['customers_a,csv', 'customers_a.csv'],
      ['customers_b_csv', 'customers_b.csv'],
      ['customers_b\\.csv', 'customers_b.csv'],
      ['customers_b\\\\.csv', 'customers_b.csv'],
      ['customers_b->csv', 'customers_b.csv'],
      ['legacy_export_csv', 'legacy_export.csv'],
      ['legacy_export\\.csv', 'legacy_export.csv'],
      ['legacy_export,csv', 'legacy_export.csv'],
      ['legacy_export?csv', 'legacy_export.csv'],
      ['legacy_export%2Ecsv', 'legacy_export.csv'],
    ];
    for (const [typed, want] of mangles) {
      expect(closestFileNames(typed, DIR)[0], `for ${JSON.stringify(typed)}`).toBe(want);
    }
  });

  it('falls back to common-prefix ranking for stem typos', () => {
    expect(closestFileNames('customers_c.csv', DIR)[0]).toMatch(/^customers_/);
  });

  it('returns nothing when nothing is close', () => {
    expect(closestFileNames('zzz.txt', DIR)).toEqual([]);
    expect(closestFileNames('', DIR)).toEqual([]);
  });

  it('caps suggestions at the limit', () => {
    const many = ['a_file1.ts', 'a_file2.ts', 'a_file3.ts', 'a_file4.ts'];
    expect(closestFileNames('a_file.ts', many)).toHaveLength(3);
  });
});
