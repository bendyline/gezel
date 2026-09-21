/** adb shell forwards a command string, so each user-supplied value needs shell quoting. */
export function androidInstrumentationCommand(arguments_: Record<string, string>): string {
  const argv = ['am', 'instrument', '-w', '-r'];
  for (const [name, value] of Object.entries(arguments_)) argv.push('-e', name, value);
  argv.push('com.bendyline.gezel.mobile.test/androidx.test.runner.AndroidJUnitRunner');
  return androidShellCommand(argv);
}

export function androidShellCommand(argv: string[]): string {
  return argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
}

export function requireAndroidStagingSpace(df: string, modelBytes: number): void {
  const columns = df.trim().split('\n').at(-1)?.trim().split(/\s+/);
  const available = Number(columns?.[3]) * 1024;
  const required = modelBytes * 2 + 64 * 1024 ** 2;
  if (!Number.isFinite(available) || available < required)
    throw new Error(
      `Android model import needs ${required} free bytes for staging and import; df reports ${available}.`,
    );
}

/** am instrument can exit zero for a failed test; require its complete JUnit result. */
export function instrumentationSucceeded(result: { code: number; stdout: string }): boolean {
  return (
    result.code === 0 &&
    /OK \(1 test\)/.test(result.stdout) &&
    /INSTRUMENTATION_CODE: -1/.test(result.stdout) &&
    !/FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|shortMsg=/.test(result.stdout)
  );
}
