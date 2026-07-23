/**
 * Checked-in pnpm lockfile fixtures for `SYSTEM_TOOLSETS` entries.
 *
 * Each entry pins not just the top-level package+integrity in the
 * manifest, but the complete transitive dep tree — this file is
 * spiritually our `package-lock.json` for the system-toolsets install
 * path. The bootstrap writes the appropriate lockfile next to the
 * extracted tarball's `package.json` before invoking
 * `pnpm install --prod --frozen-lockfile --ignore-scripts`, so every
 * user machine resolves to the exact same versions + integrities that
 * we signed off on at release time.
 *
 * To regenerate after bumping a manifest entry:
 *   1. Extract the new tarball to a scratch dir.
 *   2. Strip `devDependencies` and `scripts` from its `package.json`.
 *   3. `pnpm install --prod --lockfile-only --ignore-scripts`.
 *   4. Paste the generated `pnpm-lock.yaml` content into the string
 *      literal below (and update the key if the package name changed).
 */
export const SYSTEM_LOCKFILES: Record<string, string> = {
  '@github/copilot-sdk': `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@github/copilot':
        specifier: ^1.0.71
        version: 1.0.73
      koffi:
        specifier: ^3.1.0
        version: 3.1.2
      vscode-jsonrpc:
        specifier: ^8.2.1
        version: 8.2.1
      zod:
        specifier: ^4.3.6
        version: 4.4.3

packages:

  '@github/copilot-darwin-arm64@1.0.73':
    resolution: {integrity: sha512-5jv7t2sw35/zI0cPze38hG6239NT5/q/Emjx6gLibYkolDqMDJjpm17Ps7tc8oafUEOiMQMb+ar7+qi6rSiGJA==}
    cpu: [arm64]
    os: [darwin]
    hasBin: true

  '@github/copilot-darwin-x64@1.0.73':
    resolution: {integrity: sha512-l794k6Ahb11AG2FQT/P4TEWxWblzM1h8aQQCzG8jBWp8dfwjhyYjJ+d+0CWQzM3Fc1ddNUZRjKXCUsfvFjiZhQ==}
    cpu: [x64]
    os: [darwin]
    hasBin: true

  '@github/copilot-linux-arm64@1.0.73':
    resolution: {integrity: sha512-Zu0W5nupJjNeem0brqU/pG+VY0IWr6EWr/FsC90g5SEDiaM4VhVNVWcz8t0E3DQCSYetV6IBaNMtjs/3uIIiDQ==}
    cpu: [arm64]
    os: [linux]
    libc: [glibc]
    hasBin: true

  '@github/copilot-linux-x64@1.0.73':
    resolution: {integrity: sha512-k33XIr6/PVp+K+5F/zv3No4PPaNImvHz73mcbIw63oxh5iiacXjgr0WqbBIS5s/rkhOWjNPIkbof/TTPZ7mQjA==}
    cpu: [x64]
    os: [linux]
    libc: [glibc]
    hasBin: true

  '@github/copilot-linuxmusl-arm64@1.0.73':
    resolution: {integrity: sha512-HJWzhfD3oaiIgfRAHkNWzp17fELtshqM9HVN5n+lFEmSO2EETCEh0P1lhJc4m+FYfXSJnL0raAqVuyaNMuPoPw==}
    cpu: [arm64]
    os: [linux]
    libc: [musl]
    hasBin: true

  '@github/copilot-linuxmusl-x64@1.0.73':
    resolution: {integrity: sha512-/BpOXSb16wHEu8I1SaKiLszQ4Kvu4+Z4uCn7W0bv4xI4fPZwTEG0u3zgaI2W9Ao3+aBl0XRpPmpWzE9ziYEq+w==}
    cpu: [x64]
    os: [linux]
    libc: [musl]
    hasBin: true

  '@github/copilot-win32-arm64@1.0.73':
    resolution: {integrity: sha512-DbPeXiYzQjpOy9oboaBvuCzjRwfcL987c3bG09cK1crdCDrKfkTJ7NXpcp1KWRPIRFO1FQm1qToNE89J+L3uvg==}
    cpu: [arm64]
    os: [win32]
    hasBin: true

  '@github/copilot-win32-x64@1.0.73':
    resolution: {integrity: sha512-8D3E1l5i+N5Eq8HIOQpx+Zbcb3MXdFxszksM2gqq175Z1S7Zna67oY4GoR3psxlbIpSyHKiLEBWYiaps6ayHWw==}
    cpu: [x64]
    os: [win32]
    hasBin: true

  '@github/copilot@1.0.73':
    resolution: {integrity: sha512-8I2Ejg2CX/PQA3c2H8W1zuqhniCeR1q1/bD8CrV53/ZLw8GF7DAV0xQpwa8ELYvFgjXb6AADojafCKwdbVef+A==}
    hasBin: true

  '@koromix/koffi-darwin-arm64@3.1.2':
    resolution: {integrity: sha512-32pU4pNZABIz+l9DNJl51Y+jur4vv+SF4Ip2CSF4OUg1xUyefoLpX0NttDmzGITIrneUEVSEN+dT22524ESKBw==}
    cpu: [arm64]
    os: [darwin]

  '@koromix/koffi-darwin-x64@3.1.2':
    resolution: {integrity: sha512-S+H6LQgUoMj77BqDegwlRaxwLXDfwvSJGuceOqtH0I5V8rzKLmu/hC7NBlxOoAlvKlcV63FtdNiE2E9YSltffg==}
    cpu: [x64]
    os: [darwin]

  '@koromix/koffi-freebsd-arm64@3.1.2':
    resolution: {integrity: sha512-fD0ow2PBE60nw7K6xcbala6qwXxfcYeU62tduNeIPvx0KoWhU2rMKZiDNe+iI5TQb3rxYYjjP+aF2Sdm9y6EXQ==}
    cpu: [arm64]
    os: [freebsd]

  '@koromix/koffi-freebsd-ia32@3.1.2':
    resolution: {integrity: sha512-t8OmL+hoJGDLZDnuLjgLemSYrXX99M7Md+zJX8bMHOtiNbFtkGXn/mV21Pb1ik9JhBXjwK1r4hvBPNlqTMGrHg==}
    cpu: [ia32]
    os: [freebsd]

  '@koromix/koffi-freebsd-x64@3.1.2':
    resolution: {integrity: sha512-axbLgiM4Y2vyDOTqlXCI8vkg9wqjwSRsmoWXSKreA5YFJwnYA6Sc4aHMz+qZgUSfFei52Qrv1RGhDyo4kHvqhA==}
    cpu: [x64]
    os: [freebsd]

  '@koromix/koffi-linux-arm64@3.1.2':
    resolution: {integrity: sha512-f0hqAIlFcL9wlRGJ/uCfyfspqnGaASk2gLx1UAP3RBgMQl68D1e+fiHNdXa7g9d76ttmpA8/PGNAqc1X4Byy1Q==}
    cpu: [arm64]
    os: [linux]

  '@koromix/koffi-linux-ia32@3.1.2':
    resolution: {integrity: sha512-UGLPuqeOV/UArsK6oeB5yI/XjSWkFqFlBTC9rUbezBuHJhSibk1EMv7QC0cvtDMu18bo+ucqXWPzh42oT5yYlw==}
    cpu: [ia32]
    os: [linux]

  '@koromix/koffi-linux-loong64@3.1.2':
    resolution: {integrity: sha512-jI0+gM2oDsJ7reOt3XPyO7lyQtZ1CT6NR2uqGQcQVM43cyXBAVYYCUxEH3LHCbgumFaZ+LueIUgbMSwb9pHBxQ==}
    cpu: [loong64]
    os: [linux]

  '@koromix/koffi-linux-riscv64@3.1.2':
    resolution: {integrity: sha512-yB99adXBRd5T+xXG+f6nnUkC3jCI0iXvPU6RqD9Kx7aZP4Y4NNUWJ5Q4FaP9jb1XmZLY4pGBUiHt8u03Yl7NyA==}
    cpu: [riscv64]
    os: [linux]

  '@koromix/koffi-linux-x64@3.1.2':
    resolution: {integrity: sha512-Oxvo6F3Edzy/Jm2EtbHWkJ2xRB0mXDAe63k5+USL5uiGE5xZjwEUDOBKIhv2BpCZSOAJrfoojFFogj6+ICKQhw==}
    cpu: [x64]
    os: [linux]

  '@koromix/koffi-openbsd-ia32@3.1.2':
    resolution: {integrity: sha512-SSWzUhL8Ex84JTsO67+MdWZrdwgOzoOrQ0+ZbB+UsivHoAxmWLHKWZaSafNqyBZtxGY1EgtR8AIPouWE9U+Zfw==}
    cpu: [ia32]
    os: [openbsd]

  '@koromix/koffi-openbsd-x64@3.1.2':
    resolution: {integrity: sha512-0ZuI4St7chq3M0d3VivvKIqacZ7RhgohdR476V3HpJkaNdfIywsJIw+GBvqkQahu+4A2Rpu6yQJpWSrfk/Z+Jw==}
    cpu: [x64]
    os: [openbsd]

  '@koromix/koffi-win32-arm64@3.1.2':
    resolution: {integrity: sha512-8Wn6phw7y53uI52+aBPAqEfZ5pj/HCjg/YtdthqSWYHy+d0MhyASKlcmuP0B5raxQnnA1Bm9LC8UO3M3RojeBw==}
    cpu: [arm64]
    os: [win32]

  '@koromix/koffi-win32-ia32@3.1.2':
    resolution: {integrity: sha512-FkKaPBMawgHMNnp1FwLldXMNvEa139GXkxPi9JD9xU71Kh/ZmuEYHGSD6JwZDmDr4jekVrBrr+eGZ+j6C2mkXg==}
    cpu: [ia32]
    os: [win32]

  '@koromix/koffi-win32-x64@3.1.2':
    resolution: {integrity: sha512-FeFC59UU1XX4J3ZaqKrsrEzczzB5qksMJo7/R45vIg8mGNVSLMVE85JRiZpjcp9i5Lbav5Vw47QvwFzBgIfvlw==}
    cpu: [x64]
    os: [win32]

  detect-libc@2.1.2:
    resolution: {integrity: sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==}
    engines: {node: '>=8'}

  koffi@3.1.2:
    resolution: {integrity: sha512-wVwuE21TBl8/si6E0hPorKR2PJ2q33mEWVETANrtSp3kFM8fi2FcD/J5wmxu0T4TBcqmMQ4xKuF1X1ayFmphzw==}

  vscode-jsonrpc@8.2.1:
    resolution: {integrity: sha512-kdjOSJ2lLIn7r1rtrMbbNCHjyMPfRnowdKjBQ+mGq6NAW5QY2bEZC/khaC5OR8svbbjvLEaIXkOq45e2X9BIbQ==}
    engines: {node: '>=14.0.0'}

  zod@4.4.3:
    resolution: {integrity: sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==}

snapshots:

  '@github/copilot-darwin-arm64@1.0.73':
    optional: true

  '@github/copilot-darwin-x64@1.0.73':
    optional: true

  '@github/copilot-linux-arm64@1.0.73':
    optional: true

  '@github/copilot-linux-x64@1.0.73':
    optional: true

  '@github/copilot-linuxmusl-arm64@1.0.73':
    optional: true

  '@github/copilot-linuxmusl-x64@1.0.73':
    optional: true

  '@github/copilot-win32-arm64@1.0.73':
    optional: true

  '@github/copilot-win32-x64@1.0.73':
    optional: true

  '@github/copilot@1.0.73':
    dependencies:
      detect-libc: 2.1.2
    optionalDependencies:
      '@github/copilot-darwin-arm64': 1.0.73
      '@github/copilot-darwin-x64': 1.0.73
      '@github/copilot-linux-arm64': 1.0.73
      '@github/copilot-linux-x64': 1.0.73
      '@github/copilot-linuxmusl-arm64': 1.0.73
      '@github/copilot-linuxmusl-x64': 1.0.73
      '@github/copilot-win32-arm64': 1.0.73
      '@github/copilot-win32-x64': 1.0.73

  '@koromix/koffi-darwin-arm64@3.1.2':
    optional: true

  '@koromix/koffi-darwin-x64@3.1.2':
    optional: true

  '@koromix/koffi-freebsd-arm64@3.1.2':
    optional: true

  '@koromix/koffi-freebsd-ia32@3.1.2':
    optional: true

  '@koromix/koffi-freebsd-x64@3.1.2':
    optional: true

  '@koromix/koffi-linux-arm64@3.1.2':
    optional: true

  '@koromix/koffi-linux-ia32@3.1.2':
    optional: true

  '@koromix/koffi-linux-loong64@3.1.2':
    optional: true

  '@koromix/koffi-linux-riscv64@3.1.2':
    optional: true

  '@koromix/koffi-linux-x64@3.1.2':
    optional: true

  '@koromix/koffi-openbsd-ia32@3.1.2':
    optional: true

  '@koromix/koffi-openbsd-x64@3.1.2':
    optional: true

  '@koromix/koffi-win32-arm64@3.1.2':
    optional: true

  '@koromix/koffi-win32-ia32@3.1.2':
    optional: true

  '@koromix/koffi-win32-x64@3.1.2':
    optional: true

  detect-libc@2.1.2: {}

  koffi@3.1.2:
    optionalDependencies:
      '@koromix/koffi-darwin-arm64': 3.1.2
      '@koromix/koffi-darwin-x64': 3.1.2
      '@koromix/koffi-freebsd-arm64': 3.1.2
      '@koromix/koffi-freebsd-ia32': 3.1.2
      '@koromix/koffi-freebsd-x64': 3.1.2
      '@koromix/koffi-linux-arm64': 3.1.2
      '@koromix/koffi-linux-ia32': 3.1.2
      '@koromix/koffi-linux-loong64': 3.1.2
      '@koromix/koffi-linux-riscv64': 3.1.2
      '@koromix/koffi-linux-x64': 3.1.2
      '@koromix/koffi-openbsd-ia32': 3.1.2
      '@koromix/koffi-openbsd-x64': 3.1.2
      '@koromix/koffi-win32-arm64': 3.1.2
      '@koromix/koffi-win32-ia32': 3.1.2
      '@koromix/koffi-win32-x64': 3.1.2

  vscode-jsonrpc@8.2.1: {}

  zod@4.4.3: {}
`,
  '@playwright/mcp': `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      playwright:
        specifier: 1.62.0-alpha-1783623505000
        version: 1.62.0-alpha-1783623505000
      playwright-core:
        specifier: 1.62.0-alpha-1783623505000
        version: 1.62.0-alpha-1783623505000

packages:

  fsevents@2.3.2:
    resolution: {integrity: sha512-xiqMQR4xAeHTuB9uWm+fFRcIOgKBMiOBP+eXiyT7jsgVCq1bkVygt00oASowB7EdtpOHaaPgKt812P9ab+DDKA==}
    engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
    os: [darwin]

  playwright-core@1.62.0-alpha-1783623505000:
    resolution: {integrity: sha512-CPJZdsA/KGT2QQlekiV6Wt+QlQrZHVSZ6oiNtOI/bYYOIVLM8jfKGWTM4zQiyd4UN+40Cq4cA6lxmZHZbtPvJQ==}
    engines: {node: '>=20'}
    hasBin: true

  playwright@1.62.0-alpha-1783623505000:
    resolution: {integrity: sha512-6KV9h4PP3hqu4NaGdxxcijWfYh9LJcFI/R2sP4TTC4I5cFo3oRawN0ETlW5MkE3cQEgKhhoj0KUNz4sfpCT0Tg==}
    engines: {node: '>=20'}
    hasBin: true

snapshots:

  fsevents@2.3.2:
    optional: true

  playwright-core@1.62.0-alpha-1783623505000: {}

  playwright@1.62.0-alpha-1783623505000:
    dependencies:
      playwright-core: 1.62.0-alpha-1783623505000
    optionalDependencies:
      fsevents: 2.3.2
`,
};
