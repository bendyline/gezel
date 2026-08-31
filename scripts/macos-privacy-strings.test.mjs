/**
 * macOS privacy usage strings must describe what Gezel actually does.
 *
 * electron-builder injects five stock usage descriptions into every macOS
 * app ("This app needs access to the camera", …). A July 2026 audit found
 * them shipping verbatim in v1.26211.23, which had Gezel asking for hardware
 * it never touches. `mac.extendInfo` now nulls them out.
 *
 * That removal is only safe while the claim behind it holds, and it has a
 * sharp edge: macOS *terminates* an app that touches the microphone or camera
 * with no usage string, so the failure mode of getting this wrong is a crash
 * on a user's machine rather than a bad sentence. This test is the interlock.
 * Add a capture API and it fails until you also write real copy for the key.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/**
 * Each capture API, and the Info.plist key macOS requires before it may be
 * called. Matched against source text, so a commented-out reference counts —
 * deliberately: this should fail loudly and be resolved by a human, not
 * silently guess at intent.
 */
const CAPTURE_APIS = [
  { pattern: /\bgetUserMedia\b/, key: 'NSMicrophoneUsageDescription', api: 'getUserMedia' },
  { pattern: /\bMediaRecorder\b/, key: 'NSMicrophoneUsageDescription', api: 'MediaRecorder' },
  {
    pattern: /\bnavigator\.mediaDevices\b/,
    key: 'NSMicrophoneUsageDescription',
    api: 'navigator.mediaDevices',
  },
  {
    pattern: /\baskForMediaAccess\b/,
    key: 'NSMicrophoneUsageDescription',
    api: 'systemPreferences.askForMediaAccess',
  },
  {
    pattern: /\bgetDisplayMedia\b|\bdesktopCapturer\b/,
    key: 'NSAudioCaptureUsageDescription',
    api: 'screen/system-audio capture',
  },
  {
    pattern: /\bnavigator\.bluetooth\b/,
    key: 'NSBluetoothAlwaysUsageDescription',
    api: 'Web Bluetooth',
  },
];

/** Stock electron-builder copy — never acceptable in a shipped build. */
const PLACEHOLDERS = [/^This app needs access to /i, /^\s*$/];

const SOURCE_ROOTS = [
  join(root, 'packages', 'ui', 'src'),
  join(root, 'packages', 'app', 'src'),
  join(root, 'packages', 'service', 'src'),
];

async function collectSources(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...(await collectSources(path)));
    } else if (/\.(ts|tsx|cjs|mjs)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Values under `mac.extendInfo`, as `key -> string | null`. */
function macExtendInfo(builderYml) {
  const macBlock = builderYml.slice(builderYml.indexOf('\nmac:'));
  const start = macBlock.indexOf('\n  extendInfo:');
  if (start === -1) return null;
  const rest = macBlock.slice(start + '\n  extendInfo:'.length);
  const entries = {};
  for (const line of rest.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const match = /^ {4}([A-Za-z0-9]+):\s*(.*)$/.exec(line);
    if (!match) break; // dedented out of the block
    const raw = (match[2] ?? '').trim();
    entries[match[1]] =
      raw === 'null' || raw === '~' || raw === '' ? null : raw.replace(/^['"]|['"]$/g, '');
  }
  return entries;
}

test('macOS usage strings match what Gezel actually does', async () => {
  const builder = await readFile(join(root, 'packages', 'app', 'electron-builder.yml'), 'utf8');
  const extendInfo = macExtendInfo(builder);
  assert.ok(extendInfo, 'mac.extendInfo is missing — the stock privacy strings would ship again');

  const files = (await Promise.all(SOURCE_ROOTS.map(collectSources))).flat();
  const sources = await Promise.all(
    files.map(async (f) => ({ f, text: await readFile(f, 'utf8') })),
  );

  const captureByKey = new Map();
  for (const { pattern, key, api } of CAPTURE_APIS) {
    const users = sources.filter(({ text }) => pattern.test(text)).map(({ f }) => f);
    const group = captureByKey.get(key) ?? { apis: [], users: [] };
    group.apis.push(api);
    group.users.push(...users);
    captureByKey.set(key, group);
  }

  // Several APIs can require the same plist key (getUserMedia,
  // MediaRecorder, and askForMediaAccess all map to microphone usage). The
  // declaration is justified when ANY API in that group is used; evaluating
  // each pattern independently would demand that the same key be both present
  // and absent as soon as one of its sibling APIs is introduced.
  for (const [key, { apis, users }] of captureByKey) {
    const declared = extendInfo[key];
    if (users.length === 0) {
      // Nothing uses it, so the key must stay removed rather than claim reach
      // the product does not have.
      assert.equal(
        declared,
        null,
        `${key} is declared but nothing calls ${apis.join(', ')}. Remove it (set it to null) or a privacy reviewer will see a claim the app cannot justify.`,
      );
      continue;
    }
    assert.ok(
      typeof declared === 'string' && declared.length > 0,
      `${apis.join('/')} is used in ${users[0]} but ${key} is not set. macOS terminates an app that touches this without a usage string — add real copy to mac.extendInfo.`,
    );
    for (const placeholder of PLACEHOLDERS) {
      assert.ok(
        !placeholder.test(declared),
        `${key} is still electron-builder's placeholder ("${declared}"). Write copy that says what Gezel does with it and where the data goes.`,
      );
    }
  }
});
