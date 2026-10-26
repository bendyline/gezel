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
 *   2. Strip `devDependencies` and `scripts` from its `package.json`, then
 *      merge the manifest entry's `additionalDependencies` into dependencies.
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
        specifier: 1.0.103
        version: 1.0.103
      koffi:
        specifier: 3.2.1
        version: 3.2.1
      vscode-jsonrpc:
        specifier: 8.2.1
        version: 8.2.1
      zod:
        specifier: 4.3.6
        version: 4.3.6
    optionalDependencies:
      '@github/copilot-sdk-darwin-arm64':
        specifier: 1.0.26
        version: 1.0.26
      '@github/copilot-sdk-darwin-x64':
        specifier: 1.0.26
        version: 1.0.26
      '@github/copilot-sdk-linux-arm64':
        specifier: 1.0.26
        version: 1.0.26
      '@github/copilot-sdk-linux-x64':
        specifier: 1.0.26
        version: 1.0.26
      '@github/copilot-sdk-linuxmusl-arm64':
        specifier: 1.0.26
        version: 1.0.26
      '@github/copilot-sdk-linuxmusl-x64':
        specifier: 1.0.26
        version: 1.0.26
      '@github/copilot-sdk-win32-arm64':
        specifier: 1.0.26
        version: 1.0.26
      '@github/copilot-sdk-win32-x64':
        specifier: 1.0.26
        version: 1.0.26

