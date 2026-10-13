import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import test from 'node:test';

import {
  MARKER_FILE,
  assertWipeableLocation,
  liveInstancePid,
  parseAppNewArgs,
  resetHome,
} from './app-new.mjs';

const userHome = resolve(tmpdir(), 'app-new-user');

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-app-new-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('defaults to a wiped ~/.gezel-new and accepts --keep and --home', () => {
  const other = resolve(tmpdir(), 'app-new-other');
  assert.deepEqual(parseAppNewArgs([], userHome), {
    home: join(userHome, '.gezel-new'),
    keep: false,
  });
  assert.deepEqual(parseAppNewArgs(['--', '--keep'], userHome), {
    home: join(userHome, '.gezel-new'),
    keep: true,
  });
  assert.equal(parseAppNewArgs([`--home=${other}`], userHome).home, other);
  assert.equal(parseAppNewArgs(['--home', other], userHome).home, other);
  assert.equal(parseAppNewArgs(['--home=~/fresh'], userHome).home, join(userHome, 'fresh'));
});

test('rejects relative homes, a missing --home value, and unknown flags', () => {
  assert.throws(() => parseAppNewArgs(['--home=fresh'], userHome), /absolute path/);
  assert.throws(() => parseAppNewArgs(['--home'], userHome), /absolute path/);
  assert.throws(() => parseAppNewArgs(['--wipe'], userHome), /unknown argument --wipe/);
});

test('never targets a real home, the repo, or anything containing them', () => {
  const opts = { userHome, repoRoot: join(userHome, 'gh', 'gezel') };
  const refused = [
    userHome,
    join(userHome, '.gezel'),
    join(userHome, '.gezel-dev'),
    join(userHome, 'gh'),
    parse(userHome).root,
  ];
  for (const target of refused) {
    assert.throws(() => assertWipeableLocation(target, opts), /refusing to use/, target);
  }
  assert.doesNotThrow(() => assertWipeableLocation(join(userHome, '.gezel-new'), opts));
  assert.doesNotThrow(() => assertWipeableLocation(resolve(tmpdir(), 'gezel-new'), opts));
});

test('wipes a home it created, and refuses one it did not', () => {
  withTempDir((dir) => {
    const ours = join(dir, 'ours');
    resetHome(ours);
    writeFileSync(join(ours, 'config.json'), '{}');
    resetHome(ours);
    assert.equal(existsSync(join(ours, 'config.json')), false);
    assert.equal(existsSync(join(ours, MARKER_FILE)), true);

    const foreign = join(dir, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'config.json'), '{}');
    assert.throws(() => resetHome(foreign), /not created by pnpm app:new/);
    assert.equal(existsSync(join(foreign, 'config.json')), true);

    const empty = join(dir, 'empty');
    mkdirSync(empty);
    resetHome(empty);
    assert.equal(existsSync(join(empty, MARKER_FILE)), true);
  });
});

test('finds a live instance through the runtime lock', () => {
  withTempDir((home) => {
    assert.equal(
      liveInstancePid(home, () => true),
      null,
    );
    mkdirSync(join(home, 'runtime'));
    writeFileSync(join(home, 'runtime', 'lock'), '4242\n');
    assert.equal(
      liveInstancePid(home, (pid) => pid === 4242),
      4242,
    );
    assert.equal(
      liveInstancePid(home, () => false),
      null,
    );
  });
});

test(
  'finds a live Electron instance through its singleton lock',
  { skip: process.platform === 'win32' && 'Chromium uses a lock file, not a symlink, on Windows' },
  () => {
    withTempDir((home) => {
      mkdirSync(join(home, '.electron-userdata'));
      symlinkSync('host.local-5151', join(home, '.electron-userdata', 'SingletonLock'));
      assert.equal(
        liveInstancePid(home, (pid) => pid === 5151),
        5151,
      );
    });
  },
);
