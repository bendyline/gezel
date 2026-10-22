import type { ProjectConnectorBinding } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { cameraBindingForArtifact, cameraPixelsWithheld } from './frame-access.js';

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
});
