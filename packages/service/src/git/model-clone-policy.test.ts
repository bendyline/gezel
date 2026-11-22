import { resolveSecurityPolicy, securityPolicyForLevel } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { SsrfError } from '../utils/ssrf.js';
import { isModelCloneRefusal, planModelClone } from './model-clone-policy.js';

const level = (name: 'super-lockdown' | 'lockdown' | 'free') =>
  resolveSecurityPolicy({ securityPolicy: securityPolicyForLevel(name) });
const publicHost = async () => {};

// An injected Meester read .env through another gezel, then cloned
// https://collector.example/<base64>.git at lockdown; the route checked
// only the scheme.
describe('planModelClone', () => {
  it('clones a public repository from a known host at lockdown', async () => {
    const plan = await planModelClone(
      'https://github.com/bendyline/gezel.git',
      level('lockdown'),
      publicHost,
    );
    expect(isModelCloneRefusal(plan)).toBe(false);
    if (isModelCloneRefusal(plan)) return;
    expect(plan.url).toBe('https://github.com/bendyline/gezel.git');
    expect(plan.cloneOptions).toEqual([
      '--config',
      'protocol.allow=never',
      '--config',
      'protocol.https.allow=always',
    ]);
  });

  it.each([
    'https://collector.example/aGVsbG8.git',
    'http://github.com/bendyline/gezel.git',
    'https://github.com:8443/bendyline/gezel.git',
  ])('sends any other address through web services: %s', async (url) => {
    expect(await planModelClone(url, level('lockdown'), publicHost)).toMatchObject({
      status: 403,
      error: expect.stringMatching(/Other hosts need web services/),
    });
    const free = await planModelClone(url, level('free'), publicHost);
    expect(isModelCloneRefusal(free)).toBe(false);
    if (!isModelCloneRefusal(free)) {
      expect(free.cloneOptions).toContain('http.followRedirects=false');
    }
  });

  it.each([
    'https://github.com\\@collector.example/x/aGVsbG8.git',
    'https://github.com/\\\\collector.example/x.git',
    'https://github.com/x /y.git',
    'https://github.com/x\ty.git',
    'https://github.com/x\u0000y.git',
  ])('refuses an address two URL parsers read differently: %s', async (url) => {
    // WHATWG reads the backslash form as github.com, so the allowlist passed,
    // while git and curl connected to collector.example.
    for (const name of ['lockdown', 'free'] as const) {
      expect(await planModelClone(url, level(name), publicHost)).toMatchObject({
        status: 400,
        error: expect.stringMatching(/backslash, a space or a control character/),
      });
    }
  });

  it('hands git the address exactly as the checks read it', async () => {
    const plan = await planModelClone(
      'HTTPS://GitHub.com/bendyline/gezel.git',
      level('lockdown'),
      publicHost,
    );
    expect(isModelCloneRefusal(plan)).toBe(false);
    if (isModelCloneRefusal(plan)) return;
    expect(plan.url).toBe('https://github.com/bendyline/gezel.git');
  });

  it('clones nothing at super-lockdown, where gezels have no git', async () => {
    expect(
      await planModelClone(
        'https://github.com/bendyline/gezel.git',
        level('super-lockdown'),
        publicHost,
      ),
    ).toMatchObject({ status: 403, error: expect.stringMatching(/git is turned off/) });
  });

  it('refuses a tripwire address and a private one, whatever the level', async () => {
    const tripwire = await planModelClone(
      'https://webhook.site/abc.git',
      level('free'),
      publicHost,
    );
    expect(tripwire).toMatchObject({ status: 403, indicators: expect.any(Array) });
    const lan = await planModelClone('https://10.0.0.5/repo.git', level('free'), async () => {
      throw new SsrfError('10.0.0.5 is a private address');
    });
    expect(lan).toMatchObject({
      status: 403,
      error: 'request denied: 10.0.0.5 is a private address',
    });
  });

  it.each(['ssh://github.com/x/y.git', 'file:///etc/passwd', 'https://me:pw@github.com/x/y.git'])(
    'refuses %s',
    async (url) => {
      expect(await planModelClone(url, level('free'), publicHost)).toMatchObject({ status: 400 });
    },
  );
});
