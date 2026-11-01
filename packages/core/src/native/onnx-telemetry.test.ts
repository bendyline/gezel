import { describe, expect, it } from 'vitest';
import { disableOnnxRuntimeTelemetry } from './onnx-telemetry.js';

describe('disableOnnxRuntimeTelemetry', () => {
  it('turns ONNX Runtime telemetry off when nothing says otherwise', () => {
    const env: NodeJS.ProcessEnv = {};
    disableOnnxRuntimeTelemetry(env);
    expect(env.ORT_DISABLE_TELEMETRY).toBe('1');
  });

  it('treats an empty value as unset', () => {
    const env: NodeJS.ProcessEnv = { ORT_DISABLE_TELEMETRY: '' };
    disableOnnxRuntimeTelemetry(env);
    expect(env.ORT_DISABLE_TELEMETRY).toBe('1');
  });

  it('leaves a value someone set alone', () => {
    const env: NodeJS.ProcessEnv = { ORT_DISABLE_TELEMETRY: '0' };
    disableOnnxRuntimeTelemetry(env);
    expect(env.ORT_DISABLE_TELEMETRY).toBe('0');
  });
});
