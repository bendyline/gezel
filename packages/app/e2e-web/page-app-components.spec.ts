import { expect, test } from '@playwright/test';
import { buildPageApiShim } from '../../core/src/project-types/page-api-shim.js';
import { pageDemoBootstrapSource } from '../../core/src/project-types/page-demo.js';

test('application layout preserves content and chat through restore, hide, and page dialogs', async ({
  page,
}) => {
  const shim = buildPageApiShim({
    api: 1,
    projectId: 'fixture',
    source: 'type',
    entry: 'index.html',
    typeName: 'Workspace',
    params: {},
    tools: [],
  });
  await page.setContent(
    '<iframe title="App" sandbox="allow-scripts" style="width:1200px;height:900px"></iframe>',
  );
  await page.evaluate((shim) => {
    const frame = document.querySelector('iframe')!;
    const messages: Record<string, unknown>[] = [];
    Reflect.set(window, 'messages', messages);
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || event.data?.__gezelPage !== 1) return;
      messages.push(event.data);
      if (event.data.kind === 'hello')
        frame.contentWindow!.postMessage(
          { __gezelPage: 1, kind: 'init', layout: { fullscreen: true } },
          '*',
        );
      if (event.data.kind === 'chat-mount')
        frame.contentWindow!.postMessage(
          { __gezelPage: 1, kind: 'chat-result', id: event.data.id, ok: true },
          '*',
        );
    });
    frame.srcdoc = `${shim}<style>body{--line:rgb(10,20,30);color:rgb(40,50,60);font-size:19px}main{border:1px solid var(--line)}</style><main style="max-width:600px"><h1>My workspace</h1><input aria-label="Draft" value="Keep this"><button onclick="document.querySelector('dialog').showModal()">Open dialog</button></main><dialog><button onclick="this.parentElement.close()">Close dialog</button></dialog><script>window.layout=gezel.ui.components.appLayout('main',{title:'Your companion'});</script>`;
  }, shim);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('gezel-chat')).toHaveCount(1);
  await expect(frame.locator('main')).toHaveCSS('border-top-color', 'rgb(10, 20, 30)');
  await expect(frame.locator('main')).toHaveCSS('color', 'rgb(40, 50, 60)');
  await expect(frame.locator('main')).toHaveCSS('font-size', '19px');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (Reflect.get(window, 'messages') as Array<{ kind: string; rect?: { width: number } }>)
            .filter((m) => m.kind === 'chat-position')
            .at(-1)?.rect?.width ?? 0,
      ),
    )
    .toBeGreaterThan(200);
  await frame.getByRole('button', { name: 'Open dialog', exact: true }).click();
  await expect(frame.getByRole('dialog')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (Reflect.get(window, 'messages') as Array<{ kind: string; rect?: { width: number } }>)
            .filter((m) => m.kind === 'chat-position')
            .at(-1)?.rect?.width,
      ),
    )
    .toBe(0);
  await frame.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await frame.getByRole('button', { name: 'Hide conversation' }).click();
  await frame.getByRole('button', { name: 'Show conversation' }).click();
  await page.evaluate(() =>
    document
      .querySelector('iframe')!
      .contentWindow!.postMessage(
        { __gezelPage: 1, kind: 'layout', layout: { fullscreen: false } },
        '*',
      ),
  );
  await expect(frame.getByLabel('Draft')).toHaveValue('Keep this');
  await expect(frame.locator('main')).toHaveCSS('max-width', '600px');
  expect(
    await page.evaluate(
      () =>
        (Reflect.get(window, 'messages') as Array<{ kind: string }>).filter(
          (m) => m.kind === 'chat-mount',
        ).length,
    ),
  ).toBe(1);
});

