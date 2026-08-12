import { describe, expect, it } from 'vitest';
import { sanitizePresentationSvg } from './sanitize.js';

describe('sanitizePresentationSvg', () => {
  it('preserves presentation geometry and local paint references', () => {
    const safe = sanitizePresentationSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="clip"><circle cx="12" cy="12" r="10"/></clipPath></defs><path d="M0 0h24v24z" fill="url(#paint)" clip-path="url(#clip)" stroke="currentColor"/></svg>',
    );
    expect(safe).toContain('viewBox="0 0 24 24"');
    expect(safe).toContain('fill="url(#paint)"');
    expect(safe).toContain('clip-path="url(#clip)"');
    expect(safe).toContain('stroke="currentColor"');
  });

  it('removes active content, links, styles, external resources, and foreign namespaces', () => {
    const safe = sanitizePresentationSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:evil="http://www.w3.org/2000/svg" onload="steal()" style="position:fixed">
        <style>@import url(https://attacker.test/style.css)</style>
        <script>steal()</script>
        <foreignObject><iframe src="https://attacker.test/frame"></iframe></foreignObject>
        <a href="https://attacker.test/link"><rect width="100" height="100"/></a>
        <image href="https://attacker.test/pixel"/>
        <use xlink:href="https://attacker.test/sprite#x"/>
        <filter id="remote"><feImage href="https://attacker.test/filter"/></filter>
        <animate attributeName="href" to="javascript:steal()"/>
        <evil:path d="M0 0h2v2z"/>
        <path id="safe" d="M0 0h1v1z" onclick="steal()" style="fill:red" fill="url(https://attacker.test/paint)"/>
      </svg>
    `);
    expect(safe).not.toBeNull();
    for (const forbidden of [
      'onload',
      'onclick',
      '<style',
      '<script',
      'foreignObject',
      '<iframe',
      '<a',
      '<image',
      '<use',
      '<filter',
      '<animate',
      'xlink',
      'evil:',
      'attacker.test',
      'javascript:',
      'style=',
    ]) {
      expect(safe).not.toContain(forbidden);
    }
    expect(safe).toContain('<path id="safe" d="M0 0h1v1z"/>');
  });

  it('rejects doctypes, malformed XML, missing SVG roots, and empty presentation trees', () => {
    expect(
      sanitizePresentationSvg(
        '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg><path d="&x;"/></svg>',
      ),
    ).toBeNull();
    expect(sanitizePresentationSvg('<svg><path></svg>')).toBeNull();
    expect(sanitizePresentationSvg('<html><path d="M0 0"/></html>')).toBeNull();
    expect(sanitizePresentationSvg('<html><svg><path d="M0 0"/></svg></html>')).not.toBeNull();
    expect(sanitizePresentationSvg('<svg><script>only content</script></svg>')).toBeNull();
  });

  it('extracts a fenced model response before structurally sanitizing it', () => {
    const safe = sanitizePresentationSvg(
      'Here you go:\n```svg\n<svg viewBox="0 0 2 2"><rect width="2" height="2"/></svg>\n```',
    );
    expect(safe).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(safe).toContain('<rect width="2" height="2"/>');
    expect(safe).not.toContain('Here you go');
  });
});
