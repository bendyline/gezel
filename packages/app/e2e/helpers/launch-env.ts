/**
 * Build the env object for `electron.launch({ env })` in E2E tests.
 *
 * Why this helper exists: the obvious-looking pattern
 *
 *   env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_NO_ATTACH_CONSOLE: '' }
 *
 * does NOT actually disable those Electron-internal env switches when
 * the parent shell already exports them (CI, dev shell, pnpm, etc.).
 * The reason is two layers deep:
 *
 *   1. Playwright's `envObjectToArray` only drops keys whose value is
 *      `undefined`. Empty string `''` survives the conversion and is
 *      passed through to the spawn call.
 *
 *   2. Electron's native bootstrap reads these vars via C `getenv()`.
 *      `getenv("ELECTRON_RUN_AS_NODE")` returns a non-null pointer to
 *      `""` when the var is set-but-empty, and the gate is a plain
 *      `if (getenv(...))` — which is truthy. So Electron decides to
 *      run as Node, and Node then rejects Playwright's
 *      `--remote-debugging-port=0` flag with "bad option", failing
 *      every E2E test before the first window opens.
 *
 * Removing the keys from the env object entirely (not setting them to
 * an empty string) is the only way to actually unset them in the
 * spawned Electron process.
 *
 * Pass the test-specific overrides as `extras`; they merge over the
 * scrubbed `process.env` clone.
 */
export function buildLaunchEnv(extras: Record<string, string>): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _ern, ELECTRON_NO_ATTACH_CONSOLE: _enac, ...base } = process.env;
  // GEZEL_E2E=1 flips the macOS Electron app into `accessory` activation
  // policy (see main.ts) — windows render and Playwright can drive
  // them, but the app doesn't grab the dock or steal focus while you
  // work in another app. Ordinary specs also use the checkout's Node/pnpm
  // instead of reinstalling the bundled runtimes into every fresh test home.
  // Packaged launches ignore this development-only bypass, and the dedicated
  // supervisor-spawn spec overrides it to retain cold-provisioning coverage.
  return {
    ...base,
    GEZEL_E2E: '1',
    GEZEL_SKIP_BUNDLED_RUNTIME_INSTALL: '1',
    // The embedded service shares Electron's process, whose execPath points
    // at electron.exe rather than Node. Script-backed project pages still
    // need a real development Node binary after provisioning is skipped.
    // Packaged connectOrStart clears this and installs the verified bundle.
    GEZEL_NODE_PATH: process.execPath,
    ...extras,
  };
}