test('action forms validate, serialize saves, preserve failed drafts, and distinguish refresh failure', async ({
  page,
}) => {
  await page.setContent(`<script>${pageDemoBootstrapSource()}</script><div id="form"></div><script>
window.calls=[];window.rejectSave=false;window.failRefresh=false;
const api=window.makeDemoGezel({tools:{save:async function(input){window.calls.push(input);await new Promise(resolve=>setTimeout(resolve,150));if(window.rejectSave)throw new Error('Permission denied');return {saved:true};}}});
window.form=api.ui.components.actionForm('#form',{title:'Save a note',tool:'save',fields:[{name:'name',label:'Name',required:true},{name:'amount',label:'Amount',type:'number',min:1,required:true}],mapInput:values=>({record:values}),onSaved:()=>{if(window.failRefresh)throw new Error('Read failed');}});
</script>`);
  await page.locator('summary').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toEqual([]);
  await page.getByLabel('Name', { exact: true }).fill('Keep my draft');
  await page.getByLabel('Amount', { exact: true }).fill('3');
  await page.evaluate(() => Reflect.set(window, 'rejectSave', true));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Permission denied');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Keep my draft');
  expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toEqual([
    { record: { name: 'Keep my draft', amount: 3 } },
  ]);
  await page.evaluate(() => {
    Reflect.set(window, 'rejectSave', false);
    Reflect.set(window, 'failRefresh', true);
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved, but the view could not refresh');
});

test('collection search handles accents, dynamic records, and safe text without remounting controls', async ({
  page,
}) => {
  await page.setContent(
    `<script>${pageDemoBootstrapSource()}</script><div id="filter"></div><ul id="records"><li>Café <button>Keep focus</button></li><li>Library</li></ul><script>window.filter=window.makeDemoGezel({}).ui.components.collectionFilter('#filter',{container:'#records',selector:'li',label:'Find a place'});</script>`,
  );
  await page.getByLabel('Find a place', { exact: true }).fill('cafe');
  await expect(page.locator('#records li:visible')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Keep focus' })).toBeVisible();
  await page.evaluate(() => {
    const item = document.createElement('li');
    item.textContent = 'Another café';
    document.querySelector('#records')!.append(item);
  });
  await expect(page.locator('#records li:visible')).toHaveCount(2);
  await page.getByLabel('Find a place', { exact: true }).fill('<img onerror=alert(1)>');
  await expect(page.getByRole('status')).toHaveText('0 of 3 matches');
  expect(await page.locator('img').count()).toBe(0);
});

test('collection search waits for a long enough list and counts only while filtering', async ({
  page,
}) => {
  await page.setContent(
    `<script>${pageDemoBootstrapSource()}</script><div id="filter"></div><ul id="records"><li>Ana</li><li>Ben</li></ul><script>window.makeDemoGezel({}).ui.components.collectionFilter('#filter',{container:'#records',selector:'li',label:'Find a person',placeholder:'Name or role',minItems:3});</script>`,
  );
  await expect(page.getByLabel('Find a person', { exact: true })).toBeHidden();
  await page.evaluate(() => {
    const item = document.createElement('li');
    item.textContent = 'Cleo';
    document.querySelector('#records')!.append(item);
  });
  const search = page.getByLabel('Find a person', { exact: true });
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute('placeholder', 'Name or role');
  await expect(page.getByRole('status')).toHaveText('');
  await search.fill('cl');
  await expect(page.getByRole('status')).toHaveText('1 of 3 matches');
});

test('conditional fields are omitted and asynchronous option updates preserve the form draft', async ({
  page,
}) => {
  await page.setContent(`<script>${pageDemoBootstrapSource()}</script><div id="form"></div><script>
window.calls=[];
const api=window.makeDemoGezel({tools:{save:input=>new Promise(resolve=>{window.calls.push(input);window.finishSave=resolve;})}});
window.form=api.ui.components.actionForm('#form',{title:'Update application',tool:'save',clearOnSave:false,fields:[{name:'stage',label:'Stage',required:true,options:['screening','closed']},{name:'outcome',label:'Outcome',required:true,options:['signed','withdrawn'],when:{field:'stage',equals:'closed'}},{name:'note',label:'Note'}]});
</script>`);
  await page.locator('summary').click();
  await expect(page.getByLabel('Outcome', { exact: true })).toBeHidden();
  await page.getByLabel('Note', { exact: true }).fill('Keep this note');
  await page.evaluate(() =>
    Reflect.get(window, 'form').update({ title: 'Update the application' }),
  );
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue('Keep this note');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel('Note', { exact: true })).toBeDisabled();
  await page.evaluate(() => {
    Reflect.get(window, 'form').update({ title: 'Latest application details' });
  });
  await expect(page.locator('summary')).toHaveText('Update the application');
  await page.evaluate(() => Reflect.get(window, 'finishSave')({}));
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await expect(page.locator('summary')).toHaveText('Latest application details');
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue('Keep this note');
  expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toEqual([
    { stage: 'screening', note: 'Keep this note' },
  ]);
  await page.getByLabel('Stage', { exact: true }).selectOption('closed');
  await expect(page.getByLabel('Outcome', { exact: true })).toBeVisible();
});

test('dialog action forms open from their key, save, close, return focus, and reopen prefilled', async ({
  page,
}) => {
  await page.setContent(`<script>${pageDemoBootstrapSource()}</script><div id="form"></div><ul><li>Ana <button id="edit-ana">Change hours</button></li></ul><script>
window.calls=[];window.saved=0;
const api=window.makeDemoGezel({tools:{save:function(input){window.calls.push(input);return new Promise(resolve=>{window.finishSave=()=>resolve({saved:true});});}}});
window.form=api.ui.components.actionForm('#form',{title:'Add a person',presentation:'dialog',primary:true,tool:'save',fields:[{name:'name',label:'Name',required:true},{name:'hours',label:'Weekly hours',type:'number',min:0}],onSaved:()=>{window.saved++;}});
document.getElementById('edit-ana').onclick=()=>window.form.open({name:'Ana',hours:20});
</script>`);
  const key = page.getByRole('button', { name: 'Add a person', exact: true });
  await expect(key).toHaveCSS('font-weight', '600');
  await expect(page.getByRole('dialog')).toBeHidden();
  await key.click();
  const dialog = page.getByRole('dialog', { name: 'Add a person' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('gezel-action-form')).toHaveAttribute('data-gezel-dialog-open', '');
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toEqual([]);
  await dialog.getByLabel('Name', { exact: true }).fill('Ben');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  // Escape is refused while the save is pending.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'finishSave')());
  await expect(dialog).toBeHidden();
  await expect(key).toBeFocused();
  await expect(page.locator('gezel-action-form')).not.toHaveAttribute('data-gezel-dialog-open');
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveCount(1);
  expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toEqual([{ name: 'Ben' }]);
  expect(await page.evaluate(() => Reflect.get(window, 'saved'))).toBe(1);

  await page.getByRole('button', { name: 'Change hours' }).click();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Ana');
  await expect(dialog.getByLabel('Weekly hours', { exact: true })).toHaveValue('20');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Change hours' })).toBeFocused();
});

test('a component dialog hides the host-drawn conversation while it is open', async ({ page }) => {
  const shim = buildPageApiShim({
    api: 1,
    projectId: 'fixture',
    source: 'type',
    entry: 'index.html',
    typeName: 'Workspace',
    params: {},
    tools: ['page_add'],
  });
  await page.setContent(
    '<iframe title="App" sandbox="allow-scripts" style="width:1200px;height:900px"></iframe>',
  );
  await page.evaluate((shim) => {
    const frame = document.querySelector('iframe')!;
    const messages: Record<string, unknown>[] = [];
    Reflect.set(window, 'messages', messages);
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || event.data?.__gezelPage !== 1) return;
      messages.push(event.data);
      if (event.data.kind === 'hello')
        frame.contentWindow!.postMessage(
          { __gezelPage: 1, kind: 'init', layout: { fullscreen: true } },
          '*',
        );
      if (event.data.kind === 'chat-mount')
        frame.contentWindow!.postMessage(
          { __gezelPage: 1, kind: 'chat-result', id: event.data.id, ok: true },
          '*',
        );
    });
    frame.srcdoc = `${shim}<main><h1>Roster</h1><div id="add"></div></main><script>gezel.ui.components.appLayout('main',{title:'At the desk'});gezel.ui.components.actionForm('#add',{title:'Add a shift',presentation:'dialog',tool:'page_add',fields:[{name:'date',label:'Date',type:'date',required:true}]});</script>`;
  }, shim);
  const frame = page.frameLocator('iframe');
  const lastWidth = () =>
    page.evaluate(
      () =>
        (Reflect.get(window, 'messages') as Array<{ kind: string; rect?: { width: number } }>)
          .filter((m) => m.kind === 'chat-position')
          .at(-1)?.rect?.width ?? 0,
    );
  await expect.poll(lastWidth).toBeGreaterThan(200);
  await frame.getByRole('button', { name: 'Add a shift', exact: true }).click();
  await expect(frame.getByRole('dialog', { name: 'Add a shift' })).toBeVisible();
  await expect.poll(lastWidth).toBe(0);
  await frame.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(lastWidth).toBeGreaterThan(200);
});

