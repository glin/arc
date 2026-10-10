import assert from 'node:assert';
import { test, type TestContext } from 'vitest';
import { browserOrNone, SETTLED } from '../../test/browser.ts';
import { pageHtml, renderPayload } from '../panelfixture.ts';

type Page = import('playwright-core').Page;

function file(id: string, name: string, preview: string | null = null) {
  const dot = name.lastIndexOf('.');
  return {
    id,
    label: `${name}, 1 B`,
    name,
    size: 1,
    preview,
    kind: preview ? 'image' : 'TXT',
    stem: dot < 0 ? name : name.slice(0, dot),
    ext: dot < 0 ? '' : name.slice(dot),
    sizeLabel: '1 B',
    removeLabel: 'Remove',
    removeName: `Remove attached file ${name}`,
    removeControl: `removeFile:${id}`,
  };
}

async function post(page: Page, payload: unknown): Promise<void> {
  await page.evaluate(`window.postMessage(${JSON.stringify(payload)}, '*')`);
  await page.evaluate(SETTLED);
}

async function pageFor(t: TestContext): Promise<{ page: Page; close(): Promise<void> } | null> {
  const browser = await browserOrNone();
  if (!browser) {
    t.skip('Edge or Chrome is required');
  }
  const page = await browser.newPage();
  await page.setContent(pageHtml());
  return { page, close: () => browser.close() };
}

async function startRead(page: Page, names: string[], origin: 'paste' | 'drop' = 'paste'): Promise<string> {
  return (await page.evaluate(`(() => {
    window.__attachmentReads = [];
    const file = (name) => ({ name, type: 'image/png', size: 1, arrayBuffer: () => new Promise((resolve) => window.__attachmentReads.push(resolve)) });
    const event = new Event(${JSON.stringify(origin)}, { bubbles: true, cancelable: true });
    Object.defineProperty(event, ${JSON.stringify(origin === 'paste' ? 'clipboardData' : 'dataTransfer')}, { value: { files: ${JSON.stringify(names)}.map(file), types: ['Files'] } });
    document.getElementById(${JSON.stringify(origin === 'paste' ? 'prompt' : 'composer')}).dispatchEvent(event);
    return window.__posted.at(-1).token;
  })()`)) as string;
}

test('Composer attachments retain chip details, removal scope, focus, and sibling identity', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  try {
    const payload = renderPayload() as any;
    payload.usage.composer.files = [
      file('image', 'diagram.png', 'data:image/png;base64,aQ=='),
      file('text', 'notes.txt'),
    ];
    await post(held.page, payload);
    const image = held.page.locator('.cfile').first();
    assert.equal(await image.locator('.cthumb').count(), 1);
    assert.equal(await held.page.locator('.cfile').nth(1).locator('.ckind').textContent(), 'TXT');
    assert.equal(await held.page.locator('.cfile').nth(1).locator('.cstem').getAttribute('title'), 'notes.txt');
    assert.equal(await held.page.locator('.cfile').nth(1).locator('.cext').textContent(), '.txt');
    assert.equal(await held.page.locator('.cfile').nth(1).locator('.csize').textContent(), '1 B');
    assert.equal(await image.getAttribute('aria-label'), 'diagram.png, 1 B');
    assert.equal(await image.locator('.cfileremove').getAttribute('aria-label'), 'Remove attached file diagram.png');
    payload.usage.composer.notice = 'The host refused this attachment.';
    await post(held.page, { type: 'usage', usage: payload.usage });
    assert.equal(await held.page.locator('.cnotice[role="status"]').textContent(), 'The host refused this attachment.');
    await held.page.evaluate(`window.__attachmentSibling = document.querySelectorAll('.cfile .cstem')[1]`);
    await image.locator('.cfileremove').focus();
    await image.locator('.cfileremove').click();
    assert.deepEqual(await held.page.evaluate(`window.__posted.filter((message) => message.type === 'removeFile')`), [
      { type: 'removeFile', session: 's1', value: 'image' },
    ]);
    await post(held.page, { type: 'usage', usage: payload.usage });
    assert.equal(await held.page.evaluate(`document.activeElement?.dataset.control`), 'removeFile:image');
    payload.usage.composer.files = [file('text', 'notes.txt')];
    await post(held.page, { type: 'usage', usage: payload.usage });
    assert.equal(
      await held.page.evaluate(`window.__attachmentSibling === document.querySelector('.cfile .cstem')`),
      true,
    );
    assert.equal(await held.page.evaluate(`document.activeElement?.dataset.control`), 'removeFile:text');
    assert.equal(await held.page.locator('.cnotice[role="status"]').textContent(), 'The host refused this attachment.');
    payload.usage.composer.files = [
      file('again', 'again.png', 'data:image/png;base64,aQ=='),
      file('survivor', 'survivor.txt'),
    ];
    await post(held.page, { type: 'usage', usage: payload.usage });
    await held.page.locator('[data-control="removeFile:again"]').focus();
    await held.page.locator('[data-control="removeFile:again"]').click();
    await held.page.locator('#prompt').focus();
    payload.usage.composer.files = [file('survivor', 'survivor.txt')];
    await post(held.page, { type: 'usage', usage: payload.usage });
    assert.equal(await held.page.evaluate(`document.activeElement?.id`), 'prompt');
  } finally {
    await held.close();
  }
});

