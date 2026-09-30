import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateOfficeCa, issueOfficeLeaf } from './tls-identity.js';

/**
 * The Windows uninstaller removes this CA from the user's Root store with a
 * PowerShell filter embedded in packages/app/installer/nsis-hooks.nsh. It
 * used to match `Subject -like 'CN=Gezel Office Local CA*'`, but Windows
 * prints the RDNs last-first ("O=Gezel, CN=…"), so it never matched and every
 * uninstall left the CA trusted. Run the hook's own filter against a CA made
 * by the real generator, in the PowerShell the uninstaller uses.
 */
const windowsOnly = process.platform === 'win32' ? it : it.skip;

async function hookFilter(): Promise<string> {
  const hook = await readFile(
    resolve(import.meta.dirname, '..', '..', '..', 'app', 'installer', 'nsis-hooks.nsh'),
    'utf8',
  );
  const match = /Cert:\\CurrentUser\\Root \| Where-Object \{(.*?)\} \| Remove-Item/.exec(hook);
  if (!match?.[1]) throw new Error('uninstall CA filter not found in nsis-hooks.nsh');
  // NSIS writes a literal PowerShell `$` as `$$`.
  return match[1].replaceAll('$$', '$');
}

function matchesFilter(filter: string, pemPath: string): { matched: boolean; subject: string } {
  const script = [
    `$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('${pemPath}')`,
    `$hit = @($c | Where-Object {${filter}}).Count -gt 0`,
    `Write-Output "MATCH=$hit"`,
    'Write-Output ("SUBJECT=" + $c.Subject)',
  ].join('; ');
  const result = spawnSync(
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr || 'powershell failed');
  return {
    matched: /MATCH=True/.test(result.stdout),
    subject: /SUBJECT=(.*)/.exec(result.stdout)?.[1]?.trim() ?? '',
  };
}

describe('the uninstaller Office CA filter', () => {
  windowsOnly(
    'matches the Office CA as Windows presents it, and nothing it issued',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'gezel-uninstall-ca-'));
      try {
        const now = new Date();
        const ca = await generateOfficeCa({ now, label: 'uninstall-test' });
        const leaf = await issueOfficeLeaf({ now, ca });
        const caPath = join(dir, 'ca.pem');
        const leafPath = join(dir, 'leaf.pem');
        await writeFile(caPath, ca.certPem);
        await writeFile(leafPath, leaf.certPem);
        const filter = await hookFilter();

        const onCa = matchesFilter(filter, caPath);
        expect(onCa.subject).toMatch(/^O=Gezel, CN=Gezel Office Local CA/);
        expect(onCa.matched).toBe(true);
        expect(matchesFilter(filter, leafPath).matched).toBe(false);
        // The pattern it replaced, on the same certificate.
        expect(matchesFilter("$_.Subject -like 'CN=Gezel Office Local CA*'", caPath).matched).toBe(
          false,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