test('inline action forms stay open and reset to current values', async ({ page }) => {
  await page.setContent(`<script>${pageDemoBootstrapSource()}</script><div id="rules"></div><script>
window.calls=[];
const api=window.makeDemoGezel({tools:{save:async function(input){window.calls.push(input);return {};}}});
window.form=api.ui.components.actionForm('#rules',{title:'Scheduling rules',presentation:'inline',clearOnSave:false,tool:'save',fields:[{name:'maxWeekHours',label:'Most hours a week',type:'number',min:0}]});
window.form.reset({maxWeekHours:40});
</script>`);
  await expect(page.getByRole('heading', { name: 'Scheduling rules' })).toBeVisible();
  await expect(page.locator('summary')).toHaveCount(0);
  await expect(page.getByLabel('Most hours a week', { exact: true })).toHaveValue('40');
  await page.getByLabel('Most hours a week', { exact: true }).fill('38');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await expect(page.getByLabel('Most hours a week', { exact: true })).toHaveValue('38');
  expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toEqual([{ maxWeekHours: 38 }]);
});

test('tabs show one page-owned panel, follow the keyboard, badge counts, and remember the choice', async ({
  page,
}) => {
  await page.setContent(`<script>${pageDemoBootstrapSource()}</script><div id="tabs"></div><section id="home"><h2>Home</h2></section><section id="people"><h2>People</h2><button>Add a person</button></section><section id="settings"><h2>Settings</h2></section><script>
window.changes=[];
window.tabs=window.makeDemoGezel({}).ui.components.tabs('#tabs',{label:'Roster',tabs:[{id:'home',label:'Home',panel:'#home'},{id:'people',label:'People',panel:'#people',badge:3},{id:'settings',label:'Settings',panel:'#settings',badge:0}],onChange:id=>window.changes.push(id)});
</script>`);
  const list = page.getByRole('tablist', { name: 'Roster' });
  await expect(list.getByRole('tab')).toHaveCount(3);
  await expect(page.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Home' })).toBeVisible();
  await expect(page.locator('#people')).toBeHidden();
  await expect(page.getByRole('tab', { name: 'People 3' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Home' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'People 3' })).toBeFocused();
  await expect(page.locator('#people')).toBeVisible();
  await expect(page.locator('#home')).toBeHidden();
  await page.keyboard.press('End');
  await expect(page.locator('#settings')).toBeVisible();
  await page.keyboard.press('Home');
  await page.getByRole('tab', { name: 'People 3' }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'changes'))).toEqual([
    'people',
    'settings',
    'home',
    'people',
  ]);
  expect(await page.evaluate(() => location.hash)).toBe('#tab=people');
  await page.evaluate(() =>
    Reflect.get(window, 'tabs').update({ tabs: [{ id: 'home', label: 'Home', panel: '#home' }] }),
  );
  await expect(page.locator('#home')).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'tabs').destroy());
  await expect(page.locator('#people')).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
});
