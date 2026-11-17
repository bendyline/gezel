/**
 * Which browser page capture may use. Only the full managed Chrome qualifies:
 * the headless shell ignores the profile preference that keeps WebRTC from
 * sending UDP outside the proxy, so a page could reach the LAN through it
 * (measured 2026-11-16, Chrome for Testing 151, docs/website-connector.md).
 * Store builds have no managed browser and get text-only capture.
 */

import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import { resolveManagedChromiumBinary } from '../rendering/managed-chromium.js';

export async function resolveCaptureChromium(home: string): Promise<string | null> {
  const executable = await resolveManagedChromiumBinary(playwrightBrowsersDir(home));
  if (!executable) return null;
  if (/headless[-_]shell/i.test(executable)) return null;
  return executable;
}
