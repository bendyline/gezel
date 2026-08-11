import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceScript = fileURLToPath(new URL('../native/scripts/fetch-upstream.sh', import.meta.url));
const pinnedCommit = '1111111111111111111111111111111111111111';

function bashPath() {
  if (process.platform !== 'win32') return 'bash';
  for (const candidate of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}

function shellPath(path) {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
}

async function runFixture({ failCommand, failures = 1, maxAttempts = 3 }) {
  const root = await mkdtemp(join(tmpdir(), 'gezel-fetch-upstream-'));
  const script = join(root, 'native', 'scripts', 'fetch-upstream.sh');
  const engineDir = join(root, 'native', 'engines', 'fixture');
  const fakeGit = join(root, 'fake-git');
  const log = join(root, 'git.log');
  const statePrefix = join(root, 'git-state');

  await mkdir(join(root, 'native', 'scripts'), { recursive: true });
  await mkdir(engineDir, { recursive: true });
  await copyFile(sourceScript, script);
  await chmod(script, 0o755);
  await writeFile(
    join(engineDir, 'VERSION'),
    `upstream=https://example.invalid/upstream.git\ntag=test-pin\ncommit=${pinnedCommit}\n`,
  );
  await writeFile(
    fakeGit,
    `#!/usr/bin/env bash
set -euo pipefail

printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
workdir=""
if [[ "\${1:-}" == "-C" ]]; then
  workdir="$2"
  shift 2
fi
command="\${1:-}"
shift || true

case "$command" in
  init)
    mkdir -p "$workdir/.git"
    ;;
  remote)
    case "\${1:-}" in
      get-url)
        [[ -f "$workdir/.origin" ]] || exit 2
        cat "$workdir/.origin"
        ;;
      add|set-url)
        printf '%s' "$3" > "$workdir/.origin"
        ;;
    esac
    ;;
  fetch|checkout|submodule)
    state="$FAKE_GIT_STATE_PREFIX.$command"
    count=0
    [[ ! -f "$state" ]] || count="$(cat "$state")"
    count=$((count + 1))
    printf '%s' "$count" > "$state"
    if [[ "$command" == "$FAKE_GIT_FAIL_COMMAND" && "$count" -le "$FAKE_GIT_FAILURES" ]]; then
      echo "fatal: schannel: SEC_E_UNTRUSTED_ROOT" >&2
      exit 128
    fi
    ;;
  rev-parse)
    printf '%s\\n' "$FAKE_GIT_COMMIT"
    ;;
  *)
    echo "unexpected fake git command: $command $*" >&2
    exit 3
    ;;
esac
`,
    { mode: 0o755 },
  );
  await chmod(fakeGit, 0o755);

  const result = spawnSync(bashPath(), [shellPath(script), 'fixture'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GEZEL_FETCH_GIT_BIN: shellPath(fakeGit),
      GEZEL_FETCH_MAX_ATTEMPTS: String(maxAttempts),
      GEZEL_FETCH_RETRY_DELAY_SECONDS: '0',
      FAKE_GIT_COMMIT: pinnedCommit,
      FAKE_GIT_FAIL_COMMAND: failCommand,
      FAKE_GIT_FAILURES: String(failures),
      FAKE_GIT_LOG: shellPath(log),
      FAKE_GIT_STATE_PREFIX: shellPath(statePrefix),
    },
    timeout: 10_000,
  });

  return {
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
    gitLog: existsSync(log) ? await readFile(log, 'utf8') : '',
    result,
  };
}

function countCommand(log, command) {
  return log.split(/\r?\n/).filter((line) => new RegExp(`(?:^| )${command}(?: |$)`).test(line))
    .length;
}

test('fetch-upstream shallow-fetches the exact pin and retries a transient fetch failure', async () => {
  const fixture = await runFixture({ failCommand: 'fetch' });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(countCommand(fixture.gitLog, 'fetch'), 2);
    assert.match(
      fixture.gitLog,
      new RegExp(`fetch --force --tags --depth 1 origin ${pinnedCommit}`),
    );
    assert.doesNotMatch(fixture.gitLog, /(?:^| )clone(?: |$)|--filter=/m);
    assert.match(fixture.result.stderr, /fetching pinned fixture commit failed on attempt 1\/3/);
    assert.match(fixture.result.stdout, new RegExp(`fixture ready at ${pinnedCommit}`));
  } finally {
    await fixture.cleanup();
  }
});

test('fetch-upstream retries checkout for legacy promisor repositories', async () => {
  const fixture = await runFixture({ failCommand: 'checkout' });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(countCommand(fixture.gitLog, 'fetch'), 1);
    assert.equal(countCommand(fixture.gitLog, 'checkout'), 2);
    assert.match(
      fixture.result.stderr,
      /checking out pinned fixture commit failed on attempt 1\/3/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('fetch-upstream stops after its bounded attempt budget', async () => {
  const fixture = await runFixture({ failCommand: 'fetch', failures: 3, maxAttempts: 2 });
  try {
    assert.equal(fixture.result.status, 128);
    assert.equal(countCommand(fixture.gitLog, 'fetch'), 2);
    assert.match(
      fixture.result.stderr,
      /fetching pinned fixture commit failed after 2 attempt\(s\)/,
    );
  } finally {
    await fixture.cleanup();
  }
});
