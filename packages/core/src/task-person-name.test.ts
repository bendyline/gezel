import { describe, expect, it } from 'vitest';
import type { Task, TaskCraftbookStep } from './schemas/task.js';
import { taskPersonName, taskPersonNoun } from './task-person-name.js';

const book = { id: 'report-pdf', name: 'Formatted Report' };

const task = (title: string, steps: Partial<TaskCraftbookStep>[] = []): Task =>
  ({
    projectId: 'default',
    num: 2,
    ref: 'default/2',
    artifactDir: 'tasks/2',
    title,
    craftbook: { ...book, steps: steps.map((s, i) => ({ id: `s${i}`, name: `s${i}`, ...s })) },
  }) as unknown as Task;

describe('taskPersonName', () => {
  it('keeps a title the person asked for', () => {
    expect(taskPersonName(task('Invoices for October'))).toBe('Invoices for October');
  });

  it("drops a title that is only the craftbook's name or id", () => {
    expect(taskPersonName(task('Formatted Report'))).toBeUndefined();
    expect(taskPersonName(task('formatted report.'))).toBeUndefined();
    expect(taskPersonName(task('report-pdf'))).toBeUndefined();
    expect(taskPersonName(task('  '))).toBeUndefined();
  });
});

describe('taskPersonNoun', () => {
  it('quotes the title, else names the promised file, else says the work', () => {
    expect(taskPersonNoun(task('Invoices for October'))).toBe('"Invoices for October"');
    expect(
      taskPersonNoun(
        task('Formatted Report', [{ advanceWhen: { file: 'pdf/task-2/report.pdf' } }]),
      ),
    ).toBe('your PDF');
    expect(taskPersonNoun(task('Formatted Report'))).toBe('the work');
  });
});