test('browser staging survives adoption, unrelated updates, and rejected late reads', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  try {
    await post(held.page, renderPayload());
    const token = await startRead(held.page, ['first.png', 'second.png']);
    await post(held.page, { type: 'fileStaging', session: 'thread-one', token, pending: true });
    await post(held.page, { type: 'fileStaging', session: 's1', token, pending: false });
    assert.equal(await held.page.locator('.cfilepending').count(), 0);
    const adopted = renderPayload() as any;
    adopted.usage.composer.sessionId = 'thread-one';
    adopted.usage.composer.targetName = 'Adopted session';
    await post(held.page, { type: 'usage', usage: adopted.usage });
    assert.match((await held.page.locator('.cfilepending').textContent()) ?? '', /^Attaching 2 files/);
    adopted.showing = 'thread-one';
    await post(held.page, adopted);
    assert.match((await held.page.locator('.cfilepending').textContent()) ?? '', /^Attaching 2 files/);
    const queued = structuredClone(adopted.usage);
    queued.composer.queue = [
      {
        id: 'unrelated',
        label: 'Unrelated queued prompt',
        text: 'Unrelated queued prompt',
        long: false,
        openName: 'Show unrelated',
        shutName: 'Hide unrelated',
        control: 'queue:unrelated:open',
        dropName: 'Drop unrelated',
        dropControl: 'queue:unrelated:drop',
        dropLabel: 'Drop',
        editName: 'Edit unrelated',
        editControl: 'queue:unrelated:edit',
        editLabel: 'Edit',
        copyText: 'Unrelated queued prompt',
        copyName: 'Copy unrelated',
        copyControl: 'queue:unrelated:copy',
        at: 1,
        relative: 'now',
        absolute: 'now',
        agent: 'Claude',
        headName: 'Queued unrelated',
        status: 'Waiting to send',
        reason: '',
        files: [],
      },
    ];
    await post(held.page, { type: 'usage', usage: queued });
    assert.match((await held.page.locator('.cfilepending').textContent()) ?? '', /^Attaching 2 files/);
    await post(held.page, { type: 'live', session: 'thread-one', live: [] });
    assert.match((await held.page.locator('.cfilepending').textContent()) ?? '', /^Attaching 2 files/);
    await post(held.page, { type: 'askRejected', session: 'thread-one', id: 'unrelated-request' });
    assert.match((await held.page.locator('.cfilepending').textContent()) ?? '', /^Attaching 2 files/);
    await post(held.page, { type: 'fileStagingRejected', session: 'thread-one', token });
    await held.page.evaluate(`window.__attachmentReads.splice(0).forEach((resolve) => resolve(new ArrayBuffer(1)))`);
    await held.page.evaluate(SETTLED);
    assert.equal(
      await held.page.evaluate(
        `window.__posted.some((message) => message.type === 'attachFiles' && message.token === ${JSON.stringify(token)})`,
      ),
      false,
    );
    assert.equal(await held.page.locator('.cfilepending').count(), 0);
  } finally {
    await held.close();
  }
});

