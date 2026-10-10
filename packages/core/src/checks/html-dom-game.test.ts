import { describe, expect, it } from 'vitest';
import { htmlGameSniff } from './html.js';
import { explainSniff } from './sniff-explain.js';

// Event-driven guessing game: no animation loop, canvas, or SVG.
const script = `
const choices = document.querySelectorAll('button');
const status = document.getElementById('status');
let attempts = 0;
let finished = false;
const target = Math.floor(Math.random() * choices.length);
choices.forEach((choice, index) => {
  choice.addEventListener('click', () => {
    if (finished || choice.disabled) return;
    attempts += 1;
    choice.disabled = true;
    if (index === target) {
      finished = true;
      status.textContent = 'Found it in ' + attempts + ' attempts';
      choices.forEach(other => { other.disabled = true; });
    } else {
      status.textContent = 'Try another choice; attempts: ' + attempts;
    }
  });
});`;
const page = (js = script) =>
  `<html><body><button>A</button><button>B</button><p id="status"></p><script>${js}</script></body></html>`;

describe('DOM game deliverable floor', () => {
  it('accepts event-driven controls and substantive game logic', () => {
    expect(htmlGameSniff(page())).toBe(true);
  });
  it.each([
    page().replace('</script>', ''),
    page('document.querySelector("button").addEventListener("click", () => {});'),
    page(script.replace("choice.addEventListener('click',", 'someFunction(')),
    page(script.replaceAll('status.textContent =', 'console.log =')),
    '<html><body><button>A</button><script src="game.js"></script></body></html>',
  ])('still rejects truncated, inert or undersized output', (html) => {
    expect(htmlGameSniff(html)).toBe(false);
  });
  it('reports the actual missing floor without asking for canvas', () => {
    expect(explainSniff('html-game', page(), 2000)).toContain('need >= 2000');
    expect(explainSniff('html-game', page().replace('</script>', ''))).toContain('truncated');
    expect(explainSniff('html-game', page(''))).toContain('interactive DOM');
  });
});
