/// <reference types="node" />

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const foundation = readFileSync(resolve(import.meta.dirname, 'foundation.css'), 'utf8');
const lightRoot = foundation.match(/^:root \{([\s\S]*?)^\}/m)?.[1] ?? '';

function tokenHex(source: string, token: string): string {
  const value = source.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (!value) throw new Error(`Missing hexadecimal --${token} token`);
  return value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  return channels
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0), 0);
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? cssFiles(path) : extname(path) === '.css' ? [path] : [];
  });
}

describe('semantic text colors', () => {
  it('meets WCAG AA on every light paper surface', () => {
    const foregrounds = [
      'accent-text',
      'accent-text-hover',
      'success-text',
      'warning-text',
      'danger-text',
    ].map((token) => [token, tokenHex(lightRoot, token)] as const);
    const backgrounds = [
      'gezel-paper-canvas',
      'gezel-paper-workshop',
      'gezel-paper-panel',
      'gezel-paper-reading',
      'gezel-paper-reading-inset',
      'gezel-paper-handoff',
      'gezel-paper-control',
      'gezel-paper-control-deep',
      'gezel-paper-inset',
    ].map((token) => [token, tokenHex(lightRoot, token)] as const);

    for (const [foregroundName, foreground] of foregrounds) {
      for (const [backgroundName, background] of backgrounds) {
        expect(
          contrast(foreground, background),
          `--${foregroundName} on --${backgroundName}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps fill and border tokens out of text color declarations', () => {
    const directSemanticText =
      /^\s*color:\s*var\(--(?:accent(?:-hover)?|success|warning|danger)(?=[,)])/m;
    const offenders = cssFiles(resolve(import.meta.dirname, '..'))
      .filter((path) => directSemanticText.test(readFileSync(path, 'utf8')))
      .map((path) => path.replace(`${resolve(import.meta.dirname, '..')}/`, ''));

    expect(offenders).toEqual([]);
  });
});
