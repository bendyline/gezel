import { describe, expect, it } from 'vitest';
import { renderAndAssert } from '../html-validation.ts';
import { checkTicTacToeWinningSequence, ticTacToeAssertions } from './tictactoe.ts';

describe('tic-tac-toe runtime verdict', () => {
  it('accepts alternating players followed by a visible winner', () => {
    expect(checkTicTacToeWinningSequence(['X', 'O', 'X', 'O', 'X'], ['Player X wins!'])).toEqual({
      ok: true,
    });
  });

  it('rejects a one-player click demo with no alternation', () => {
    const verdict = checkTicTacToeWinningSequence(['X', 'X', 'X', 'X', 'X'], ['Player X wins!']);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/alternate/);
  });

  it('rejects a completed line when no winner is shown', () => {
    const verdict = checkTicTacToeWinningSequence(['X', 'O', 'X', 'O', 'X'], ['X turn']);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/winner message/);
  });

  it('does not mistake a winner string in script source for a visible winner message', async () => {
    const html = `<!doctype html><html><body>
      <div id="status">Playing</div>
      <div>${Array.from({ length: 9 }, (_, i) => `<button class="cell" data-i="${i}"></button>`).join('')}</div>
      <script>
        const sourceOnlyWinnerCopy = 'Player X wins!';
        let turn = 'X';
        document.querySelectorAll('.cell').forEach((cell) => {
          cell.addEventListener('click', () => {
            if (cell.textContent) return;
            cell.textContent = turn;
            turn = turn === 'X' ? 'O' : 'X';
          });
        });
      </script>
    </body></html>`;
    const report = await renderAndAssert(html, ticTacToeAssertions());
    expect(report.ran).toBe(true);
    expect(report.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'click-marks-a-cell',
          why: expect.stringMatching(/winner/),
        }),
      ]),
    );
  });

  it('accepts the same driven game when the winner is rendered visibly', async () => {
    const html = `<!doctype html><html><body>
      <div id="status">Playing</div>
      <div>${Array.from({ length: 9 }, (_, i) => `<button class="cell" data-i="${i}"></button>`).join('')}</div>
      <script>
        let turn = 'X';
        const cells = Array.from(document.querySelectorAll('.cell'));
        cells.forEach((cell) => {
          cell.addEventListener('click', () => {
            if (cell.textContent) return;
            cell.textContent = turn;
            if (cells[0].textContent && cells[0].textContent === cells[1].textContent && cells[1].textContent === cells[2].textContent) {
              document.getElementById('status').textContent = 'Player ' + turn + ' wins!';
              return;
            }
            turn = turn === 'X' ? 'O' : 'X';
          });
        });
      </script>
    </body></html>`;
    const report = await renderAndAssert(html, ticTacToeAssertions());
    expect(report.ran).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.passed).toEqual(['nine-cells-rendered', 'click-marks-a-cell']);
  });
});
