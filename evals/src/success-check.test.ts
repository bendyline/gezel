import { describe, expect, it } from 'vitest';
import {
  petShopContentSniff,
  tankCombatContentSniff,
  ticTacToeContentSniff,
} from './success-check.ts';

/**
 * Build a syntactically-valid filler script body that pushes the
 * total inline JS past `MIN_INLINE_JS_BYTES` (4 KB). Used by the
 * "this is a real-looking game" test fixtures whose hand-written
 * snippets would otherwise be a few hundred bytes — under the new
 * JS-size requirement they'd fail not because the
 * keyword sniff is wrong but because the fixture is unrealistically
 * small. Adding ~5KB of plausible state + helper code keeps the
 * sniffs honest while leaving the keyword/grid/click/etc. assertions
 * meaningful.
 */
function jsFiller(bytes = 5000): string {
  // Each iteration is wrapped in its own IIFE so repeated `const`
  // declarations don't collide (and the parser exercises real syntax —
  // not just whitespace padding).
  const block = `
    (function() {
      const settings = { difficulty: 'medium', sound: true, theme: 'dark' };
      const inputState = { up: false, down: false, left: false, right: false };
      function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
      function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
      function lerp(a, b, t) { return a + (b - a) * t; }
      function saveState(s) { try { localStorage.setItem('s', JSON.stringify(s)); } catch (e) {} }
      function loadState() { try { return JSON.parse(localStorage.getItem('s')) || null; } catch (e) { return null; } }
      return { settings, inputState, clamp, distance, lerp, saveState, loadState };
    })();
  `;
  let out = '';
  while (out.length < bytes) out += block;
  return out;
}

