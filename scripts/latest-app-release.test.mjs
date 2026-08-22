import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReleaseListing,
  classifyBuilds,
  fetchLatestAppRelease,
  selectLatestAppRelease,
} from './latest-app-release.mjs';

const asset = (name, extra = {}) => ({
  name,
  size: 1000,
  browser_download_url: `https://github.com/bendyline/gezel/releases/download/v1.2.3/${name}`,
  ...extra,
});

test('the greatest stable app release is selected around other namespaces', () => {
  const selected = selectLatestAppRelease([
    { tag_name: '@bendyline/gezel-service@1.0.2', draft: false, prerelease: false },
    { tag_name: 'native-v0.1.36', draft: false, prerelease: true },
    { tag_name: 'v1.26214.29', draft: false, prerelease: false },
    { tag_name: 'v1.26212.27', draft: false, prerelease: false },
  ]);
  assert.equal(selected.tag, 'v1.26214.29');
  assert.equal(selected.version, '1.26214.29');
});

// This script normally runs with a maintainer token, and an authenticated
// listing includes drafts whose asset URLs 404 for every visitor. Publishing one
// would point the entire download section at files nobody can fetch.
test('a draft app release never reaches the site listing', () => {
  const selected = selectLatestAppRelease([
    { tag_name: 'v1.26233.54', draft: true, prerelease: false },
    { tag_name: 'v1.26231.53', draft: false, prerelease: false },
  ]);
  assert.equal(selected.tag, 'v1.26231.53');
});

test('prerelease and malformed tags are refused the way the updater refuses them', () => {
  assert.equal(selectLatestAppRelease([{ tag_name: 'v2.0.0', prerelease: true }]), null);
  for (const tag of ['1.26214.29', 'v1.26214', 'v1.26214.29-rc1', 'latest', 'v01.2.3']) {
    assert.equal(selectLatestAppRelease([{ tag_name: tag }]), null, `${tag} must not pass`);
  }
});

test('an invalid response body is rejected rather than treated as empty', () => {
  assert.throws(() => selectLatestAppRelease({ message: 'Not Found' }), /invalid response body/);
});

test('only real installers become builds, and arch names are normalized', () => {
  const builds = classifyBuilds([
    asset('Gezel-1.26231.53-mac-arm64.pkg'),
    asset('Gezel-1.26231.53-mac-arm64.zip'),
    asset('Gezel-1.26231.53-mac-arm64.zip.blockmap'),
    asset('Gezel-1.26231.53-windows-x64.exe'),
    asset('Gezel-1.26231.53-windows-x64.exe.blockmap'),
    asset('Gezel-1.26231.53-linux-amd64.deb'),
    asset('Gezel-1.26231.53-linux-aarch64.rpm'),
    asset('latest-mac.yml'),
    asset('gezel.cdx.json'),
    asset('SHA256SUMS'),
  ]);
  assert.deepEqual(
    builds.map((b) => `${b.platform}-${b.arch}-${b.format}`),
    ['linux-arm64-rpm', 'linux-x64-deb', 'mac-arm64-pkg', 'windows-x64-exe'],
  );
});

test('the listing carries the checksums file and the release notes link', () => {
  const listing = buildReleaseListing(
    {
      tag: 'v1.26231.53',
      version: '1.26231.53',
      record: {
        published_at: '2026-08-19T13:27:42Z',
        html_url: 'https://github.com/bendyline/gezel/releases/tag/v1.26231.53',
        assets: [asset('Gezel-1.26231.53-mac-arm64.pkg'), asset('SHA256SUMS')],
      },
    },
    { generatedAt: '2026-08-21T00:00:00.000Z' },
  );
  assert.equal(listing.schema, 1);
  assert.equal(listing.published, '2026-08-19T13:27:42Z');
  assert.match(listing.checksumsUrl, /SHA256SUMS$/);
  assert.equal(listing.notesUrl, 'https://github.com/bendyline/gezel/releases/tag/v1.26231.53');
  assert.equal(listing.releasesUrl, 'https://github.com/bendyline/gezel/releases');
  assert.equal(listing.builds.length, 1);
});

test('a release with no checksums file still publishes its builds', () => {
  const listing = buildReleaseListing({
    tag: 'v1.2.3',
    version: '1.2.3',
    record: { assets: [asset('Gezel-1.2.3-windows-x64.exe')] },
  });
  assert.equal(listing.checksumsUrl, null);
  assert.equal(listing.builds.length, 1);
});

test('paging continues past a page filled with npm package releases', async () => {
  const pages = {
    'https://api.github.com/repos/bendyline/gezel/releases?per_page=100': {
      link: '<https://api.github.com/page2>; rel="next"',
      body: [{ tag_name: '@bendyline/gezel@1.0.4' }, { tag_name: 'native-v0.1.36' }],
    },
    'https://api.github.com/page2': {
      link: '',
      body: [{ tag_name: 'v1.26231.53', draft: false, prerelease: false }],
    },
  };
  const requested = [];
  const selected = await fetchLatestAppRelease({
    fetch: async (url) => {
      requested.push(url);
      const page = pages[url];
      return {
        ok: true,
        headers: { get: (name) => (name === 'Link' ? page.link : null) },
        json: async () => page.body,
      };
    },
  });
  assert.equal(requested.length, 2);
  assert.equal(selected.tag, 'v1.26231.53');
});

test('paging stops at the page that has an app release', async () => {
  const requested = [];
  await fetchLatestAppRelease({
    fetch: async (url) => {
      requested.push(url);
      return {
        ok: true,
        headers: { get: (name) => (name === 'Link' ? '<https://next>; rel="next"' : null) },
        json: async () => [{ tag_name: 'v1.26231.53' }],
      };
    },
  });
  assert.equal(requested.length, 1);
});

test('an exhausted rate limit is reported as such', async () => {
  await assert.rejects(
    fetchLatestAppRelease({
      fetch: async () => ({
        ok: false,
        status: 403,
        headers: { get: (name) => (name === 'x-ratelimit-remaining' ? '0' : null) },
      }),
    }),
    /HTTP 403.*rate limit exhausted/,
  );
});
