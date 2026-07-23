import { describe, expect, it } from 'vitest';
import { runStepSniff } from './step-sniff.js';

const realGame = `<!doctype html><html><body><canvas id="c" width="400" height="300"></canvas>
<script>
const canvas = document.getElementById('c'); const ctx = canvas.getContext('2d');
let x = 0, y = 150, score = 0, lives = 3; const keys = {}; const bullets = []; const enemies = [];
addEventListener('keydown', e => { keys[e.key] = true; if (e.key === ' ') bullets.push({ x, y }); });
addEventListener('keyup', e => { keys[e.key] = false; });
function spawnEnemy(){ enemies.push({ x: Math.random() * 400, y: 0 }); }
function update(){ x += (keys.ArrowRight ? 3 : 0) - (keys.ArrowLeft ? 3 : 0); x = Math.max(0, Math.min(380, x)); for (const b of bullets) b.y -= 5; for (const e of enemies) e.y += 1.5; if (Math.random() < 0.02) spawnEnemy(); }
function draw(){ ctx.clearRect(0,0,400,300); ctx.fillStyle = '#0f0'; ctx.fillRect(x,260,20,20); ctx.fillStyle = '#fff'; for (const b of bullets) ctx.fillRect(b.x+9,b.y,2,6); ctx.fillStyle = '#f00'; for (const e of enemies) ctx.fillRect(e.x,e.y,16,16); ctx.fillText('Score: ' + score, 8, 16); }
function loop(){ update(); draw(); score++; requestAnimationFrame(loop); }
loop();
</script></body></html>`;

const truncated = `<!doctype html><html><body><canvas id="c"></canvas>
<script>
const ctx = document.getElementById('c').getContext('2d'); let x = 0;
function loop(){ ctx.fillRect(x,0,10,10); x++; requestAnimationFra`; // no </script>

const stub = '<!doctype html><html><body><canvas></canvas><script>// TODO</script></body></html>';

describe('runStepSniff', () => {
  it('html-game: passes a real canvas game with closed, substantial script', () => {
    expect(runStepSniff('html-game', realGame)).toBe(true);
  });

  it('html-game: rejects a truncated file (open <script>, no </script>)', () => {
    expect(runStepSniff('html-game', truncated)).toBe(false);
  });

  it('html-game: rejects a stub (surface present but near-empty script)', () => {
    expect(runStepSniff('html-game', stub)).toBe(false);
  });

  it('html-game: rejects markup with no render surface', () => {
    expect(runStepSniff('html-game', '<html><body><p>hi</p></body></html>')).toBe(false);
  });

  it('nonempty: tracks whitespace-trimmed content', () => {
    expect(runStepSniff('nonempty', '   x  ')).toBe(true);
    expect(runStepSniff('nonempty', '   \n  ')).toBe(false);
  });

  it('json-valid: parses valid JSON only', () => {
    expect(runStepSniff('json-valid', '{"a":1}')).toBe(true);
    expect(runStepSniff('json-valid', '{a:1}')).toBe(false);
  });

  it('html-complete: passes a complete non-game page, rejects truncation', () => {
    // Generic: no canvas/JS required, just a non-truncated document.
    expect(runStepSniff('html-complete', '<html><body><h1>Hi</h1></body></html>')).toBe(true);
    expect(runStepSniff('html-complete', realGame)).toBe(true);
    expect(runStepSniff('html-complete', truncated)).toBe(false); // open <script>, no </body>
  });

  it('data-table: accepts JSON-array / CSV output, rejects empty + a transform script', () => {
    expect(runStepSniff('data-table', '[{"email":"a@b.com"}]')).toBe(true);
    expect(runStepSniff('data-table', 'email,name\na@b.com,A')).toBe(true);
    expect(runStepSniff('data-table', '[]')).toBe(false);
    // The data-wrangle failure: the script left where the output should be.
    expect(runStepSniff('data-table', "import fs from 'node:fs';\nfs.writeFileSync('o', x);")).toBe(
      false,
    );
  });
});