packages:

  '@github/copilot-darwin-arm64@1.0.103':
    resolution: {integrity: sha512-5upfa7UdJJQbRRfyrYqaZ81xy0SSXba8HNRNwJYVw1NuONFFt3u7FzPBQJ/XpB/1m/YGPmmK4XRgITAF4oAu+A==}
    cpu: [arm64]
    os: [darwin]
    hasBin: true

  '@github/copilot-darwin-x64@1.0.103':
    resolution: {integrity: sha512-E0gt0Q4UyndutyT5bcEn8gBv7RiBJPkY2oOy4vvbF6nHZ8/+/FS0p7baIfOc6xTjJnS+3rfQ8ts9yCRKiSZa9Q==}
    cpu: [x64]
    os: [darwin]
    hasBin: true

  '@github/copilot-linux-arm64@1.0.103':
    resolution: {integrity: sha512-QK+rSoLxGD79qWpPGZBhV/9KB/yAOnfTkWsAAcRBdFRO3loSFO/bkKDb88aVrSMY/gue167gTOSpR2BWdFObjg==}
    cpu: [arm64]
    os: [linux]
    libc: [glibc]
    hasBin: true

  '@github/copilot-linux-x64@1.0.103':
    resolution: {integrity: sha512-9qNrzrecDTL4N94tPsxocXC1BJ+CykXGiwKQOdVYzpy26Jd43qLtGfYNIrrr4iQi9lAhQPp64Q5UDAkQ3JZgVw==}
    cpu: [x64]
    os: [linux]
    libc: [glibc]
    hasBin: true

  '@github/copilot-linuxmusl-arm64@1.0.103':
    resolution: {integrity: sha512-p73LRoSDABSPXX8EeiI/ZC9B30d0Zjp1lEEnG9+I19wh7uMq/V0H8Bi9ZISeAzSve49Bij9likpwGScgy2nw2w==}
    cpu: [arm64]
    os: [linux]
    libc: [musl]
    hasBin: true

  '@github/copilot-linuxmusl-x64@1.0.103':
    resolution: {integrity: sha512-bLP+ZMIZwXCAPZZ6TlwsazG8aVteD6hw9YXX023gz5BpjffbBfYCvkm7IEFHqhBL4ZeboA+WJ20OBA6qheEH/w==}
    cpu: [x64]
    os: [linux]
    libc: [musl]
    hasBin: true

  '@github/copilot-sdk-darwin-arm64@1.0.26':
    resolution: {integrity: sha512-mrEEEo82COE5AfbC+Ijo6bhe51fNTLL+GrlxFCxjW+pr2kzYqwx1KTDBBsZNNEWesZCo94N1xC38RKjnWrF4Jg==}
    cpu: [arm64]
    os: [darwin]

  '@github/copilot-sdk-darwin-x64@1.0.26':
    resolution: {integrity: sha512-MeIgQiesVSSluULCPOUWZ9M+B2lcwXsWejVYtDdj92Z2gstL3BaEJEzja26kDEH6waBTYEaR+82PKHggxNrjbw==}
    cpu: [x64]
    os: [darwin]

  '@github/copilot-sdk-linux-arm64@1.0.26':
    resolution: {integrity: sha512-hguGgZ9C60lP8zpzwhowfwHNQY/nNaIi6iCnKhE7NRQTlUoF69EwKVrdLe7n2u6qdyw1OiU2jd4+YzPTjBIBEQ==}
    cpu: [arm64]
    os: [linux]
    libc: [glibc]

  '@github/copilot-sdk-linux-x64@1.0.26':
    resolution: {integrity: sha512-6bXv+sBf80m7GnSvfdtpMqFqXhp8flLC3+HAVNxzONBb+jEqH1hypvtO5Q1OO3oe9wmOUWcUHoT6x00Gw9BEzQ==}
    cpu: [x64]
    os: [linux]
    libc: [glibc]

  '@github/copilot-sdk-linuxmusl-arm64@1.0.26':
    resolution: {integrity: sha512-amcznr+Ol8n6AVoUjwsep4YcMz0FlHy1e7fFBx2D9n2WT8D7CjJ/wXEP1FTmBfs5xixuPJNn6QpSrWHyWsZ7BQ==}
    cpu: [arm64]
    os: [linux]
    libc: [musl]

  '@github/copilot-sdk-linuxmusl-x64@1.0.26':
    resolution: {integrity: sha512-UMN9bzdAFFojldzIrEbZrMenU8p4ZVbDZAJGbUgYTm0g8Nw7i6Ot9qndI5frJshLsdQ8qxBiKt/mD+9rTL3RKg==}
    cpu: [x64]
    os: [linux]
    libc: [musl]

  '@github/copilot-sdk-win32-arm64@1.0.26':
    resolution: {integrity: sha512-JKaD2mj81mXntHJnHOA93hHOP2Bu9sQ5N4Z+WQq+c/cU2aTEtJXQjFraPf1m8q6sV4fQ2D6s62EisPx9qGbjcg==}
    cpu: [arm64]
    os: [win32]

  '@github/copilot-sdk-win32-x64@1.0.26':
    resolution: {integrity: sha512-j580HTGCmfzTCRmMO1Un3MiyhhHYfUH5P/AtvbO105lk0+u4ymnIuxxo/TxL5wG5lyEuRbBDmi3acSRJxtzwcw==}
    cpu: [x64]
    os: [win32]

  '@github/copilot-win32-arm64@1.0.103':
    resolution: {integrity: sha512-l7K5K6RDgPmdbaeQl2XjoByGYvvKgk2NPGlLxJOXsaCHLuiulbQbXUFa3c71Pty8e3J64viTqlokB+aLmMGkyw==}
    cpu: [arm64]
    os: [win32]
    hasBin: true

  '@github/copilot-win32-x64@1.0.103':
    resolution: {integrity: sha512-4UVN1vkK36ztFAynNtPKOSpeNUDe3m5LnsD0gTlmPZOayTA8a+/Mek3hf8xCpCrDpFs+GqmbhXeFgbXF61Glgg==}
    cpu: [x64]
    os: [win32]
    hasBin: true

  '@github/copilot@1.0.103':
    resolution: {integrity: sha512-wj2x08GpqPtNEbUDTlxX+RPjSEd2rTdD+Am0oH70xopdgcQoGufW+pnIW123pBqJ9U5m/cZv1eFk8owo/yZATw==}
    hasBin: true

  '@koromix/koffi-android-arm64@3.2.1':
    resolution: {integrity: sha512-1pJQ4jnZlUJduK9u9DC5CGy3aOgDUPvIXpNb6syV3+Dh5Q/ugezAIGCqvY+w+1mgXsve0pd0NVvJRjdZNHQ6MA==}
    cpu: [arm64]
    os: [android]

  '@koromix/koffi-android-x64@3.2.1':
    resolution: {integrity: sha512-HH40xGh3gVQifjOBnhwT2tECC0lL1lYe+nxHvWNSzxDIyQNcVPXg38ta7vuONRFpD+uIrw7fqGYLzbZIagkVcg==}
    cpu: [x64]
    os: [android]

  '@koromix/koffi-darwin-arm64@3.2.1':
    resolution: {integrity: sha512-Vj4h+xcjc5+Cn0DhPHjgRX4omKAv96Kehtcd+1YgYuY2W7FvQn9vS+3SmzVwhC5Qmg9bIwUZObYQ8T/4hBqQqA==}
    cpu: [arm64]
    os: [darwin]

  '@koromix/koffi-darwin-x64@3.2.1':
    resolution: {integrity: sha512-gFCWxNBTZIvxo1p+PURWfsy2Ctj5FGnVVs1f03lTLhBvmxEto70pdIiFztdFLDFkAJ1pmtQmruRKapeK+E8YPA==}
    cpu: [x64]
    os: [darwin]

  '@koromix/koffi-freebsd-arm64@3.2.1':
    resolution: {integrity: sha512-qj+f1s2e6vULaUG1cdlTcCXmunCq2t+rjxku1+esaMIqVnHpOwj0QzPuInG0AFdXjwBNQhyVR/HpDj8daEwwsQ==}
    cpu: [arm64]
    os: [freebsd]

  '@koromix/koffi-freebsd-ia32@3.2.1':
    resolution: {integrity: sha512-6olHb1Qfgai0jjs6ddlDDD0ZfsCxy7SPi8rMRpuYQWH0qhgtyQu82hw5b1p7z+TJ0zZP3ZeQQ6l+U/MlM1ICHQ==}
    cpu: [ia32]
    os: [freebsd]

  '@koromix/koffi-freebsd-x64@3.2.1':
    resolution: {integrity: sha512-Dikhw1ySYNVMkmeFvFVjnU5Wdk6mffNoOjJxm9bTG96vg7OlemylxqdEven47R1YJ3yzNVJn/MlQ207ORWfi2w==}
    cpu: [x64]
    os: [freebsd]

  '@koromix/koffi-linux-arm64@3.2.1':
    resolution: {integrity: sha512-K+cGUL5iBcDqxmsocrjmlASqDf24gc7artbVW3PewG2c9AqwC63lezgwvB85Nx4lZAQjB6zIFHh9A7t1yGbwhw==}
    cpu: [arm64]
    os: [linux]

  '@koromix/koffi-linux-arm@3.2.1':
    resolution: {integrity: sha512-OfwUwZylidq95wQKp6ClInULrfB2giu7dqM6Rhe0zAe6lES5I2SXNw15T9+GnRHk3/9hKT2XZ37OZLaKSyWNLA==}
    cpu: [arm]
    os: [linux]

  '@koromix/koffi-linux-ia32@3.2.1':
    resolution: {integrity: sha512-rxj6UYjU1qd98gxNQOSCdLpc5cPRi5Giq9rNd3jnGuSNIyMkwa6Dxw4cUjmhIBCYESMJtmNt5NWnJp5u9wTfYQ==}
    cpu: [ia32]
    os: [linux]

  '@koromix/koffi-linux-loong64@3.2.1':
    resolution: {integrity: sha512-aHhnHzkPRmT/IHDlGvESJ/Bs32m8N6UE6Ab6kMeJzgk74IN8af2m/81/wZJtybR1M2UxCV4NmlVNUYQQvSAO3Q==}
    cpu: [loong64]
    os: [linux]

  '@koromix/koffi-linux-riscv64@3.2.1':
    resolution: {integrity: sha512-qtQBsjbm3LiirLJvajWmKkNb7ARk7fvJVXdftJ7NtAnF3Xw8EbDvrtvmvtNI1yLPlYcBmlzCCD71hwhWYk0SIA==}
    cpu: [riscv64]
    os: [linux]

  '@koromix/koffi-linux-x64@3.2.1':
    resolution: {integrity: sha512-c7hw7Qs/r5gnFRTQLcbifBwRU7wiocj+2pVuDQ5Ahb3r36SZmupmgYbTWcLvTW+hul1jd7SKRV0d14ZJq/tvSw==}
    cpu: [x64]
    os: [linux]

  '@koromix/koffi-openbsd-ia32@3.2.1':
    resolution: {integrity: sha512-mmY8fY8LQ/CB52+h3yrMYmVyoxzW3x08S0yI6VNfHWdfU6yJtZkKCbhjmQCYMrWbYKC4gMvwZwCywIGPAkLyeA==}
    cpu: [ia32]
    os: [openbsd]

  '@koromix/koffi-openbsd-x64@3.2.1':
    resolution: {integrity: sha512-k4ig6aAPbFSRATOIIOfdf/KtlOGH4SVls6L9fy0QnTxRJYvY2oSltTsQtBDANgEQldlq8Kl5WnpRa1VSibP4Lw==}
    cpu: [x64]
    os: [openbsd]

  '@koromix/koffi-win32-arm64@3.2.1':
    resolution: {integrity: sha512-cTWBJGK//pDMeKQJE/79Aq9MiOAF4H8QyLZHSQ9IWm8czOfwjG4J1AhsQ9DjI9KFOykH77hhnpmQTGVMIubGig==}
    cpu: [arm64]
    os: [win32]

  '@koromix/koffi-win32-ia32@3.2.1':
    resolution: {integrity: sha512-Z50EM6TAZ7CFyMmyX6thv8eNpJchqe9eenhibSIy2Eq/FQYF76gU2VK/LEoaF46L8hfC7TpTp9b10MvReHEyFA==}
    cpu: [ia32]
    os: [win32]

  '@koromix/koffi-win32-x64@3.2.1':
    resolution: {integrity: sha512-ZmZNiBO6bkOSh3QNzgfvb1cMY0yMobn6ZQrSMqbAce21qyYL8niIbyipz9N/PIRDciGhsV0wUxnZsxIO+yWsHQ==}
    cpu: [x64]
    os: [win32]

  detect-libc@2.1.2:
    resolution: {integrity: sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==}
    engines: {node: '>=8'}

  koffi@3.2.1:
    resolution: {integrity: sha512-0qE3lZ8jllRqPN4Ob6Ajl7c2bJSJDhQWuKLGP5hIEpHLllJWv1ydHFMhHmHc5p/W9GticKVDbYzZd7TBoQ4CZg==}

  vscode-jsonrpc@8.2.1:
    resolution: {integrity: sha512-kdjOSJ2lLIn7r1rtrMbbNCHjyMPfRnowdKjBQ+mGq6NAW5QY2bEZC/khaC5OR8svbbjvLEaIXkOq45e2X9BIbQ==}
    engines: {node: '>=14.0.0'}

  zod@4.3.6:
    resolution: {integrity: sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg==}

snapshots:

  '@github/copilot-darwin-arm64@1.0.103':
    optional: true

  '@github/copilot-darwin-x64@1.0.103':
    optional: true

  '@github/copilot-linux-arm64@1.0.103':
    optional: true

  '@github/copilot-linux-x64@1.0.103':
    optional: true

  '@github/copilot-linuxmusl-arm64@1.0.103':
    optional: true

  '@github/copilot-linuxmusl-x64@1.0.103':
    optional: true

  '@github/copilot-sdk-darwin-arm64@1.0.26':
    optional: true

  '@github/copilot-sdk-darwin-x64@1.0.26':
    optional: true

  '@github/copilot-sdk-linux-arm64@1.0.26':
    optional: true

  '@github/copilot-sdk-linux-x64@1.0.26':
    optional: true

  '@github/copilot-sdk-linuxmusl-arm64@1.0.26':
    optional: true

  '@github/copilot-sdk-linuxmusl-x64@1.0.26':
    optional: true

  '@github/copilot-sdk-win32-arm64@1.0.26':
    optional: true

  '@github/copilot-sdk-win32-x64@1.0.26':
    optional: true

  '@github/copilot-win32-arm64@1.0.103':
    optional: true

  '@github/copilot-win32-x64@1.0.103':
    optional: true

  '@github/copilot@1.0.103':
    dependencies:
      detect-libc: 2.1.2
    optionalDependencies:
      '@github/copilot-darwin-arm64': 1.0.103
      '@github/copilot-darwin-x64': 1.0.103
      '@github/copilot-linux-arm64': 1.0.103
      '@github/copilot-linux-x64': 1.0.103
      '@github/copilot-linuxmusl-arm64': 1.0.103
      '@github/copilot-linuxmusl-x64': 1.0.103
      '@github/copilot-win32-arm64': 1.0.103
      '@github/copilot-win32-x64': 1.0.103

  '@koromix/koffi-android-arm64@3.2.1':
    optional: true

  '@koromix/koffi-android-x64@3.2.1':
    optional: true

  '@koromix/koffi-darwin-arm64@3.2.1':
    optional: true

  '@koromix/koffi-darwin-x64@3.2.1':
    optional: true

  '@koromix/koffi-freebsd-arm64@3.2.1':
    optional: true

  '@koromix/koffi-freebsd-ia32@3.2.1':
    optional: true

  '@koromix/koffi-freebsd-x64@3.2.1':
    optional: true

  '@koromix/koffi-linux-arm64@3.2.1':
    optional: true

  '@koromix/koffi-linux-arm@3.2.1':
    optional: true

  '@koromix/koffi-linux-ia32@3.2.1':
    optional: true

  '@koromix/koffi-linux-loong64@3.2.1':
    optional: true

  '@koromix/koffi-linux-riscv64@3.2.1':
    optional: true

  '@koromix/koffi-linux-x64@3.2.1':
    optional: true

  '@koromix/koffi-openbsd-ia32@3.2.1':
    optional: true

  '@koromix/koffi-openbsd-x64@3.2.1':
    optional: true

  '@koromix/koffi-win32-arm64@3.2.1':
    optional: true

  '@koromix/koffi-win32-ia32@3.2.1':
    optional: true

  '@koromix/koffi-win32-x64@3.2.1':
    optional: true

  detect-libc@2.1.2: {}

  koffi@3.2.1:
    optionalDependencies:
      '@koromix/koffi-android-arm64': 3.2.1
      '@koromix/koffi-android-x64': 3.2.1
      '@koromix/koffi-darwin-arm64': 3.2.1
      '@koromix/koffi-darwin-x64': 3.2.1
      '@koromix/koffi-freebsd-arm64': 3.2.1
      '@koromix/koffi-freebsd-ia32': 3.2.1
      '@koromix/koffi-freebsd-x64': 3.2.1
      '@koromix/koffi-linux-arm': 3.2.1
      '@koromix/koffi-linux-arm64': 3.2.1
      '@koromix/koffi-linux-ia32': 3.2.1
      '@koromix/koffi-linux-loong64': 3.2.1
      '@koromix/koffi-linux-riscv64': 3.2.1
      '@koromix/koffi-linux-x64': 3.2.1
      '@koromix/koffi-openbsd-ia32': 3.2.1
      '@koromix/koffi-openbsd-x64': 3.2.1
      '@koromix/koffi-win32-arm64': 3.2.1
      '@koromix/koffi-win32-ia32': 3.2.1
      '@koromix/koffi-win32-x64': 3.2.1

  vscode-jsonrpc@8.2.1: {}

  zod@4.3.6: {}
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
