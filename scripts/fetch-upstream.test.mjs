import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function runFixture({
  failCommand,
  failures = 1,
  initiallyShallow = false,
  maxAttempts = 3,
}) {
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
    printf '%s' "$FAKE_GIT_INITIAL_SHALLOW" > "$FAKE_GIT_STATE_PREFIX.shallow"
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
  config)
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
    if [[ "$command" == "fetch" && " $* " == *" --unshallow "* ]]; then
      printf 'false' > "$FAKE_GIT_STATE_PREFIX.shallow"
    fi
    ;;
  rev-parse)
    if [[ "\${1:-}" == "--is-shallow-repository" ]]; then
      cat "$FAKE_GIT_STATE_PREFIX.shallow"
      printf '\\n'
    else
      printf '%s\\n' "$FAKE_GIT_COMMIT"
    fi
    ;;
  rev-list)
    printf '%s\\n' "$FAKE_GIT_BUILD_NUMBER"
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
      FAKE_GIT_BUILD_NUMBER: '1',
      FAKE_GIT_COMMIT: pinnedCommit,
      FAKE_GIT_FAIL_COMMAND: failCommand,
      FAKE_GIT_FAILURES: String(failures),
      FAKE_GIT_INITIAL_SHALLOW: String(initiallyShallow),
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

async function runAncestryFixture({ initiallyShallow = false, tag = 'b3', build } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gezel-fetch-ancestry-'));
  const upstream = join(root, 'upstream');
  const script = join(root, 'native', 'scripts', 'fetch-upstream.sh');
  const engineDir = join(root, 'native', 'engines', 'llama-cpp');

  await mkdir(upstream, { recursive: true });
  runGit(upstream, ['init']);
  runGit(upstream, ['config', 'user.name', 'Gezel Test']);
  runGit(upstream, ['config', 'user.email', 'gezel-test@example.invalid']);
  runGit(upstream, ['config', 'uploadpack.allowFilter', 'true']);
  runGit(upstream, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  for (let index = 1; index <= 3; index += 1) {
    await writeFile(join(upstream, 'payload.txt'), `revision ${index}\n`);
    runGit(upstream, ['add', 'payload.txt']);
    runGit(upstream, ['commit', '-m', `revision ${index}`]);
  }
  runGit(upstream, ['tag', tag]);
  const commit = runGit(upstream, ['rev-parse', 'HEAD']);

  await mkdir(join(root, 'native', 'scripts'), { recursive: true });
  await mkdir(engineDir, { recursive: true });
  await copyFile(sourceScript, script);
  await chmod(script, 0o755);
  const buildLine = build === undefined ? '' : `build=${build}\n`;
  await writeFile(
    join(engineDir, 'VERSION'),
    `upstream=${pathToFileURL(upstream).href}\ntag=${tag}\n${buildLine}commit=${commit}\n`,
  );
  if (initiallyShallow) {
    runGit(root, [
      'clone',
      '--depth',
      '1',
      '--no-tags',
      pathToFileURL(upstream).href,
      join(engineDir, '.upstream'),
    ]);
  }

  const result = spawnSync(bashPath(), [shellPath(script), 'llama-cpp'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GEZEL_FETCH_MAX_ATTEMPTS: '3',
      GEZEL_FETCH_RETRY_DELAY_SECONDS: '0',
    },
    timeout: 10_000,
  });

  return {
    checkout: join(engineDir, '.upstream'),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
    commit,
    result,
  };
}

function countCommand(log, command) {
  return log.split(/\r?\n/).filter((line) => new RegExp(`(?:^| )${command}(?: |$)`).test(line))
    .length;
}

