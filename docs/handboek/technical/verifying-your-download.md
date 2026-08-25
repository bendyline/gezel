---
id: verifying-your-download
title: "Verifying your download"
order: 6
summary: Checking that the installer you downloaded is the one we published.
subcategory:
  id: how-gezel-works
  title: How Gezel works
  order: 1
---
# Verifying your download

Every Gezel release publishes two things alongside the installers so you can
check that what landed on your disk is exactly what we built: a list of
checksums, and a cryptographic record of the build itself.

Most people never need to run these. On macOS and Windows the operating system
already checks our signature before it lets the installer run — that is what
Gatekeeper and SmartScreen are doing when you open it. **Linux is the case
where this page matters**, because `.deb` and `.rpm` files carry no signature
that your package manager checks, so the checks below are the only verification
available there.

They are also worth running on any platform if you downloaded through a mirror,
a proxy, a corporate network you do not control, or anywhere else you would
rather confirm than assume.

## The two checks

**`SHA256SUMS`** lists a fingerprint for every file in the release. Recomputing
the fingerprint of your download and comparing it proves the bytes arrived
intact and unaltered. It is quick, needs no account, and works offline once you
have the file.

**Build provenance** is a signed statement, published to a public transparency
log, saying that these exact bytes came out of Gezel's own build pipeline —
naming the source commit, the workflow, and the run that produced them. It is a
stronger claim than a checksum, because a checksum only tells you your copy
matches the list; provenance tells you where the list's contents came from.

Both are published for **every** file in the release, `SHA256SUMS` included.

## Checking the fingerprint

Download `SHA256SUMS` from the same release page as your installer, put it next
to the file you downloaded, and run the command for your system. Filenames below
carry a version number — use the one you actually downloaded.

`--ignore-missing` matters: `SHA256SUMS` covers every platform's installer and
you have only downloaded one. Without the flag you get a wall of "No such file"
errors and an overall failure that means nothing.

**Linux**

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

**macOS**

```bash
shasum -a 256 --ignore-missing -c SHA256SUMS
```

**Windows** (PowerShell, from the folder holding both files)

```powershell
$file     = 'Gezel-1.26237.59-windows-x64.exe'
$expected = ((Select-String -Path SHA256SUMS -Pattern $file).Line -split '\s+')[0]
$actual   = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
if ($actual -eq $expected) { 'OK' } else { 'MISMATCH — do not run this file' }
```

You want to see `OK` next to your filename. Anything else — a `FAILED` line, a
`MISMATCH` — means the file is not what we published. Delete it and download it
again rather than trying to repair it.

## Checking where the build came from

This one needs the [GitHub CLI](https://cli.github.com) and a GitHub account.
The command reads a public transparency log, but `gh` itself has to be signed
in, so run `gh auth login` once first — any free account will do.

```bash
gh attestation verify Gezel-1.26237.59-linux-amd64.deb --repo bendyline/gezel
```

Substitute whichever file you downloaded. A silent exit means it verified; `gh`
only speaks up when something is wrong. To see the detail it confirmed:

```bash
gh attestation verify Gezel-1.26237.59-linux-amd64.deb --repo bendyline/gezel --format json
```

The interesting fields are `sourceRepositoryURI` (should be
`https://github.com/bendyline/gezel`), `buildSignerURI` (the release workflow),
and `sourceRepositoryDigest` (the commit the release was built from).

## What this does and does not tell you

A passing check tells you the file is byte-for-byte the artifact our release
pipeline produced from a named commit in a public repository. Nobody modified
it in transit, and it was not built on someone's laptop.

It does not tell you the software is free of bugs, and it does not replace
reading what Gezel actually does with your data — [the security
model](security-model.md) covers that. It also cannot help if you downloaded
from somewhere other than our releases page: a checksum file that travelled
with a bad installer proves only that the two agree with each other. Get
`SHA256SUMS` from
[the release you are installing](https://github.com/bendyline/gezel/releases),
not from a mirror.

## A note on Linux packages

Our `.deb` and `.rpm` files are not GPG-signed. That is a deliberate choice
rather than an oversight, and it reflects how the ecosystem actually works:
`dpkg` does not verify signatures on standalone `.deb` files at all — in the
Debian world that trust comes from a signed repository, not the package — and
the other major applications distributed this way take the same approach.

The consequence is that the two checks on this page are the real verification
story for Linux, which is why they are documented rather than buried. If we
later publish an apt or yum repository, signing arrives with it.
