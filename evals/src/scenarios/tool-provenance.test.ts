import { describe, expect, it } from 'vitest';
import {
  provenanceShellOverwritesPath,
  provenanceShellReadPrecedesMutation,
  provenanceToolMutatesPath,
  provenanceToolReadsPath,
} from './tool-provenance.ts';

describe('CLI shell tool provenance', () => {
  it('recognizes every path in a successful batch read', () => {
    const read = {
      name: 'read_files',
      success: true,
      path: 'state/config.json',
      paths: ['state/config.json', 'state/backup.json'],
    };

    expect(provenanceToolReadsPath(read, 'state/config.json')).toBe(true);
    expect(provenanceToolReadsPath(read, 'state/backup.json')).toBe(true);
    expect(provenanceToolReadsPath(read, 'runbook.md')).toBe(false);
  });

  it('does not credit paths from a failed batch read', () => {
    expect(
      provenanceToolReadsPath(
        {
          name: 'read_files',
          success: false,
          paths: ['state/config.json', 'state/backup.json'],
        },
        'state/backup.json',
      ),
    ).toBe(false);
  });

  it('recognizes successful shell reads and heredoc writes', () => {
    const read = {
      name: 'shell',
      success: true,
      argsFull: "command: /bin/bash -lc 'cat memo-product.md; cat finance.csv'",
    };
    const write = {
      name: 'shell',
      success: true,
      argsFull: 'command: /bin/bash -lc "cat > synthesis.md <<\'EOF\'\ncontent\nEOF"',
    };

    expect(provenanceToolReadsPath(read, 'memo-product.md')).toBe(true);
    expect(provenanceToolReadsPath(read, 'finance.csv')).toBe(true);
    expect(provenanceToolMutatesPath(write, 'synthesis.md')).toBe(true);
  });

  it('does not count failed calls or a filename merely mentioned in content', () => {
    expect(
      provenanceToolReadsPath(
        { name: 'shell', success: false, argsFull: 'command: cat memo-product.md' },
        'memo-product.md',
      ),
    ).toBe(false);
    expect(
      provenanceToolMutatesPath(
        {
          name: 'shell',
          success: true,
          argsFull: "command: cat > notes.md <<'EOF'\nsynthesis.md should be updated\nEOF",
        },
        'synthesis.md',
      ),
    ).toBe(false);
  });

  it('preserves read-before-write order inside one shell call', () => {
    const call = {
      name: 'shell',
      success: true,
      argsFull:
        'command: /bin/bash -lc "cat runbook.md; cat state/backup.json; cat > halt-report.md <<\'EOF\'\nstopped\nEOF"',
    };

    expect(provenanceShellReadPrecedesMutation(call, 'runbook.md', 'halt-report.md')).toBe(true);
    expect(provenanceShellReadPrecedesMutation(call, 'state/backup.json', 'halt-report.md')).toBe(
      true,
    );
  });

  it('recognizes a bounded Python pathlib rewrite', () => {
    const call = {
      name: 'shell',
      success: true,
      argsFull:
        "command: p=Path('halt-report.md')\ns=p.read_text()\np.write_text(s.replace('old','new'))",
    };

    expect(provenanceToolMutatesPath(call, 'halt-report.md')).toBe(true);
  });

  it('recognizes a direct Python pathlib write after reads in the same call', () => {
    const call = {
      name: 'shell',
      success: true,
      argsFull:
        "command: runbook = Path('runbook.md').read_text()\nbackup = Path('state/backup.json').read_text()\nPath('runlog.md').write_text(backup)",
    };

    expect(provenanceToolMutatesPath(call, 'runlog.md')).toBe(true);
    expect(provenanceShellOverwritesPath(call, 'runlog.md')).toBe(true);
    expect(provenanceShellReadPrecedesMutation(call, 'runbook.md', 'runlog.md')).toBe(true);
    expect(provenanceShellReadPrecedesMutation(call, 'state/backup.json', 'runlog.md')).toBe(true);
  });

  it('distinguishes full overwrites from appends', () => {
    expect(
      provenanceShellOverwritesPath(
        { name: 'shell', success: true, argsFull: "command: cat > runlog.md <<'EOF'" },
        'runlog.md',
      ),
    ).toBe(true);
    expect(
      provenanceShellOverwritesPath(
        { name: 'shell', success: true, argsFull: "command: cat >> runlog.md <<'EOF'" },
        'runlog.md',
      ),
    ).toBe(false);
  });
});