test('paste and drop preserve origin, leave text paste alone, refuse busy batches, and clear drag state', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  try {
    await post(held.page, renderPayload());
    assert.equal(
      await held.page.evaluate(
        `(() => { const event = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { files: [] } }); document.getElementById('prompt').dispatchEvent(event); return event.defaultPrevented; })()`,
      ),
      false,
    );
    const token = await startRead(held.page, ['pasted.png']);
    await held.page.evaluate(
      `(() => { const event = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { files: [{ name: 'busy.png', type: 'image/png', size: 1, arrayBuffer: async () => new ArrayBuffer(1) }] } }); document.getElementById('prompt').dispatchEvent(event); })()`,
    );
    assert.equal(await held.page.evaluate(`window.__posted.at(-1).code`), 'busy');
    await held.page.evaluate(`window.__attachmentReads.splice(0).forEach((resolve) => resolve(new ArrayBuffer(1)))`);
    await held.page.evaluate(SETTLED);
    assert.equal(
      await held.page.evaluate(`window.__posted.filter((message) => message.type === 'attachFiles').at(-1).clipboard`),
      true,
    );
    await post(held.page, { type: 'fileStaging', session: 's1', token, pending: false });
    const dropped = await startRead(held.page, ['dropped.png'], 'drop');
    await held.page.evaluate(`window.__attachmentReads.splice(0).forEach((resolve) => resolve(new ArrayBuffer(1)))`);
    await held.page.evaluate(SETTLED);
    assert.equal(
      await held.page.evaluate(`window.__posted.filter((message) => message.type === 'attachFiles').at(-1).clipboard`),
      false,
    );
    await held.page.evaluate(
      `(() => { const composer = document.getElementById('composer'); composer.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })); composer.dispatchEvent(new DragEvent('dragleave', { bubbles: true })); })()`,
    );
    assert.equal(await held.page.locator('#composer').evaluate((node) => node.classList.contains('dropping')), false);
    await post(held.page, { type: 'fileStaging', session: 's1', token: dropped, pending: false });
  } finally {
    await held.close();
  }
});

test('attachment refusals post once and leave unrelated staging intact', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  try {
    const payload = renderPayload() as any;
    payload.usage.composer.files = Array.from({ length: 8 }, (_, at) => file(`held-${at}`, `held-${at}.txt`));
    await post(held.page, payload);
    const refuse = async (files: unknown[]): Promise<{ code: string }> =>
      (await held.page.evaluate(`(() => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { files: ${JSON.stringify(files)}.map((file) => ({ ...file, arrayBuffer: async () => new ArrayBuffer(1) })) } });
      document.getElementById('prompt').dispatchEvent(event); return window.__posted.at(-1);
    })()`)) as { code: string };
    assert.equal((await refuse([{ name: 'overflow.txt', type: 'text/plain', size: 1 }])).code, 'count');
    assert.equal(
      await held.page.evaluate(
        `window.__posted.filter((message) => message.type === 'fileRejected' && message.code === 'count').length`,
      ),
      1,
    );
    assert.equal(await held.page.locator('.cfilepending').count(), 0);
    payload.usage.composer.files = [];
    await post(held.page, payload);
    assert.equal(
      (await refuse([{ name: 'large.bin', type: 'application/octet-stream', size: 8 * 1024 * 1024 }])).code,
      'file-size',
    );
    assert.equal(
      await held.page.evaluate(
        `window.__posted.filter((message) => message.type === 'fileRejected' && message.code === 'file-size').length`,
      ),
      1,
    );
    assert.equal(await held.page.locator('.cfilepending').count(), 0);
    assert.equal(
      (
        await refuse(
          Array.from({ length: 3 }, (_, at) => ({
            name: `total-${at}.bin`,
            type: 'application/octet-stream',
            size: 7 * 1024 * 1024,
          })),
        )
      ).code,
      'total-size',
    );
    assert.equal(
      await held.page.evaluate(
        `window.__posted.filter((message) => message.type === 'fileRejected' && message.code === 'total-size').length`,
      ),
      1,
    );
    assert.equal(await held.page.locator('.cfilepending').count(), 0);
    const first = await startRead(held.page, ['first.png']);
    assert.equal((await refuse([{ name: 'busy.png', type: 'image/png', size: 1 }])).code, 'busy');
    assert.equal(
      await held.page.evaluate(
        `window.__posted.filter((message) => message.type === 'fileRejected' && message.code === 'busy').length`,
      ),
      1,
    );
    assert.match((await held.page.locator('.cfilepending').textContent()) ?? '', /^Attaching 1 file/);
    await post(held.page, { type: 'fileStagingRejected', session: 's1', token: first });
    await held.page.evaluate(`window.__attachmentReads.splice(0).forEach((resolve) => resolve(new ArrayBuffer(1)))`);
    await held.page.evaluate(SETTLED);
    assert.equal(await held.page.locator('.cfilepending').count(), 0);
    await held.page.evaluate(
      `(() => { const event = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { files: [{ name: 'broken.png', type: 'image/png', size: 1, arrayBuffer: () => Promise.reject(new Error('read failed')) }] } }); document.getElementById('prompt').dispatchEvent(event); })()`,
    );
    await held.page.evaluate(SETTLED);
    assert.equal(
      await held.page.evaluate(
        `window.__posted.filter((message) => message.type === 'fileReadError' && message.name === 'broken.png').length`,
      ),
      1,
    );
    assert.equal(
      await held.page.evaluate(
        `window.__posted.filter((message) => message.type === 'attachFiles' && message.files.some((file) => file.name === 'broken.png')).length`,
      ),
      0,
    );
    assert.equal(await held.page.locator('.cfilepending').count(), 0);
  } finally {
    await held.close();
  }
});

