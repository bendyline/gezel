import { describe, expect, it } from 'vitest';
import {
  rejectHtmlWithScriptOutsideScriptTag,
  rejectRegressiveHtmlOverwrite,
} from './workspace-write-quality.js';

const workingHtml = `
<!DOCTYPE html>
<html>
<body>
  <div id="status">X's turn</div>
  <div class="board">
    ${Array.from({ length: 9 }, (_, i) => `<button class="cell" data-cell="${i}"></button>`).join('\n')}
  </div>
  <script>
    const cells = Array.from(document.querySelectorAll('.cell'));
    const status = document.getElementById('status');
    const winningLines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    const state = Array(9).fill('');
    let currentPlayer = 'X';
    let gameOver = false;
    function winnerFor(player) {
      return winningLines.find((line) => line.every((index) => state[index] === player));
    }
    function handleClick(event) {
      const cell = event.currentTarget;
      const index = Number(cell.dataset.cell);
      if (gameOver || state[index]) return;
      state[index] = currentPlayer;
      cell.textContent = currentPlayer;
      const winningLine = winnerFor(currentPlayer);
      if (winningLine) {
        gameOver = true;
        status.textContent = currentPlayer + ' wins!';
        winningLine.forEach((i) => cells[i].classList.add('winner'));
        return;
      }
      if (state.every(Boolean)) {
        gameOver = true;
        status.textContent = 'Draw game';
        return;
      }
      currentPlayer = currentPlayer === 'X' ? 'O' : 'X';
      status.textContent = currentPlayer + "'s turn";
    }
    cells.forEach((cell) => cell.addEventListener('click', handleClick));
  </script>
</body>
</html>
`;

describe('rejectRegressiveHtmlOverwrite', () => {
  it('rejects replacing a working interactive HTML file with a weaker shell', () => {
    const weakHtml = `
<!DOCTYPE html>
<html><body>
  <table><tr><td class="cell"></td><td class="cell"></td><td class="cell"></td></tr></table>
  <script>document.body.onclick = () => {};</script>
</body></html>
`;

    const message = rejectRegressiveHtmlOverwrite('index.html', workingHtml, weakHtml);
    expect(message).toContain('Refusing to overwrite index.html');
    expect(message).toContain('proposed replacement is weaker');
  });

  it('allows a complete replacement that preserves interaction signals', () => {
    const improved = workingHtml.replace(
      '</body>',
      '<p>Score: <span id="score">0</span></p></body>',
    );
    expect(rejectRegressiveHtmlOverwrite('index.html', workingHtml, improved)).toBeNull();
  });

  it('does not block first writes', () => {
    expect(rejectRegressiveHtmlOverwrite('index.html', null, workingHtml)).toBeNull();
  });
});

describe('rejectHtmlWithScriptOutsideScriptTag', () => {
  it('rejects a line patch that leaves following HTML inside an unclosed style block', () => {
    const broken = `
<!DOCTYPE html>
<html>
<head>
<style>
body { color: #172b4d; }
<form id="addForm">
  <input id="taskInput">
</form>
<script>console.log("still balanced");</script>
</body>
</html>
`;

    const message = rejectHtmlWithScriptOutsideScriptTag('index.html', broken);
    expect(message).toContain('HTML has 1 <style> opening tag(s) but 0 </style>');
    expect(message).toContain('following HTML markup parse as CSS');
  });

  it('rejects JavaScript declarations emitted outside the script block', () => {
    const broken = `
<!DOCTYPE html>
<html>
<body>
  <h1>Tic Tac Toe</h1>
  <script>console.log("Game started");</script>
  const cells = document.querySelectorAll(".cell");
  const winningLines = [[0,1,2],[3,4,5],[6,7,8]];
  function handleClick(event) {}
</body>
</html>
`;

    const message = rejectHtmlWithScriptOutsideScriptTag('index.html', broken);
    expect(message).toContain('JavaScript-looking code outside');
    expect(message).toContain('<script>...</script>');
  });

  it('points module-shell HTML repairs at referenced JS modules', () => {
    const broken = `
<!DOCTYPE html>
<html>
<body>
  <div id="app"></div>
  <script type="module" src="./src/app.js"></script>
  const app = document.querySelector("#app");
  app.addEventListener("click", () => {});
</body>
</html>
`;

    const message = rejectHtmlWithScriptOutsideScriptTag('index.html', broken);
    expect(message).toContain('external module script');
    expect(message).toContain('referenced .js module files');
    expect(message).not.toContain('inside one complete inline <script>');
  });

  it('allows JavaScript inside a complete inline script block', () => {
    expect(rejectHtmlWithScriptOutsideScriptTag('index.html', workingHtml)).toBeNull();
  });

  it('allows JavaScript-looking identifiers in HTML attributes', () => {
    const html = `
<!DOCTYPE html>
<html>
<body>
  <div id="gameOver" data-state="currentPlayer">
    <button onclick="resetGame()">Play Again</button>
  </div>
  <script>
    const gameOver = document.getElementById('gameOver');
    function resetGame() {
      gameOver.hidden = true;
      requestAnimationFrame(() => {});
    }
  </script>
</body>
</html>
`;

    expect(rejectHtmlWithScriptOutsideScriptTag('index.html', html)).toBeNull();
  });

  it('allows complete style and script blocks', () => {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <style>body { color: #172b4d; }</style>
</head>
<body>
  <button id="go">Go</button>
  <script>document.getElementById("go").onclick = () => {};</script>
</body>
</html>
`;
    expect(rejectHtmlWithScriptOutsideScriptTag('index.html', html)).toBeNull();
  });
});
