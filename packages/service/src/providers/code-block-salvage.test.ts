import { describe, expect, it } from 'vitest';
import {
  inlineCompanionAssets,
  prepareSalvagedCodeBlocks,
  salvageCodeBlocks,
} from './code-block-salvage.js';

describe('salvageCodeBlocks', () => {
  it('extracts an html block with hinted filename', () => {
    const text = `
Here's the tic-tac-toe file:

**tictactoe.html:**

\`\`\`html
<!DOCTYPE html>
<html><body>game</body></html>
\`\`\`
`;
    const blocks = salvageCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.filename).toBe('tictactoe.html');
    expect(blocks[0]!.lang).toBe('html');
    expect(blocks[0]!.content).toContain('<!DOCTYPE html>');
  });

  it('falls back to language-default filename when no hint is present', () => {
    const text = `
I will write the index file:

\`\`\`html
<html></html>
\`\`\`
`;
    const blocks = salvageCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.filename).toBe('index.html');
  });

  it('captures multiple blocks in one buffer', () => {
    const text = `
\`\`\`html
<html></html>
\`\`\`

\`\`\`css
body { color: red; }
\`\`\`

\`\`\`javascript
console.log('hi');
\`\`\`
`;
    const blocks = salvageCodeBlocks(text);
    expect(blocks.map((b) => b.filename).sort()).toEqual(['index.html', 'script.js', 'style.css']);
  });

  it('does not let an index.html prose hint rename a JavaScript fence', () => {
    const blocks = salvageCodeBlocks(`
Here is another update for index.html:

\`\`\`javascript
const indexHtml = readFile({ path: "index.html" });
\`\`\`
`);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.filename).toBe('script.js');
    expect(blocks[0]!.lang).toBe('javascript');
  });

  it('salvages an unterminated trailing block (ramble cut off mid-stream)', () => {
    const text = `
Building the page now.

\`\`\`html
<!DOCTYPE html>
<html><body>
<div id="board">incomplete...`;
    const blocks = salvageCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.filename).toBe('index.html');
    expect(blocks[0]!.content).toContain('<!DOCTYPE html>');
  });

  it('ignores blocks without a recognizable language', () => {
    const text = '\n```\nnaked code with no lang\n```\n';
    expect(salvageCodeBlocks(text)).toEqual([]);
  });

  it('salvages an untyped HTML fence when a nearby filename hint names index.html', () => {
    const blocks = salvageCodeBlocks(`
Here is the content of \`workspace/index.html\`:

\`\`\`
<html>
  <head><title>Tic Tac Toe</title></head>
  <body><h1>Tic Tac Toe</h1><script>document.body.onclick = () => {}</script></body>
</html>
\`\`\`
`);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.filename).toBe('index.html');
    expect(blocks[0]!.lang).toBe('html');
    expect(blocks[0]!.content).toContain('<script>');
  });

  it('extracts untyped writeFile fences and inlines companion JavaScript', () => {
    const blocks = inlineCompanionAssets(
      salvageCodeBlocks(`
\`\`\`
writeFile({
  path: "index.html",
  content: \`
<!DOCTYPE html>
<html><body><div id="board"></div><script src="main.js"></script></body></html>
\`
})
\`\`\`

\`\`\`
writeFile({
  path: "main.js",
  content: \`
const currentPlayer = 'X';
alert(\`Player \${currentPlayer} wins!\`);
\`
})
\`\`\`
`),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.filename).toBe('index.html');
    expect(blocks[0]!.content).toContain('<div id="board"></div>');
    expect(blocks[0]!.content).toContain("const currentPlayer = 'X';");
    expect(blocks[0]!.content).toContain('alert(`Player ${currentPlayer} wins!`);');
    expect(blocks[0]!.content).not.toContain('src="main.js"');
  });

  it('ignores blocks whose language is unknown and no filename hint exists', () => {
    const text = '\n```rust\nfn main(){}\n```\n';
    expect(salvageCodeBlocks(text)).toEqual([]);
  });

  it('handles ~~~ as a fence', () => {
    const text = '\n~~~html\n<html></html>\n~~~\n';
    const blocks = salvageCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.filename).toBe('index.html');
  });

  it('returns an empty array on prose with no fences', () => {
    expect(salvageCodeBlocks('Just thinking out loud about the design.')).toEqual([]);
  });

  it('drops a fragment destined for a .html target (the source-write-guard would reject it)', () => {
    // A `<script>`-body / JS fragment fenced as html, salvaged toward
    // index.html. Promoting it to writeFile only burns the failure budget.
    const jsFragment = '```html\nfunction drawStars(){ for(let i=0;i<100;i++){} }\n```';
    expect(salvageCodeBlocks(`update index.html:\n${jsFragment}`)).toEqual([]);
  });

  it('keeps a complete HTML document for a .html target', () => {
    const full = '```html\n<!DOCTYPE html>\n<html><body><h1>Game</h1></body></html>\n```';
    const blocks = salvageCodeBlocks(full);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.filename).toBe('index.html');
  });

  it('inlines a companion JavaScript block referenced by the HTML', () => {
    const blocks = inlineCompanionAssets(
      salvageCodeBlocks(`
\`\`\`html
<!DOCTYPE html>
<html><body><h1>Game</h1><script src="game.js"></script></body></html>
\`\`\`

\`\`\`javascript
document.body.onclick = () => {};
\`\`\`
`),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.filename).toBe('index.html');
    expect(blocks[0]!.content).toContain('<script>');
    expect(blocks[0]!.content).toContain('document.body.onclick');
    expect(blocks[0]!.content).not.toContain('src="game.js"');
  });
});

describe('prepareSalvagedCodeBlocks', () => {
  it('keeps one exact deliverable and ignores unrelated fragment fences', () => {
    const blocks = prepareSalvagedCodeBlocks(
      `
\`\`\`html
<html><body>placeholder</body></html>
\`\`\`
\`\`\`javascript
ctx.moveTo(player.x, player.y);
\`\`\`
\`\`\`html
<!DOCTYPE html><html><body><canvas></canvas><script>const gameState = 'playing';</script></body></html>
\`\`\`
\`\`\`javascript
ctx.lineTo(player.x + player.w, player.y);
\`\`\`
`,
      'index.html',
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.filename).toBe('index.html');
    expect(blocks[0]!.content).toContain('<!DOCTYPE html>');
    expect(blocks[0]!.content).not.toContain('ctx.lineTo');
  });

  it('drops a repeated batch of ambiguous JavaScript fragments', () => {
    const blocks = prepareSalvagedCodeBlocks(`
\`\`\`javascript
ctx.beginPath(); ctx.moveTo(player.x, player.y);
\`\`\`
\`\`\`javascript
ctx.beginPath(); ctx.lineTo(player.x + player.w, player.y);
\`\`\`
`);
    expect(blocks).toEqual([]);
  });

  it('coalesces repeated JavaScript revisions to one standalone candidate', () => {
    const blocks = prepareSalvagedCodeBlocks(`
\`\`\`javascript
const state = {};
\`\`\`
\`\`\`javascript
const state = { score: 0, lives: 3 };
function startGame() { state.score = 0; }
\`\`\`
`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content).toContain('function startGame');
  });
});
