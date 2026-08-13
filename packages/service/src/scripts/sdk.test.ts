import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldVendorSdkPath } from './sdk.js';

describe('shouldVendorSdkPath', () => {
  it('copies an installed SDK whose package root is itself below node_modules', () => {
    const sdk = join('D:\\app', 'node_modules', '@bendyline', 'gezel-sdk');
    expect(shouldVendorSdkPath(sdk, sdk)).toBe(true);
    expect(shouldVendorSdkPath(sdk, join(sdk, 'dist', 'index.js'))).toBe(true);
    expect(shouldVendorSdkPath(sdk, join(sdk, 'node_modules', 'nested', 'index.js'))).toBe(false);
  });
});
