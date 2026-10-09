import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Page } from 'playwright-core';
import { pageHtml, themed } from '../src/panelfixture.ts';
import { CAPTURE_RAIL_WIDTH, CAPTURE_TIME, CAPTURE_ZONE, README_SCENES, readmePayload } from './readme-fixture.ts';
import { writeLosslessWebp } from './panel-shots.ts';
import { BROWSER_BUILD } from '../src/panelbundle.ts';
import { manifestMenu } from './web-demo-menu.ts';

const ROOT = path.resolve(__dirname, '../..');
const DESTINATION = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'docs/images');
const PROJECT_COST_FACE = '.projectspendrailhost .projectspendbutton';
const SETTLED = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))';

function buildPanel(): void {
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/c', 'npm', 'run', 'build'], {
          cwd: path.join(ROOT, 'extension'),
          stdio: 'inherit',
        })
      : spawnSync('npm', ['run', 'build'], { cwd: path.join(ROOT, 'extension'), stdio: 'inherit' });
  if (result.error || result.status !== 0)
    throw new Error(`Panel build failed: ${result.error?.message ?? result.status}`);
}

export function publish(staged: string, destination: string, copyFile: typeof fs.copyFileSync = fs.copyFileSync): void {
  const files = README_SCENES.map((scene) => `readme-${scene}.webp`);
  for (const name of files) {
    if (!fs.statSync(path.join(staged, name)).size) throw new Error(`${name} is empty`);
  }
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-readme-backup-'));
  const originals = files.filter((name) => fs.existsSync(path.join(destination, name)));
  let keepBackup = false;
  try {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of originals) copyFile(path.join(destination, name), path.join(backup, name));
    try {
      for (const name of files) copyFile(path.join(staged, name), path.join(destination, name));
    } catch (error) {
      const failed: string[] = [];
      for (const name of files) {
        try {
          if (originals.includes(name)) copyFile(path.join(backup, name), path.join(destination, name));
          else fs.rmSync(path.join(destination, name), { force: true });
        } catch {
          failed.push(name);
        }
      }
      if (failed.length) {
        keepBackup = true;
        throw new Error(`Could not restore ${failed.join(', ')}. Previous images remain in ${backup}`, {
          cause: error,
        });
      }
      throw error;
    }
  } finally {
    if (!keepBackup) fs.rmSync(backup, { recursive: true, force: true });
  }
}

async function prepare(page: Page, scene: (typeof README_SCENES)[number], demoDirectory: string): Promise<void> {
  await page.clock.setFixedTime(CAPTURE_TIME);
  if (scene === 'main') {
    const build = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/web-demo.ts', demoDirectory], {
      cwd: path.join(ROOT, 'extension'),
      encoding: 'utf8',
    });
    if (build.error || build.status !== 0) throw new Error(build.error?.message ?? build.stderr ?? build.stdout);
    await page.route('http://arc-demo.local/**', async (route) => {
      const name = path.basename(new URL(route.request().url()).pathname) || 'index.html';
      let body = fs.readFileSync(path.join(demoDirectory, name), 'utf8');
      if (name === 'samples.js')
        body += `
window.__ARC_DEMO_SAMPLES__.railWidth = 270;
for (const payload of Object.values(window.__ARC_DEMO_SAMPLES__.payloads)) {
  payload.comments = [];
  payload.usage.composer.annotations = null;
}`;
      if (name === 'index.html') body = body.replace('<html lang="en"', '<html class="demo-capture" lang="en"');
      await route.fulfill({
        contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
        body,
      });
    });
    await page.goto('http://arc-demo.local/');
    await page.locator('#rail .railcard').first().waitFor();
    await page.locator('#list .turn .cardrecord').first().waitFor();
    await page.locator('.sbrow').waitFor();
    await page.waitForFunction(() => document.body.style.getPropertyValue('--demo-header-height') === '0px');
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(SETTLED);
    if (await page.locator('.linemark, #composer .cchip').count())
      throw new Error('The main capture contains comments.');
    return;
  }
  const payload = readmePayload(scene);
  const keys = (payload.cards as { key: string }[]).map((card) => card.key);
  const marker = 'const SAVED_STATE = {};';
  const fixture = pageHtml();
  if (!fixture.includes(marker)) throw new Error('Panel fixture saved-state marker is missing.');
  const html = fixture.replace(
    marker,
    `const SAVED_STATE = ${JSON.stringify({ read: keys, railWidth: CAPTURE_RAIL_WIDTH })};`,
  );
  await page.setContent(themed(html, 'onedark'));
  await page.addStyleTag({
    content: `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } html, body, * { scrollbar-width: none !important; } ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }`,
  });
  await page.evaluate((message) => window.postMessage(message, '*'), payload);
  await page.locator('#rail .railcard').first().waitFor();
  await page.locator('#list .turn').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#rail .railcard').length === 6);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(SETTLED);
}