test('a drop that carries URI types and no Files goes to the host as paths, and the reply inserts text and no chip', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  try {
    await post(held.page, renderPayload());
    const outcome = (await held.page.evaluate(`(() => {
      const data = { resourceurls: JSON.stringify(['file:///w/src/a.ts']), 'text/plain': '/w/src/a.ts' };
      const make = (name) => {
        const event = new Event(name, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { files: [], types: ['resourceurls', 'text/plain'], getData: (type) => data[type] ?? '' } });
        return event;
      };
      const composer = document.getElementById('composer');
      composer.dispatchEvent(make('dragenter'));
      const dropping = composer.classList.contains('dropping');
      const drop = make('drop');
      composer.dispatchEvent(drop);
      return { dropping, prevented: drop.defaultPrevented, posted: window.__posted.at(-1) };
    })()`)) as { dropping: boolean; prevented: boolean; posted: any };
    assert.equal(outcome.dropping, true);
    assert.equal(outcome.prevented, true);
    assert.equal(outcome.posted.type, 'dropUris');
    assert.deepEqual(outcome.posted.types, ['resourceurls', 'text/plain']);
    assert.deepEqual(outcome.posted.values, [{ type: 'resourceurls', data: '["file:///w/src/a.ts"]' }]);
    assert.equal(await held.page.locator('#composer').evaluate((node) => node.classList.contains('dropping')), false);
    await post(held.page, { type: 'insertPrompt', session: 's1', text: 'src/a.ts' });
    assert.equal(await held.page.locator('#prompt').inputValue(), 'src/a.ts ');
    assert.equal(
      await held.page.evaluate(`window.__posted.filter((message) => message.type === 'draft').at(-1).text`),
      'src/a.ts ',
    );
    assert.equal(await held.page.locator('.cfile').count(), 0);
    assert.equal(
      await held.page.evaluate(
        `window.__posted.some((message) => message.type === 'attachFiles' || message.type === 'beginFileStaging')`,
      ),
      false,
    );
  } finally {
    await held.close();
  }
});

test('Add to Arc text restores a collapsed Prompt box and lands in the draft', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  try {
    await post(held.page, renderPayload());
    await held.page.locator('#composer-collapse').click();
    await held.page.evaluate(SETTLED);
    assert.equal(
      await held.page.locator('#composer').evaluate((node) => node.classList.contains('composer-hidden')),
      true,
    );
    await post(held.page, { type: 'insertPrompt', session: 's1', text: 'src/a.ts' });
    assert.equal(
      await held.page.locator('#composer').evaluate((node) => node.classList.contains('composer-hidden')),
      false,
    );
    assert.equal(await held.page.locator('#composer-restore').isHidden(), true);
    assert.equal(await held.page.locator('#prompt').inputValue(), 'src/a.ts ');
  } finally {
    await held.close();
  }
});

test('a web link dropped with only text/uri-list keeps the default text drop, and a file: list goes to the host', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  try {
    await post(held.page, renderPayload());
    const drop = async (data: string) =>
      (await held.page.evaluate(`(() => {
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { files: [], types: ['text/uri-list', 'text/plain'], getData: (type) => type === 'text/uri-list' ? ${JSON.stringify(data)} : '' } });
        const before = window.__posted.length;
        document.getElementById('composer').dispatchEvent(event);
        return { prevented: event.defaultPrevented, posted: window.__posted.slice(before).map((message) => message.type) };
      })()`)) as { prevented: boolean; posted: string[] };
    assert.deepEqual(await drop('# a link\r\nhttps://example.com/page\r\n'), { prevented: false, posted: [] });
    assert.deepEqual(await drop('file:///w/src/a.ts\r\n'), { prevented: true, posted: ['dropUris'] });
  } finally {
    await held.close();
  }
});

test('a host-staged batch counts every file in the Attaching notice', async (t) => {
  const held = await pageFor(t);
  if (!held) return;
  try {
    await post(held.page, renderPayload());
    await post(held.page, { type: 'fileStaging', session: 's1', token: 'uri:1', pending: true, count: 3 });
    assert.match((await held.page.locator('.cfilepending').textContent()) ?? '', /^Attaching 3 files/);
    await post(held.page, { type: 'fileStaging', session: 's1', token: 'uri:1', pending: false });
    assert.equal(await held.page.locator('.cfilepending').count(), 0);
  } finally {
    await held.close();
  }
});
