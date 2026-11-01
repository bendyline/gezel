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
    frame.srcdoc = `${shim}<main style="max-width:600px"><h1>My workspace</h1><input aria-label="Draft" value="Keep this"><button onclick="document.querySelector('dialog').showModal()">Open dialog</button></main><dialog><button onclick="this.parentElement.close()">Close dialog</button></dialog><script>window.layout=gezel.ui.components.appLayout('main',{title:'Your companion'});</script>`;
  }, shim);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('gezel-chat')).toHaveCount(1);
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

test('conditional fields are omitted and asynchronous option updates preserve the form draft', async ({
  page,
}) => {
  await page.setContent(`<script>${pageDemoBootstrapSource()}</script><div id="form"></div><script>
window.calls=[];
const api=window.makeDemoGezel({tools:{save:input=>{window.calls.push(input);return {};}}});
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
  await expect(page.getByRole('status')).toHaveText('Saved.');
  expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toEqual([
    { stage: 'screening', note: 'Keep this note' },
  ]);
  await page.getByLabel('Stage', { exact: true }).selectOption('closed');
  await expect(page.getByLabel('Outcome', { exact: true })).toBeVisible();
});
