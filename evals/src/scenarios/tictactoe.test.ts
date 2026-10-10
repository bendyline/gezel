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
    expect(report.ran, report.bootstrapError).toBe(true);
    expect(report.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'click-marks-a-cell',
          why: expect.stringMatching(/winner/),
        }),
      ]),
    );
  });

  it.each([
    { markup: 'Player X wins!', accepted: true },
    { markup: '🎉 Player <span class="x">X</span> wins!', accepted: true },
    { markup: '<strong>Player X <span>wi</span>ns!</strong>', accepted: true },
    { markup: 'Playing<span hidden>Player X wins!</span>', accepted: false },
    { markup: '<div style="opacity:0"><span>Player X wins!</span></div>', accepted: false },
    { markup: '<div style="visibility:hidden"><span>Player X wins!</span></div>', accepted: false },
  ])('judges rendered status text: $markup', async ({ markup, accepted }) => {
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
              document.getElementById('status').innerHTML = ${JSON.stringify(markup)};
              return;
            }
            turn = turn === 'X' ? 'O' : 'X';
          });
        });
      </script>
    </body></html>`;
    const report = await renderAndAssert(html, ticTacToeAssertions());
    expect(report.ran, report.bootstrapError).toBe(true);
    if (accepted) {
      expect(report.failed).toEqual([]);
      expect(report.passed).toEqual(['nine-cells-rendered', 'click-marks-a-cell']);
    } else {
      expect(report.failed).toEqual([
        { name: 'click-marks-a-cell', why: expect.stringMatching(/winner/) },
      ]);
    }
  });
});
