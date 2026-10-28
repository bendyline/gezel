import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConnectorBinding } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  cameraBindingForArtifact,
  cameraPixelsWithheld,
  cameraPixelsWithheldForFile,
} from './frame-access.js';

const camera = (allowCloudModels = false): ProjectConnectorBinding => ({
  id: 'cam1',
  type: 'camera-local',
  driver: 'device',
  corpusDir: 'data/mud-room',
  config: { device: 'x', allowCloudModels },
});
const mail: ProjectConnectorBinding = {
  id: 'm',
  type: 'mail-gmail',
  corpusDir: 'data/mail',
  config: {},
};
const frame = 'artifacts/data/mud-room/events/2026-10-21/15/attachments/001/keyframe-1.jpg';

describe('camera frame access', () => {
  it('finds the camera that owns a keyframe, and nothing else', () => {
    const project = { connectors: [camera(), mail] };
    expect(cameraBindingForArtifact(project, frame)?.id).toBe('cam1');
    expect(cameraBindingForArtifact(project, 'data/mud-room-2/x.jpg')).toBeUndefined();
    expect(cameraBindingForArtifact(project, 'data/mail/inbox/a.png')).toBeUndefined();
  });

  it('keeps camera pixels from cloud models unless the camera allows them', () => {
    expect(cameraPixelsWithheld({ connectors: [camera()] }, 'copilot', frame)).toBe(true);
    expect(cameraPixelsWithheld({ connectors: [camera()] }, 'llama-cpp', frame)).toBe(false);
    expect(cameraPixelsWithheld({ connectors: [camera(true)] }, 'copilot', frame)).toBe(false);
    expect(
      cameraPixelsWithheld({ connectors: [camera()] }, 'copilot', 'artifacts/reports/chart.png'),
    ).toBe(false);
  });

  // 1.26299.99 compared the raw string, and the readers normalized it
  // afterwards, so each of these reached a keyframe on a cloud model.
  it.each([
    'data/./mud-room/events/k.jpg',
    'data//mud-room/events/k.jpg',
    'x/../data/mud-room/events/k.jpg',
    './artifacts//data/mud-room/k.jpg',
    'DATA/Mud-Room/events/k.jpg',
    'data./mud-room /events/k.jpg',
    'data\\mud-room\\events\\k.jpg',
  ])('withholds a keyframe spelled %s', (spelling) => {
    expect(cameraPixelsWithheld({ connectors: [camera()] }, 'copilot', spelling)).toBe(true);
  });

  it('judges the file a read opens, whatever path led to it', async () => {
    const artifacts = await mkdtemp(join(tmpdir(), 'gezel-camera-frames-'));
    try {
      const events = join(artifacts, 'data', 'mud-room', 'events');
      await mkdir(events, { recursive: true });
      await writeFile(join(events, 'k.jpg'), 'jpg');
      await mkdir(join(artifacts, 'reports'), { recursive: true });
      await writeFile(join(artifacts, 'reports', 'chart.png'), 'png');
      const project = { connectors: [camera()] };
      const keyframe = join(artifacts, 'data', 'x', '..', 'mud-room', 'events', 'k.jpg');
      expect(await cameraPixelsWithheldForFile(project, 'copilot', artifacts, keyframe)).toBe(true);
      expect(await cameraPixelsWithheldForFile(project, 'llama-cpp', artifacts, keyframe)).toBe(
        false,
      );
      expect(
        await cameraPixelsWithheldForFile(
          project,
          'copilot',
          artifacts,
          join(artifacts, 'reports', 'chart.png'),
        ),
      ).toBe(false);
    } finally {
      await rm(artifacts, { recursive: true, force: true });
    }
  });
});
