#!/usr/bin/env node
/**
 * Assert that a staged `gezel-service-host.exe` was compiled from source that
 * still matches this checkout's launch contract.
 *
 * Why this exists. The Windows service host is the only place the machine
 * daemon's environment is declared — `GEZEL_SERVICE_ROLE`, `GEZEL_HOME`,
 * `GEZEL_SYSTEM_SCOPE` and friends are compiled into the binary rather than
 * configured by the installer. But the binary is not built from this
 * checkout: it arrives from a separately-tagged `native-v*` release, pinned
 * in `packages/service/src/engines/native-file-manifest.json`. So a change to
 * `main.cpp` and the binary that actually ships can silently disagree
 * whenever the pin is not bumped.
 *
 * That is not hypothetical. v1.26217.38 added `GEZEL_SERVICE_ROLE=machine-engine`
 * to `env_overrides()` and shipped against `native-v0.1.29`, cut four days
 * earlier. Every Windows machine service therefore launched its daemon with no
 * role at all, silently resolved to the full-product `legacy-full` compatibility
 * mode instead of the inference-only broker, and served the product API under a
 * credential every local account can read. The service-split feature of that
 * release simply never engaged, on the one platform it was written for.
 *
 * Nothing caught it. The installer was correct, the signature was valid, the
 * hash matched the native release, and the binary's own `--self-test` passed —
 * it is compiled from the same stale source, so it asserts the stale contract.
 * The binary also carries no version resource, so `ProductVersion` is blank and
 * old cannot be told from new by inspection.
 *
 * The check that does work is the crude one: the compiled binary stores its
 * `L"..."` literals as UTF-16LE in `.rdata`, so the keys are greppable. This
 * derives the required set from `main.cpp` rather than hardcoding it, so
 * adding an override to the source automatically tightens the gate.
 *
 *   node scripts/verify-service-host-contract.mjs <path-to-gezel-service-host.exe>
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN_CPP = join(here, '..', 'native', 'helpers', 'service-host', 'src', 'main.cpp');

/**
 * Pull the override keys, and the literal values that name a role, out of
 * `env_overrides()`. Values are only required when they are a fixed literal
 * that the daemon branches on — a path built from `instdir` at runtime is not
 * a string constant we can look for.
 */
export function requiredLiteralsFromSource(source) {
  const body = /std::vector<EnvEntry>\s+env_overrides\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(source);
  if (!body) throw new Error('could not locate env_overrides() in main.cpp');
  const keys = new Set();
  const values = new Set();
  // Keys are always wide literals; values may be an expression built from
  // `home`/`instdir` at runtime (`{L"GEZEL_HOME", home}`), so capture the
  // value side loosely and only pin it when it is a bare literal.
  for (const [, key, rawValue] of body[1].matchAll(/\{L"([^"]+)",\s*([^}]+)\}/g)) {
    keys.add(key);
    const literal = /^L"([^"]*)"$/.exec(rawValue.trim());
    if (!literal) continue;
    const value = literal[1];
    // Worth pinning: a value the daemon actually dispatches on, like the role
    // name. Bare flags ("1") carry no drift signal, and path fragments are
    // composed at runtime.
    if (value && !value.includes('\\') && !/^\d+$/.test(value)) values.add(value);
  }
  if (keys.size === 0) throw new Error('env_overrides() declared no literal keys');
  return { keys: [...keys].sort(), values: [...values].sort() };
}

/** UTF-16LE, the encoding a wide string literal lands in. */
export function binaryContainsWide(buffer, needle) {
  return buffer.includes(Buffer.from(needle, 'utf16le'));
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: verify-service-host-contract.mjs <path-to-gezel-service-host.exe>');
    process.exit(2);
  }
  const [binary, source] = await Promise.all([
    readFile(resolve(target)),
    readFile(MAIN_CPP, 'utf8'),
  ]);
  const { keys, values } = requiredLiteralsFromSource(source);

  const missing = [...keys, ...values].filter((literal) => !binaryContainsWide(binary, literal));
  if (missing.length > 0) {
    for (const line of [
      `${target} was built from source that predates this checkout.`,
      `missing from the compiled binary: ${missing.join(', ')}`,
      'The pinned native release is stale. Cut a native-v* release from this commit,',
      're-pin it with scripts/pin-native-release.mjs, and rebuild.',
    ]) {
      console.error(`[service-host] ${line}`);
    }
    process.exit(1);
  }
  console.log(
    `[service-host] launch contract intact — ${keys.length} env keys and ${values.length} literal values present`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`[service-host] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
