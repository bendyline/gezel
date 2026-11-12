import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ICON_IMAGE_MAX_BYTES } from '@bendyline/gezel';
import { GezelClient, apiErrorMessage } from '@bendyline/gezel-client';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let client: GezelClient;
let home: string;
let baseUrl: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

const MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20c0-8 6-14 16-16-1 10-7 16-16 16z"/></svg>';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const iconFile = (id: string, name: string) => join(home, 'projects', id, name);

function put(id: string, body: Uint8Array | string, contentType: string) {
  return httpFetch(`${baseUrl}/api/projects/${id}/icon`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${svc.context.token}`, 'content-type': contentType },
    body,
  });
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-project-icon-'));
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  client = new GezelClient({ baseUrl, token: svc.context.token, fetch: httpFetch });
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe("a project's own icon", () => {
  it('draws a mark from a description and saves nothing until it is kept', async () => {
    const project = await client.createProject({ name: 'Orchard' });
    const draw = vi
      .spyOn(svc.context.chat, 'oneShotCompletion')
      .mockResolvedValue(`Here you go:\n\`\`\`svg\n${MARK}\n\`\`\``);
    try {
      const { svg } = await client.drawProjectIcon(project.id, { description: 'A pear leaf.' });
      expect(svg).toContain('<path');
      expect(svg).not.toContain('```');
      const prompt = String(draw.mock.calls[0]?.[0]);
      expect(prompt).toContain('A pear leaf.');
      expect(prompt).toContain('"Orchard"');
      expect((await client.getProject(project.id)).customIcon).toBeUndefined();

      const kept = await client.setProjectIconSvg(project.id, { svg });
      expect(kept.customIcon).toMatchObject({ kind: 'drawn', format: 'svg' });
      expect(await readFile(iconFile(project.id, 'icon.svg'), 'utf8')).toContain('<path');
      const stored = await client.getProjectIcon(project.id);
      expect(stored.type).toContain('image/svg+xml');
    } finally {
      draw.mockRestore();
    }
  });

  it('says so when the model returns no drawing', async () => {
    const project = await client.createProject({ name: 'Blank' });
    const draw = vi
      .spyOn(svc.context.chat, 'oneShotCompletion')
      .mockResolvedValue('I cannot draw, but here is a poem.');
    try {
      const failure = await client
        .drawProjectIcon(project.id, { description: 'Anything.' })
        .catch((err: unknown) => err);
      expect(apiErrorMessage(failure)).toMatch(/did not return a usable icon/);
    } finally {
      draw.mockRestore();
    }
  });

  // A 5xx body is replaced with an opaque one, so both failures answer below
  // 500 and the person reads what to do.
  it('says so when no model could be reached, without the provider detail', async () => {
    const project = await client.createProject({ name: 'Offline' });
    const draw = vi
      .spyOn(svc.context.chat, 'oneShotCompletion')
      .mockRejectedValue(new Error('spawn /opt/engines/llama-server ENOENT'));
    try {
      const failure = await client
        .drawProjectIcon(project.id, { description: 'Anything.' })
        .catch((err: unknown) => err);
      expect(apiErrorMessage(failure)).toMatch(/No model could draw the icon/);
      expect(apiErrorMessage(failure)).not.toMatch(/llama-server/);
    } finally {
      draw.mockRestore();
    }
  });

  it('refuses a drawing that is not a presentation-only SVG', async () => {
    const project = await client.createProject({ name: 'Unsafe' });
    const res = await put(
      project.id,
      JSON.stringify({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      }),
      'application/json',
    );
    expect(res.status).toBe(400);
    expect((await client.getProject(project.id)).customIcon).toBeUndefined();
  });

  it('keeps an uploaded picture by what its bytes are, not what it is called', async () => {
    const project = await client.createProject({ name: 'Photo' });
    // Declared as a PNG; the bytes are a JPEG.
    const uploaded = await client.uploadProjectIcon(
      project.id,
      new Blob([JPEG], { type: 'image/png' }),
    );
    expect(uploaded.customIcon).toMatchObject({ kind: 'image', format: 'jpeg' });
    expect(existsSync(iconFile(project.id, 'icon.jpg'))).toBe(true);
    const stored = await client.getProjectIcon(project.id);
    expect(stored.type).toContain('image/jpeg');
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(JPEG);

    // A new one replaces the old, whatever its format.
    const replaced = await client.uploadProjectIcon(project.id, new Blob([PNG]));
    expect(replaced.customIcon).toMatchObject({ kind: 'image', format: 'png' });
    expect(existsSync(iconFile(project.id, 'icon.jpg'))).toBe(false);
    expect(existsSync(iconFile(project.id, 'icon.png'))).toBe(true);
  });

  it('refuses a file that is not a picture, and one that is too large', async () => {
    const project = await client.createProject({ name: 'Refused' });
    const notAPicture = await put(project.id, new TextEncoder().encode('<html>'), 'image/png');
    expect(notAPicture.status).toBe(415);

    const big = new Uint8Array(PROJECT_ICON_IMAGE_MAX_BYTES + 1);
    big.set(PNG);
    const tooLarge = await put(project.id, big, 'image/png');
    expect(tooLarge.status).toBe(413);
    expect((await client.getProject(project.id)).customIcon).toBeUndefined();
  });

  it('puts the art away when a mark is chosen again, or on request', async () => {
    const project = await client.createProject({ name: 'Back to marks' });
    await client.uploadProjectIcon(project.id, new Blob([PNG]));

    const marked = await client.updateProject(project.id, { icon: 'sprout' });
    expect(marked.icon).toBe('sprout');
    expect(marked.customIcon).toBeUndefined();
    expect(existsSync(iconFile(project.id, 'icon.png'))).toBe(false);
    await expect(client.getProjectIcon(project.id)).rejects.toThrow();

    await client.setProjectIconSvg(project.id, { svg: MARK });
    // Another setting leaves the art alone.
    expect((await client.updateProject(project.id, { description: 'x' })).customIcon).toBeDefined();
    const cleared = await client.deleteProjectIcon(project.id);
    expect(cleared.customIcon).toBeUndefined();
    expect(cleared.icon).toBe('sprout');
    expect(existsSync(iconFile(project.id, 'icon.svg'))).toBe(false);
  });

  it('answers 404 for a project that does not exist', async () => {
    const res = await put('no-such-project', PNG, 'image/png');
    expect(res.status).toBe(404);
  });
});