describe('ticTacToeContentSniff', () => {
  it('passes a real-looking tic-tac-toe page', () => {
    const html = `
      <!doctype html><html><head><title>Tic-Tac-Toe</title>
      <style>.board{display:grid;grid-template-columns:repeat(3,1fr);}</style>
      </head><body>
      <div class="board" id="board"></div>
      <script>
        const cells = Array.from({length:9},(_,i)=>i);
        const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        const board = document.getElementById('board');
        cells.forEach(i => {
          const b = document.createElement('button');
          b.addEventListener('click', () => onCellClick(i, b));
          board.appendChild(b);
        });
        function checkWinner(state) {
          for (const [a,b,c] of wins) if (state[a] && state[a] === state[b] && state[b] === state[c]) return state[a];
          return null;
        }
        ${jsFiller()}
      </script>
      </body></html>
    `;
    const result = ticTacToeContentSniff(html);
    expect(result.ok).toBe(true);
    expect(result.signals).toEqual(
      expect.arrayContaining(['name', 'grid', 'click', 'win-detect', 'js-parses', 'js-size-ok']),
    );
  });

  it('passes with table-based layout and inline onclick', () => {
    const html = `
      <html><body><h1>Tic Tac Toe</h1>
      <table>
        <tr><td onclick="play(0)"></td><td onclick="play(1)"></td><td onclick="play(2)"></td></tr>
        <tr><td onclick="play(3)"></td><td onclick="play(4)"></td><td onclick="play(5)"></td></tr>
        <tr><td onclick="play(6)"></td><td onclick="play(7)"></td><td onclick="play(8)"></td></tr>
      </table>
      <script>
        const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        function checkWin(s) { return lines.some(l => s[l[0]] && s[l[0]] === s[l[1]] && s[l[1]] === s[l[2]]); }
        ${jsFiller()}
      </script>
      </body></html>
    `;
    const result = ticTacToeContentSniff(html);
    expect(result.ok).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(5);
  });

  it('recognizes unicode hyphen variants in the game name', () => {
    const html = `
      <html><body><h1>Tic\u2011Tac\u2011Toe</h1>
      <div id="board" class="board"></div>
      <script>
        const board=document.getElementById('board');
        const cells=Array(9).fill(null);
        function init(){for(let i=0;i<9;i++){const b=document.createElement('button');b.addEventListener('click',()=>move(i));board.appendChild(b);}}
        function move(i){cells[i]='X';}
        const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        function checkWinner(){return wins.some(([a,b,c])=>cells[a]&&cells[a]===cells[b]&&cells[b]===cells[c]);}
        ${jsFiller()}
      </script>
      </body></html>
    `;
    const result = ticTacToeContentSniff(html);
    expect(result.signals).toContain('name');
    expect(result.ok).toBe(true);
  });

  it('recognizes dynamically-created table cells as a grid', () => {
    const html = `
      <html><body><h1>Tic Tac Toe</h1>
      <table id="board" class="grid"></table>
      <script>
        const board=document.getElementById('board');
        const cells=Array(9).fill(null);
        function init(){for(let i=0;i<9;i++){const td=document.createElement('td');td.addEventListener('click',()=>move(i));board.appendChild(td);}}
        function move(i){cells[i]='X';}
        const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        function checkWinner(){return wins.some(([a,b,c])=>cells[a]&&cells[a]===cells[b]&&cells[b]===cells[c]);}
        ${jsFiller()}
      </script>
      </body></html>
    `;
    const result = ticTacToeContentSniff(html);
    expect(result.signals).toContain('grid');
    expect(result.ok).toBe(true);
  });

  it('rejects an empty stub with only the name (no script tag at all)', () => {
    const html = '<!doctype html><html><body><h1>Tic-Tac-Toe</h1></body></html>';
    const result = ticTacToeContentSniff(html);
    expect(result.ok).toBe(false);
    // Empty page: only the `name` keyword fires + the trivially-true
    // `js-parses` (no scripts = nothing to fail to parse). The size
    // requirement keeps the page from passing; the failReason
    // distinguishes "no <script> at all" from "<script> too small"
    // because the failure modes have different remediations.
    expect(result.signals).toEqual(expect.arrayContaining(['name', 'js-parses']));
    expect(result.signals).not.toContain('js-size-ok');
    expect(result.failReason).toMatch(/no inline <script> tag found/);
  });

  // Wild-caught (qwen3.6 matrix) — the model emits a
  // complete-looking page skeleton + opening `<script>` tag, then
  // truncates mid-stream WITHOUT ever closing the script. The
  // strict-regex extractor sees zero scripts (no closer to anchor
  // on) — without the unclosed-script check we'd report "js=0
  // bytes" which sounds like the model just didn't try. The
  // unclosed signal calls out the real failure: write_file was
  // truncated.
  it('rejects an HTML with unclosed <script> (the dominant truncation pattern)', () => {
    const html = `
      <html><head><title>Tic-Tac-Toe</title></head><body>
      <h1>Tic-Tac-Toe</h1>
      <div class="board" style="display:grid;grid-template-columns:repeat(3,1fr);"></div>
      ${'<button class="cell"></button>'.repeat(9)}
      <script>
        const board = document.getElementById('board');
        board.addEventListener('click', () => {});
        const wins = [[0,1,2]];
        function checkWinner(state)
    `;
    const result = ticTacToeContentSniff(html);
    expect(result.ok).toBe(false);
    expect(result.signals).not.toContain('js-parses');
    expect(result.signals).not.toContain('js-size-ok');
    expect(result.failReason).toMatch(/opened.*closed.*truncated.*append_to_file/);
  });

  it('rejects an HTML with truncated JS (`let|` mid-stream)', () => {
    const html = `
      <html><head><title>Tic-Tac-Toe</title></head><body>
      <div class="board" style="display:grid;grid-template-columns:repeat(3,1fr);"></div>
      ${'<button class="cell"></button>'.repeat(9)}
      <script>
        const board = document.getElementById('board');
        board.addEventListener('click', () => {});
        const wins = [[0,1,2]];
        let player,enemies,bullets;let|
      </script>
      </body></html>
    `;
    const result = ticTacToeContentSniff(html);
    expect(result.ok).toBe(false);
    expect(result.signals).not.toContain('js-parses');
    expect(result.failReason).toMatch(/inline JS does not parse/);
  });

  // The other new failure mode: parses fine but is only a few hundred
  // bytes — a "skeleton" without actual game logic. Models occasionally
  // emit a complete-looking shell when truncated mid-write.
  it('rejects a parsable-but-tiny stub (under MIN_INLINE_JS_BYTES)', () => {
    const html = `
      <html><body><h1>Tic-Tac-Toe</h1>
      <div class="board" style="display:grid;grid-template-columns:repeat(3,1fr);"></div>
      ${'<button class="cell"></button>'.repeat(9)}
      <script>
        document.querySelectorAll('.cell').forEach(c => c.addEventListener('click', () => {}));
        const wins = [[0,1,2],[3,4,5]];
      </script>
      </body></html>
    `;
    const result = ticTacToeContentSniff(html);
    expect(result.ok).toBe(false);
    expect(result.signals).toContain('js-parses');
    expect(result.signals).not.toContain('js-size-ok');
    // When only `js-size-ok` is missing (everything else fires + parses),
    // the failReason is the feature-list message that names concrete
    // additions, not the numeric "you need N more bytes" string. See
    // jsTooSmall in jsQualitySignals.
    expect(result.failReason).toMatch(/Add at least 2 of these features/);
    expect(result.failReason).toMatch(/status banner/);
    expect(result.failReason).toMatch(/Reset/);
  });

  it('passes concise playable implementations with multiple concrete gameplay enhancements', () => {
    const html = `
      <!doctype html><html><head><title>Tic-Tac-Toe</title>
      <style>
        .board{display:grid;grid-template-columns:repeat(3,1fr)}
        .cell{width:100px;height:100px}
      </style></head><body>
      <h1>Tic-Tac-Toe</h1>
      <div id="status"></div>
      <div id="board" class="board"></div>
      <button id="restart">Play Again</button>
      <script>
        const WIN_PATTERNS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        let board = Array(9).fill('');
        let currentPlayer = 'X';
        let gameOver = false;
        const boardEl = document.getElementById('board');
        const statusEl = document.getElementById('status');
        const restartBtn = document.getElementById('restart');
        function createBoard() {
          boardEl.innerHTML = '';
          for (let i = 0; i < 9; i++) {
            const cell = document.createElement('button');
            cell.className = 'cell';
            cell.addEventListener('click', () => handleClick(i));
            boardEl.appendChild(cell);
          }
          updateStatus();
        }
        function handleClick(index) {
          if (gameOver || board[index] !== '') return;
          board[index] = currentPlayer;
          boardEl.children[index].textContent = currentPlayer;
          if (checkWin()) {
            statusEl.textContent = 'Player ' + currentPlayer + ' wins!';
            gameOver = true;
            return;
          }
          if (board.every(c => c !== '')) {
            statusEl.textContent = "It's a draw!";
            gameOver = true;
            return;
          }
          currentPlayer = currentPlayer === 'X' ? 'O' : 'X';
          updateStatus();
        }
        function checkWin() {
          return WIN_PATTERNS.some(p => p.every(i => board[i] === currentPlayer));
        }
        function updateStatus() {
          statusEl.textContent = 'Player ' + currentPlayer + "'s turn";
        }
        restartBtn.addEventListener('click', () => {
          board = Array(9).fill('');
          currentPlayer = 'X';
          gameOver = false;
          createBoard();
        });
        createBoard();
      </script>
      </body></html>
    `;
    const result = ticTacToeContentSniff(html);
    expect(result.ok).toBe(true);
    expect(result.signals).toEqual(
      expect.arrayContaining(['name', 'grid', 'click', 'win-detect', 'js-parses', 'js-size-ok']),
    );
  });

  it('rejects an unrelated calculator app', () => {
    const html = `
      <html><body>
        <button onclick="add(1,2)">Compute</button>
        <div class="grid" style="display:grid;grid-template-columns:repeat(4,1fr);"></div>
        <script>function add(a,b){return a+b;}</script>
      </body></html>
    `;
    const result = ticTacToeContentSniff(html);
    expect(result.ok).toBe(false);
  });

  it('rejects a blank HTML page', () => {
    expect(ticTacToeContentSniff('<html><body></body></html>').ok).toBe(false);
  });

  it('rejects a tic-tac-toe-themed blog post (no JS, no grid)', () => {
    const html = `<html><body><article>I love tic-tac-toe. It's a great game.</article></body></html>`;
    expect(ticTacToeContentSniff(html).ok).toBe(false);
  });
});

