/**
 * Compile the Windows installer's permission helper (installer/windows/*.cs)
 * into gezel-acl.exe.
 *
 * The compiler is the C# compiler that .NET Framework 4.8 ships inside every
 * supported Windows, the same one PowerShell's Add-Type used when the
 * installer compiled this code during the install. Building it here instead
 * lets the afterPack sweep Authenticode-sign it with the rest of the payload,
 * and leaves no PowerShell in the install path for a Group Policy execution
 * policy or App Control's Constrained Language Mode to refuse.
 *
 * Usage: node scripts/build-installer-security.cjs [outFile]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER_NAME = 'gezel-acl.exe';
const SOURCE_DIR = path.join(__dirname, '..', 'installer', 'windows');
const SOURCES = ['GezelAcl.cs', 'ResetTreeAcl.cs', 'GrantServiceSid.cs'];
const DEFAULT_OUT_FILE = path.join(__dirname, '..', 'dist', 'installer-security', HELPER_NAME);

function findCompiler(env = process.env) {
  const windows = env.SystemRoot || env.windir || env.WINDIR || 'C:\\Windows';
  for (const framework of ['Framework64', 'Framework']) {
    const csc = path.join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(csc)) return csc;
  }
  return null;
}

function compileInstallerSecurity(outFile = DEFAULT_OUT_FILE) {
  if (process.platform !== 'win32') {
    throw new Error(
      `[installer-security] ${HELPER_NAME} is compiled with the Windows .NET Framework compiler; package Windows targets on Windows`,
    );
  }
  const csc = findCompiler();
  if (!csc) {
    throw new Error(
      '[installer-security] the .NET Framework 4 C# compiler (csc.exe) was not found',
    );
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.rmSync(outFile, { force: true });
  const result = spawnSync(
    csc,
    [
      '-nologo',
      '-target:exe',
      '-platform:anycpu',
      '-optimize+',
      `-out:${outFile}`,
      ...SOURCES.map((source) => path.join(SOURCE_DIR, source)),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(outFile)) {
    throw new Error(
      `[installer-security] csc exited ${result.status}:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return outFile;
}

module.exports = {
  HELPER_NAME,
  DEFAULT_OUT_FILE,
  SOURCES,
  findCompiler,
  compileInstallerSecurity,
};

if (require.main === module) {
  const built = compileInstallerSecurity(process.argv[2] ?? DEFAULT_OUT_FILE);
  console.log(`[installer-security] built ${built}`);
}
