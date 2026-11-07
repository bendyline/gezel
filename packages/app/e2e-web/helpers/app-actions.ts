import { type FrameLocator, type Locator, type Page, expect } from '@playwright/test';

export interface ControlInfo {
  tag: string;
  type: string | null;
  name: string | null;
}
type Root = Page | FrameLocator;
type Value = (control: ControlInfo) => string;
type Prefer = (control: ControlInfo, options: string[]) => string | undefined;

/** Fill every visible control in a form: selects take a preferred or the last option, inputs a typed value. */
export async function fillControls(scope: Locator, value: Value, prefer?: Prefer): Promise<void> {
  const controls = scope.locator('input, select, textarea');
  for (let i = 0; i < (await controls.count()); i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible())) continue;
    const info = {
      tag: await control.evaluate((e) => e.tagName),
      type: await control.getAttribute('type'),
      name: await control.getAttribute('name'),
    };
    if (info.tag === 'SELECT') {
      await expect(control.locator('option')).not.toHaveCount(0);
      const values = await control
        .locator('option')
        .evaluateAll((all) => all.map((option) => (option as HTMLOptionElement).value));
      await control.selectOption(prefer?.(info, values) ?? values[values.length - 1]);
    } else {
      await control.fill(value(info));
    }
  }
}

/** A required choice with nothing to choose yet, such as a shift to staff before anyone is on the roster. */
async function waitsForRecords(scope: Locator): Promise<boolean> {
  const selects = scope.locator('select');
  for (let i = 0; i < (await selects.count()); i++) {
    const select = selects.nth(i);
    if ((await select.isVisible()) && (await select.locator('option').count()) === 0) return true;
  }
  return false;
}

/**
 * Open, fill, and save one action form. A form whose required choice has no records yet is closed
 * and reported as waiting, so the caller can retry it after the forms that create those records.
 */
async function saveForm(
  form: Locator,
  value: Value,
  prefer: Prefer | undefined,
  timeout: number,
  last: boolean,
): Promise<'saved' | 'waiting' | 'skipped'> {
  const presentation = await form.getAttribute('data-presentation');
  if (presentation === 'dialog') {
    const key = form.locator('button.trigger');
    if (!(await key.isVisible())) return 'skipped';
    await key.click();
    const dialog = form.locator('dialog');
    await expect(dialog).toBeVisible();
    if (!last && (await waitsForRecords(dialog))) {
      await dialog.locator('.buttons button').first().click();
      await expect(dialog).toBeHidden();
      return 'waiting';
    }
    await fillControls(dialog, value, prefer);
    // The dialog's last button submits it, whatever the app labels it.
    await dialog.locator('.buttons button').last().click();
    await expect(dialog).toBeHidden({ timeout });
    await expect(form.locator('.flash')).toHaveText('Saved.');
    return 'saved';
  }
  if (presentation === 'inline') {
    if (!(await form.isVisible())) return 'skipped';
    if (!last && (await waitsForRecords(form))) return 'waiting';
    await fillControls(form, value, prefer);
    await form.getByRole('button').click();
    await expect(form.getByRole('status')).toHaveText('Saved.', { timeout });
    return 'saved';
  }
  if (!(await form.locator('summary').isVisible())) return 'skipped';
  await form.locator('summary').click();
  if (!last && (await waitsForRecords(form))) {
    await form.locator('summary').click();
    return 'waiting';
  }
  await fillControls(form, value, prefer);
  // An action form's one button submits it, whatever the app labels it.
  await form.getByRole('button').click();
  await expect(form.getByRole('status')).toHaveText('Saved.', { timeout });
  await form.locator('summary').click();
  return 'saved';
}

/**
 * Save every action form an app shows, tab by tab: keys that open dialogs, open settings forms, and the
 * expandable forms older pages use. Then open one row action's dialog filled in, and close it.
 */
export async function exerciseAppActions(
  root: Root,
  value: Value,
  options: {
    preferOption?: Prefer;
    timeout?: number;
    /** Leave a form unsaved when its choice is still empty, for a fresh project whose records moved on. */
    allowEmptyChoices?: boolean;
  } = {},
): Promise<{ saved: number; rowDialogs: number; unsaved: string[] }> {
  const timeout = options.timeout ?? 5_000;
  const tabs = root.locator('gezel-tabs [role="tab"]');
  const tabCount = await tabs.count();
  const forms = root.locator('gezel-action-form');
  const waiting: Array<{ tab: number; form: number }> = [];
  let saved = 0;
  let rowDialogs = 0;
  for (let t = 0; t < Math.max(tabCount, 1); t++) {
    if (tabCount) await tabs.nth(t).click();
    for (let i = 0; i < (await forms.count()); i++) {
      const outcome = await saveForm(forms.nth(i), value, options.preferOption, timeout, false);
      if (outcome === 'saved') saved++;
      if (outcome === 'waiting') waiting.push({ tab: t, form: i });
    }
    const row = root.locator('main [data-app-action]').filter({ visible: true }).first();
    if (await row.count()) {
      await row.click();
      const open = root.locator('gezel-action-form dialog[open]');
      await expect(open).toHaveCount(1);
      await open.locator('.buttons button').first().click();
      await expect(open).toHaveCount(0);
      rowDialogs++;
    }
  }
  // One waiting form can create the records another waits for, so retry until a pass saves nothing,
  // then make one last attempt that fails on any choice still empty.
  let pending = waiting;
  for (let progress = true; pending.length && progress; ) {
    const next: typeof waiting = [];
    for (const entry of pending) {
      if (tabCount) await tabs.nth(entry.tab).click();
      const outcome = await saveForm(
        forms.nth(entry.form),
        value,
        options.preferOption,
        timeout,
        false,
      );
      if (outcome === 'saved') saved++;
      else if (outcome === 'waiting') next.push(entry);
    }
    progress = next.length < pending.length;
    pending = next;
  }
  const unsaved: string[] = [];
  for (const { tab, form } of pending) {
    if (tabCount) await tabs.nth(tab).click();
    if (options.allowEmptyChoices) {
      unsaved.push(
        (await forms.nth(form).locator('button.trigger, h3, summary').first().innerText()).trim(),
      );
      continue;
    }
    if ((await saveForm(forms.nth(form), value, options.preferOption, timeout, true)) === 'saved')
      saved++;
  }
  if (tabCount) await tabs.first().click();
  return { saved, rowDialogs, unsaved };
}