describe('petShopContentSniff', () => {
  const goodHtml = `
    <!doctype html><html><head><title>Pawfect Pet Shop</title></head>
    <body>
      <header><h1>Pawfect Pet Shop</h1><nav>Home / Products / Adopt</nav></header>
      <main>
        <section class="hero"><img src="logo.png" alt="logo"/></section>
        <section class="products"><p>Browse our store for dog and cat supplies.</p></section>
      </main>
      <footer>Contact us</footer>
    </body></html>
  `;

  it('passes when the <img> resolves to a real workspace file', () => {
    const result = petShopContentSniff(goodHtml, {
      htmlPath: 'workspace/index.html',
      projectFiles: ['workspace/index.html', 'workspace/logo.png'],
      validRasterFiles: ['workspace/logo.png'],
    });
    expect(result.ok).toBe(true);
    expect(result.scoreMax).toBe(5);
    expect(result.signals).toEqual(
      expect.arrayContaining([
        'pet-vocab',
        'store-vocab',
        'structured-page',
        'working-image',
        'image-asset',
      ]),
    );
  });

  it('fails when the <img src> points at a nonexistent file (broken link)', () => {
    // The most common real-world failure: the model writes
    // `<img src="logo.png">` without generating the file. Sniff must reject.
    const result = petShopContentSniff(goodHtml, {
      htmlPath: 'workspace/index.html',
      projectFiles: ['workspace/index.html'],
      validRasterFiles: [],
    });
    expect(result.ok).toBe(false);
    expect(result.signals).not.toContain('working-image');
  });

  it('fails when the PNG exists but at a path that does not match the <img src>', () => {
    // The exact petshop trial 5 failure: HTML at workspace/pet-shop-website/
    // referencing artifacts/generated/X.png (which would resolve to
    // workspace/pet-shop-website/artifacts/generated/X.png) while the file
    // actually lives at <project>/artifacts/pet-shop-website/generated/X.png.
    const result = petShopContentSniff(
      `<html><body><header><h1>PawShop</h1></header><main><section><img src="artifacts/generated/logo.png"/></section><p>Pet store. Browse our products.</p></main></body></html>`,
      {
        htmlPath: 'workspace/pet-shop/index.html',
        projectFiles: ['workspace/pet-shop/index.html', 'artifacts/pet-shop/generated/logo.png'],
        validRasterFiles: ['artifacts/pet-shop/generated/logo.png'],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.signals).not.toContain('working-image');
    // image-asset still fires (a PNG exists somewhere) — useful diagnostic
    // distinct from working-image. Don't conflate them.
    expect(result.signals).toContain('image-asset');
  });

  it('passes when an <img> uses a relative ../ to reach the artifacts dir', () => {
    const result = petShopContentSniff(
      `<html><body><header><h1>Pet Shop</h1></header><main><section><img src="../../artifacts/pet-shop/generated/logo.png"/></section><p>Browse our store.</p></main></body></html>`,
      {
        htmlPath: 'workspace/pet-shop/index.html',
        projectFiles: ['workspace/pet-shop/index.html', 'artifacts/pet-shop/generated/logo.png'],
        validRasterFiles: ['artifacts/pet-shop/generated/logo.png'],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.signals).toContain('working-image');
  });

  it('accepts a valid raster reference with a cache-busting query suffix', () => {
    const result = petShopContentSniff(goodHtml.replace('logo.png', 'logo.png?v=2'), {
      htmlPath: 'workspace/index.html',
      projectFiles: ['workspace/index.html', 'workspace/logo.png'],
      validRasterFiles: ['workspace/logo.png'],
    });
    expect(result.ok).toBe(true);
    expect(result.signals).toContain('working-image');
  });

  it('does not count a hand-written SVG as the generated logo image', () => {
    const result = petShopContentSniff(
      `<html><body><header><h1>Pet Shop</h1></header><main><section><img src="assets/logo.svg"/></section><p>Browse our pet store.</p></main></body></html>`,
      {
        htmlPath: 'workspace/index.html',
        projectFiles: ['workspace/index.html', 'workspace/assets/logo.svg'],
        validRasterFiles: [],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.signals).not.toContain('working-image');
    expect(result.signals).not.toContain('image-asset');
  });

  it('rejects a generic landing page with no pet vocabulary', () => {
    const html = `
      <html><body>
        <header><h1>Acme Inc</h1></header>
        <main><img src="logo.png"/><section>Welcome to our shop</section></main>
      </body></html>`;
    const result = petShopContentSniff(html, {
      htmlPath: 'workspace/index.html',
      projectFiles: ['workspace/index.html', 'workspace/logo.png'],
      validRasterFiles: ['workspace/logo.png'],
    });
    expect(result.ok).toBe(false);
    expect(result.signals).not.toContain('pet-vocab');
  });

  it('rejects a pet article with no commercial framing or images', () => {
    const html =
      '<html><body><article>Dogs are wonderful pets. So are cats.</article></body></html>';
    const result = petShopContentSniff(html, {
      htmlPath: 'workspace/index.html',
      projectFiles: ['workspace/index.html'],
      validRasterFiles: [],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an extension-only PNG placeholder with no validated raster bytes', () => {
    const result = petShopContentSniff(goodHtml, {
      htmlPath: 'workspace/index.html',
      projectFiles: ['workspace/index.html', 'workspace/logo.png'],
      validRasterFiles: [],
    });
    expect(result.ok).toBe(false);
    expect(result.signals).not.toContain('working-image');
    expect(result.signals).not.toContain('image-asset');
  });
});

describe('tankCombatContentSniff', () => {
  it('passes a canvas-based tank game with full mechanics', () => {
    const html = `
      <!doctype html><html><body>
      <h1>Tank Combat Arcade</h1>
      <canvas id="game" width="800" height="600"></canvas>
      <script>
        const canvas = document.getElementById('game');
        const ctx = canvas.getContext('2d');
        const tank = { x: 100, y: 100, hp: 100 };
        const bullets = [];
        const enemies = [{x:400,y:300,hp:50}];
        let score = 0;
        document.addEventListener('keydown', e => {
          if (e.key === 'ArrowUp') tank.y -= 5;
          if (e.key === ' ') bullets.push({x:tank.x,y:tank.y,vx:0,vy:-8});
        });
        function tick() {
          for (const b of bullets) {
            for (const e of enemies) {
              if (Math.abs(b.x-e.x) < 20 && Math.abs(b.y-e.y) < 20) {
                e.hp -= 10; score++;
              }
            }
          }
          requestAnimationFrame(tick);
        }
        tick();
        ${jsFiller()}
      </script>
      </body></html>
    `;
    const result = tankCombatContentSniff(html);
    expect(result.ok).toBe(true);
    expect(result.signals).toEqual(
      expect.arrayContaining([
        'tank-vocab',
        'render-surface',
        'keyboard-input',
        'combat',
        'game-loop',
        'gameplay',
        'js-parses',
        'js-size-ok',
        'html-size-ok',
      ]),
    );
  });

  it('passes a minimal but playable SVG-based tank game', () => {
    const html = `
      <html><body>
      <svg id="arena" width="600" height="600">
        <rect id="tank1" width="40" height="40" fill="green"/>
      </svg>
      <script>
        const tank = document.getElementById('tank1');
        let x = 100, y = 100, score = 0;
        document.addEventListener('keydown', e => {
          if (e.key === 'w') y -= 10;
          if (e.key === 's') y += 10;
          if (e.key === ' ') fire();
        });
        function fire() { /* spawn bullet */ score += 1; }
        setInterval(() => { tank.setAttribute('x', x); tank.setAttribute('y', y); }, 1000/60);
        ${jsFiller()}
      </script>
      </body></html>
    `;
    const result = tankCombatContentSniff(html);
    expect(result.ok).toBe(true);
  });

  it('rejects a functional but sub-4KB tank game so the model can improve quality', () => {
    const html = `
      <html><body><h1>Tank Combat Arcade</h1><canvas id="game" width="640" height="420"></canvas>
      <script>
        const canvas=document.getElementById('game'),ctx=canvas.getContext('2d');
        const gameState={player:{x:90,y:210,hp:3},enemy:{x:480,y:210,hp:3},bullets:[],score:0,keys:{},inputTick:0};
        window.gameState=gameState;
        document.addEventListener('keydown',e=>{gameState.keys[e.key]=true;gameState.inputTick++;document.body.dataset.inputTick=String(gameState.inputTick);if(e.key===' ')gameState.bullets.push({x:gameState.player.x+18,y:gameState.player.y,vx:6});});
        document.addEventListener('keyup',e=>{gameState.keys[e.key]=false;});
        function hit(a,b){return Math.abs(a.x-b.x)<28&&Math.abs(a.y-b.y)<28}
        function update(){if(gameState.keys.ArrowUp||gameState.keys.w)gameState.player.y-=3;if(gameState.keys.ArrowDown||gameState.keys.s)gameState.player.y+=3;for(const bullet of gameState.bullets){bullet.x+=bullet.vx;if(hit(bullet,gameState.enemy)){gameState.enemy.hp--;gameState.score++;bullet.dead=true;}}gameState.bullets=gameState.bullets.filter(b=>!b.dead&&b.x<640);}
        function draw(){ctx.clearRect(0,0,640,420);ctx.fillText('Score '+gameState.score,20,20);ctx.fillRect(gameState.player.x,gameState.player.y,34,34);ctx.strokeRect(gameState.enemy.x,gameState.enemy.y,34,34);for(const b of gameState.bullets)ctx.fillRect(b.x,b.y,8,4);}
        function loop(){update();draw();requestAnimationFrame(loop)}loop();
      </script></body></html>
    `;
    expect(html.length).toBeLessThan(4096);
    const result = tankCombatContentSniff(html, { minInlineJsBytes: 1000 });
    expect(result.ok).toBe(false);
    expect(result.signals).toEqual(
      expect.arrayContaining([
        'tank-vocab',
        'render-surface',
        'keyboard-input',
        'combat',
        'game-loop',
        'gameplay',
        'js-parses',
        'js-size-ok',
      ]),
    );
    expect(result.signals).not.toContain('html-size-ok');
    expect(result.missingRequiredSignals).toEqual(['html-size-ok']);
    expect(result.failReason).toMatch(/functional but minimal/);
    expect(result.failReason).toMatch(/Add at least 2/);
  });

  // The literal failure from the matrix: a 1.5 KB tank-
  // combat HTML whose JS ends `let|` mid-declaration. The keyword
  // signals all fire; only the new JS-parse signal rejects it.
  it('rejects HTML with truncated JS (`let|` mid-declaration)', () => {
    const html = `
      <html><body>
      <h1>Tank Combat Arcade</h1>
      <canvas id="c" width="900" height="640"></canvas>
      <script>
        const C=document.getElementById('c'),X=C.getContext('2d');
        document.addEventListener('keydown', () => {});
        let score=0, wave=1, lives=3, gameState='menu';
        let player,enemies,bullets,particles,waveTimer=0,spawnCount=0,maxSpawns;
        function tick() { requestAnimationFrame(tick); }
        const bullets2 = [], collisions = [], hits = 0;
        let|
      </script>
      </body></html>
    `;
    const result = tankCombatContentSniff(html);
    expect(result.ok).toBe(false);
    expect(result.signals).not.toContain('js-parses');
    expect(result.failReason).toMatch(/inline JS does not parse/);
  });

  it('rejects a static page that mentions tanks but has no gameplay', () => {
    const html =
      '<html><body><h1>About tanks</h1><p>Tanks are armored fighting vehicles.</p></body></html>';
    const result = tankCombatContentSniff(html);
    expect(result.ok).toBe(false);
    // tank-vocab + the vacuous js-parses (no scripts present) fire;
    // js-size-ok doesn't (zero bytes); other signals don't (no gameplay).
    expect(result.signals).toEqual(expect.arrayContaining(['tank-vocab', 'js-parses']));
    expect(result.signals).not.toContain('js-size-ok');
  });

  it('rejects a generic shooter that does not mention tanks', () => {
    const html = `
      <html><body><canvas id="g"></canvas><script>
        document.addEventListener('keydown', () => {});
        function tick() { requestAnimationFrame(tick); } tick();
        const bullets = []; let score = 0;
      </script></body></html>
    `;
    const result = tankCombatContentSniff(html);
    expect(result.signals).not.toContain('tank-vocab');
    expect(result.ok).toBe(false);
  });
});