// The editor's native menu sits outside the webview. Captures use the web demo stand-in with every manifest entry.
async function installMenu(page: Page): Promise<void> {
  const script = esbuild.buildSync({
    stdin: {
      contents: `import { installMenu } from './scripts/web-demo-menu.ts';
window.__arcInstallMenu = installMenu;`,
      resolveDir: path.join(ROOT, 'extension'),
      loader: 'ts',
    },
    ...BROWSER_BUILD,
  }).outputFiles[0].text;
  await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, 'web-demo-menu.css'), 'utf8') });
  await page.addScriptTag({ content: script });
  const entries = manifestMenu(JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/package.json'), 'utf8')));
  await page.evaluate((list) => {
    (window as unknown as { __arcInstallMenu(d: Document, e: unknown, c: () => void): void }).__arcInstallMenu(
      document,
      list,
      () => {},
    );
  }, entries);
}

// Round the dialog clip to whole pixels to exclude surrounding panel pixels from a fractional element box.
async function dialogCrop(page: Page, selector: string, file: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible.`);
  const left = Math.round(box.x);
  const top = Math.round(box.y);
  await writeLosslessWebp(page, file, {
    clip: {
      x: left,
      y: top,
      width: Math.round(box.x + box.width) - left,
      height: Math.round(box.y + box.height) - top,
    },
  });
}

// Require the 5h and 7d usage limits for both agents named in the README alt text.
export function missingUsageLimits(groups: { agent: string; limits: string[] }[]): string[] {
  return ['Claude', 'Codex'].flatMap((agent) => {
    const limits = groups.find((group) => group.agent === agent)?.limits ?? [];
    return ['5h', '7d'].filter((limit) => !limits.includes(limit)).map((limit) => `${agent} ${limit}`);
  });
}

// Crop from the popover's top through the last agent's figures, excluding unused usage bar width.
async function usageCrop(page: Page, file: string): Promise<void> {
  const bar = await page.locator('.sbrow').boundingBox();
  const figures = await page.locator('.sbrow .sbagent').last().boundingBox();
  const detail = await page.locator('#usagepop').boundingBox();
  if (!bar || !figures || !detail) throw new Error('The usage bar is not visible.');
  const left = Math.max(0, Math.floor(Math.min(bar.x, detail.x) - 2));
  const top = Math.floor(detail.y);
  await writeLosslessWebp(page, file, {
    clip: {
      x: left,
      y: top,
      width: Math.ceil(Math.max(figures.x + figures.width, detail.x + detail.width) + 2 - left),
      height: Math.ceil(bar.y + bar.height - top),
    },
  });
}

// Include the response column's right edge so the crop preserves complete wrapped lines.
async function menuCrop(page: Page, file: string): Promise<void> {
  const row = await page.locator('#list .sessionrow').first().boundingBox();
  const menu = await page.locator('.demo-menu').boundingBox();
  const column = await page.locator('#list .turn .summary').first().boundingBox();
  if (!row || !menu || !column) throw new Error('The context menu is not visible.');
  const top = Math.floor(row.y);
  await writeLosslessWebp(page, file, {
    clip: {
      x: Math.floor(row.x),
      y: top,
      width: Math.ceil(Math.max(menu.x + menu.width, column.x + column.width) + 18 - row.x),
      height: Math.ceil(menu.y + menu.height + 18 - top),
    },
  });
}

async function menuHolds(page: Page, titles: string[]): Promise<void> {
  const shown = await page.locator('.demo-menu [role="menuitem"]').allTextContents();
  const missing = titles.filter((title) => !shown.includes(title));
  if (missing.length) throw new Error(`The context menu lacks ${missing.join(', ')}: ${shown.join(', ')}`);
}

async function capture(page: Page, scene: (typeof README_SCENES)[number], dir: string): Promise<void> {
  if (
    scene === 'review' ||
    scene === 'files' ||
    scene === 'comment' ||
    scene === 'comment-editor' ||
    scene.endsWith('menu') ||
    scene === 'cost' ||
    scene === 'next-turn'
  ) {
    await page.locator('#list .turn h3.cardheading button.head').first().click();
    await page.locator('#list .turn .recordfiles').first().waitFor();
  }
  if (scene === 'review') {
    await page.locator('#list .turn .recordagents').first().waitFor();
    await page.locator('#list .turn .recordcommits').first().waitFor();
  }
  if (scene === 'comment') {
    await page.locator('#list .turn .summary .linemark').first().click();
    await page.locator('.markfloat').waitFor({ state: 'visible' });
  }
  if (scene === 'comment-editor') {
    await page
      .locator('#list .turn .summary p')
      .first()
      .evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
    await page.locator('.quotefloat .quoteact').click();
    await page
      .locator('.quotefloat .notearea')
      .fill('Check that files and the full diff open after restoring a session tab.');
  }
  if (scene === 'cost' || scene === 'cache') {
    await page.locator('#list .turn [data-metric="cost"]').first().click();
    await page.locator('#chippop').waitFor({ state: 'visible' });
    if (
      scene === 'cache' &&
      !(await page.locator('#chippop').innerText()).includes('Low cache reuse in this session')
    ) {
      throw new Error('The production cache warning is not visible.');
    }
  }
  if (scene === 'next-turn') {
    const figure = page.locator('.cnextturn[data-state="warm"] .cnextturnface:not(.is-off)');
    await figure.waitFor({ state: 'visible' });
    const visible = await figure.innerText();
    if (!visible.includes('cached for another') || !visible.includes('$')) {
      throw new Error(`The production next-turn price and cache timer are missing: ${visible}`);
    }
    const price = (readmePayload(scene).usage as { composer: { nextTurn: { coldAt: number } } }).composer.nextTurn;
    if (!(price.coldAt > CAPTURE_TIME)) throw new Error('The next-turn cache boundary must follow capture time.');
    await figure.locator('.cnextturnprice').click();
    await page.locator('#chippop').waitFor({ state: 'visible' });
    if (!(await page.locator('#chippop').innerText()).includes('Cost if cache were cold')) {
      throw new Error('The next-turn detail did not show the cold price.');
    }
    await page.waitForFunction(() => {
      const detail = document.querySelector('#chippop')?.getBoundingClientRect();
      const face = document.querySelector('.cnextturnface:not(.is-off)')?.getBoundingClientRect();
      return detail && face && detail.height > 100 && detail.bottom <= face.top && detail.top >= 0;
    });
  }
  if (scene === 'cache-expiry') {
    const metric = page.locator('.sessionstats [data-metric="cache-expiry"]');
    await metric.waitFor({ state: 'visible' });
    if (!(await metric.innerText()).includes('3 cache expiries'))
      throw new Error('The cache-expiry figure is missing.');
    await metric.click();
    await page.locator('#chippop').waitFor({ state: 'visible' });
    if (!(await page.locator('#chippop').innerText()).includes('3 affected turns')) {
      throw new Error('The cache-expiry detail did not name the affected turns.');
    }
  }
  if (scene === 'project-cost') {
    await page.locator(PROJECT_COST_FACE).click();
    await page.locator('#projectspendpop').waitFor({ state: 'visible' });
    const detail = await page.locator('#projectspendpop').innerText();
    if (!/^Claude\s+\$/m.test(detail) || !/^Codex\s+\$/m.test(detail)) {
      throw new Error(`Project cost does not show Claude and Codex spend: ${detail}`);
    }
  }
  if (scene === 'usage') {
    await page.locator('.sbrow').click();
    await page.locator('#usagepop').waitFor({ state: 'visible' });
    const groups = await page.locator('#usagepop .sbgroup').evaluateAll((nodes) =>
      nodes.map((node) => ({
        agent: node.querySelector('.sbhead > span')?.textContent ?? '',
        limits: Array.from(node.querySelectorAll('.sblabel'), (label) => label.textContent ?? ''),
      })),
    );
    const missing = missingUsageLimits(groups);
    if (missing.length) {
      throw new Error(`The usage bar lacks ${missing.join(', ')}: ${JSON.stringify(groups)}`);
    }
  }
  if (scene === 'session-menu') {
    await installMenu(page);
    const labels = await page.locator('#list .sessionrow .sessionlabelact').first().boundingBox();
    const title = await page.locator('#list .sessionrow .session').first().boundingBox();
    if (!labels || !title) throw new Error('The session heading has no Labels control.');
    await page.mouse.click(labels.x + labels.width + 120, title.y + title.height / 2, { button: 'right' });
    await page.locator('.demo-menu').waitFor();
    await menuHolds(page, ['Edit labels…', 'New session with the same labels', 'Show session details']);
  }
  if (scene === 'response-menu') {
    await installMenu(page);
    const response = page.locator('#list .turn .summary p').first();
    await response.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    const box = await response.boundingBox();
    if (!box) throw new Error('The response is not visible.');
    await page.mouse.click(box.x + 160, box.y + box.height / 2, { button: 'right' });
    await page.locator('.demo-menu').waitFor();
    await menuHolds(page, ['Send to a new session with the same labels', 'Send to a new session', 'Copy the summary']);
    await page.locator('.demo-menu [role="menuitem"]', { hasText: 'with the same labels' }).hover();
  }
  await page.evaluate(SETTLED);
  const file = path.join(dir, `readme-${scene}.webp`);
  if (scene === 'session-menu' || scene === 'response-menu') await menuCrop(page, file);
  else if (scene === 'files') {
    const commits = page.locator('#list .turn .recordcommits').first();
    const files = page.locator('#list .turn .recordfiles').first();
    await commits.waitFor();
    await files.waitFor();
    await commits.scrollIntoViewIfNeeded();
    const top = await commits.boundingBox();
    const bottom = await files.boundingBox();
    if (!top || !bottom) throw new Error('Files and Commits are not visible.');
    const clip = {
      x: Math.floor(top.x),
      y: Math.floor(top.y),
      width: Math.ceil(Math.max(top.x + top.width, bottom.x + bottom.width) - Math.floor(top.x)),
      height: Math.ceil(bottom.y + bottom.height - Math.floor(top.y)),
    };
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const crop = await page.screenshot({ clip });
    // Pad the captured pixels without including adjacent response or prompt content.
    await page.setContent(`<style>
html, body { margin: 0; }
figure { margin: 0; padding: 18px; width: fit-content; background: ${background}; }
img { display: block; width: ${clip.width}px; height: ${clip.height}px; }
</style><figure><img src="data:image/png;base64,${crop.toString('base64')}"></figure>`);
    await page.locator('img').evaluate((image: HTMLImageElement) => image.decode());
    await writeLosslessWebp(page.locator('figure'), file);
  } else if (scene === 'review') {
    const box = await page.locator('#list .turn').first().boundingBox();
    if (!box) throw new Error('Review turn is not visible.');
    await writeLosslessWebp(page, file, {
      clip: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width) - 2,
        height: Math.round(box.height),
      },
    });
  } else if (scene === 'comment' || scene === 'comment-editor') {
    const rail = await page.locator('#rail').boundingBox();
    if (!rail) throw new Error('Session list is not visible.');
    await writeLosslessWebp(page, file, {
      clip: { x: Math.round(rail.x + rail.width), y: 0, width: 1350 - Math.round(rail.x + rail.width), height: 700 },
    });
  } else if (scene === 'project-cost') {
    await dialogCrop(page, '#projectspendpop', file);
  } else if (scene === 'usage') {
    await usageCrop(page, file);
  } else if (scene === 'cost' || scene === 'cache') {
    await writeLosslessWebp(page.locator('#chippop'), file);
  } else if (scene === 'next-turn') {
    const face = await page.locator('.cnextturnface:not(.is-off)').boundingBox();
    const ending = await page.locator('.cnextturnface:not(.is-off) .cnextturnwords:last-child').boundingBox();
    if (!face || !ending) throw new Error('The Composer next-turn price is not visible.');
    const detail = await page.locator('#chippop').boundingBox();
    if (!detail) throw new Error('The next-turn detail is not visible.');
    const left = Math.max(0, Math.floor(Math.min(face.x, detail.x) - 18));
    const top = Math.max(0, Math.floor(Math.min(face.y, detail.y) - 18));
    await writeLosslessWebp(page, file, {
      clip: {
        x: left,
        y: top,
        width: Math.ceil(Math.max(ending.x + ending.width, detail.x + detail.width) + 18 - left),
        height: Math.ceil(Math.max(face.y + face.height, detail.y + detail.height) + 18 - top),
      },
    });
  } else if (scene === 'cache-expiry') {
    const metric = await page.locator('.sessionstats [data-metric="cache-expiry"]').boundingBox();
    const detail = await page.locator('#chippop').boundingBox();
    if (!metric || !detail) throw new Error('The cache-expiry detail is not visible.');
    const left = Math.max(0, Math.floor(Math.min(metric.x, detail.x) - 2));
    const top = Math.max(0, Math.floor(Math.min(metric.y, detail.y) - 18));
    await writeLosslessWebp(page, file, {
      clip: {
        x: left,
        y: top,
        width: Math.ceil(Math.max(metric.x + metric.width, detail.x + detail.width) + 18 - left),
        height: Math.ceil(Math.max(metric.y + metric.height, detail.y + detail.height) + 18 - top),
      },
    });
  } else {
    await writeLosslessWebp({ screenshot: (options) => page.screenshot({ ...options, omitBackground: true }) }, file);
  }
}

// Give timeline crops 80 extra viewport pixels so the wide session list leaves room for timeline figures.
const TIMELINE_CROPS = new Set<string>(['session-menu', 'response-menu', 'cache-expiry']);

async function main(): Promise<void> {
  buildPanel();
  const { launchAnyBrowser } = await import('../test/browserchannels.mjs');
  // Disable GPU rasterization to reduce antialiasing differences between captures.
  const launched = await launchAnyBrowser({ args: ['--disable-gpu-rasterization'] });
  if (!launched) throw new Error('README screenshots require Edge, Chrome, or bundled Chromium.');
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-readme-shots-'));
  try {
    for (const scene of README_SCENES) {
      const context = await launched.browser.newContext({
        viewport: {
          width:
            scene === 'main'
              ? 1186
              : scene === 'review' || scene === 'files'
                ? 1100
                : TIMELINE_CROPS.has(scene)
                  ? 1430
                  : 1350,
          height: scene === 'main' ? 826 : scene === 'review' || scene === 'files' ? 1000 : 700,
        },
        deviceScaleFactor: 2,
        locale: 'en-US',
        timezoneId: CAPTURE_ZONE,
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await prepare(page, scene, path.join(staged, 'demo'));
        await capture(page, scene, staged);
        if (errors.length) throw new Error(`${scene} page error: ${errors.join('; ')}`);
      } finally {
        await context.close();
      }
    }
    publish(staged, DESTINATION);
    console.log(`README screenshots: ${README_SCENES.join(', ')} in ${DESTINATION}`);
    console.log(`Browser: ${launched.browser.version()} (${launched.channel ?? 'bundled Chromium'})`);
  } finally {
    await launched.browser.close();
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