test('fetch-upstream filters file history while retaining ancestry and retrying fetch', async () => {
  const fixture = await runFixture({ failCommand: 'fetch' });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(countCommand(fixture.gitLog, 'fetch'), 2);
    assert.match(
      fixture.gitLog,
      new RegExp(`fetch --force --tags --filter=tree:0 origin ${pinnedCommit}`),
    );
    assert.doesNotMatch(fixture.gitLog, /(?:^| )clone(?: |$)/m);
    const fetchLines = fixture.gitLog
      .split(/\r?\n/)
      .filter((line) => /(?:^| )fetch(?: |$)/.test(line));
    assert.ok(fetchLines.every((line) => !/(?:^| )--depth(?: |$)/.test(line)));
    assert.match(fixture.gitLog, /config remote\.origin\.promisor true/);
    assert.match(fixture.gitLog, /config remote\.origin\.partialclonefilter tree:0/);
    assert.match(fixture.result.stderr, /fetching pinned fixture commit failed on attempt 1\/3/);
    assert.match(fixture.result.stdout, new RegExp(`fixture ready at ${pinnedCommit}`));
  } finally {
    await fixture.cleanup();
  }
});

test('fetch-upstream retries the filtered checkout tree hydration', async () => {
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

test('fetch-upstream unshallows an existing checkout before building', async () => {
  const fixture = await runFixture({ failCommand: 'none', initiallyShallow: true });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(
      fixture.gitLog,
      new RegExp(`fetch --force --tags --unshallow --filter=tree:0 origin ${pinnedCommit}`),
    );
    assert.match(fixture.result.stdout, new RegExp(`fixture ready at ${pinnedCommit}`));
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

test('fetch-upstream preserves real ancestry and llama build-number semantics', async () => {
  const fixture = await runAncestryFixture();
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(runGit(fixture.checkout, ['rev-parse', '--is-shallow-repository']), 'false');
    assert.equal(runGit(fixture.checkout, ['rev-list', '--count', 'HEAD']), '3');
    assert.equal(runGit(fixture.checkout, ['rev-parse', 'HEAD']), fixture.commit);
    assert.match(fixture.result.stdout, /llama\.cpp build number verified: 3 \(b3\)/);
  } finally {
    await fixture.cleanup();
  }
});

test('fetch-upstream restores ancestry in a real shallow checkout', async () => {
  const fixture = await runAncestryFixture({ initiallyShallow: true });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(runGit(fixture.checkout, ['rev-parse', '--is-shallow-repository']), 'false');
    assert.equal(runGit(fixture.checkout, ['rev-list', '--count', 'HEAD']), '3');
    assert.match(fixture.result.stdout, /llama\.cpp build number verified: 3 \(b3\)/);
  } finally {
    await fixture.cleanup();
  }
});

test('fetch-upstream verifies a semver llama tag against its declared build number', async () => {
  const fixture = await runAncestryFixture({ tag: 'v0.3.0', build: 3 });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.result.stdout, /llama\.cpp build number verified: 3 \(v0\.3\.0\)/);
  } finally {
    await fixture.cleanup();
  }
});

test('fetch-upstream refuses a semver llama tag with no declared build number', async () => {
  const fixture = await runAncestryFixture({ tag: 'v0.3.0' });
  try {
    assert.equal(fixture.result.status, 1);
    assert.match(
      fixture.result.stderr,
      /llama\.cpp tag v0\.3\.0 is not a b<number> tag, so .* must declare build=<number>/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('fetch-upstream rejects a declared build number that contradicts a b#### tag', async () => {
  const fixture = await runAncestryFixture({ tag: 'b3', build: 4 });
  try {
    assert.equal(fixture.result.status, 1);
    assert.match(fixture.result.stderr, /declares build=4 but tag b3 implies 3/);
  } finally {
    await fixture.cleanup();
  }
});

test('fetch-upstream rejects a llama tag that disagrees with the commit graph', async () => {
  const fixture = await runAncestryFixture({ tag: 'b4' });
  try {
    assert.equal(fixture.result.status, 1);
    assert.match(
      fixture.result.stderr,
      /llama\.cpp tag b4 requires build number 4, but git ancestry reports 3/,
    );
  } finally {
    await fixture.cleanup();
  }
});
