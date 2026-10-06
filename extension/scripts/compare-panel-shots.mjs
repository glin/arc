import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchAnyBrowser } from '../test/browserchannels.mjs';

export function compareRgba(before, after) {
  if (before.width !== after.width || before.height !== after.height) {
    return {
      equal: false,
      reason: 'dimensions',
      before: { width: before.width, height: before.height },
      after: { width: after.width, height: after.height },
      changedPixels: null,
      firstDifference: null,
    };
  }
  let changedPixels = 0;
  let firstDifference = null;
  for (let pixel = 0; pixel < before.data.length; pixel += 4) {
    if (
      before.data[pixel] === after.data[pixel] &&
      before.data[pixel + 1] === after.data[pixel + 1] &&
      before.data[pixel + 2] === after.data[pixel + 2] &&
      before.data[pixel + 3] === after.data[pixel + 3]
    ) {
      continue;
    }
    changedPixels += 1;
    if (!firstDifference) {
      const offset = pixel / 4;
      firstDifference = {
        x: offset % before.width,
        y: Math.floor(offset / before.width),
        before: Array.from(before.data.slice(pixel, pixel + 4)),
        after: Array.from(after.data.slice(pixel, pixel + 4)),
      };
    }
  }
  return {
    equal: changedPixels === 0,
    reason: changedPixels === 0 ? null : 'pixels',
    before: { width: before.width, height: before.height },
    after: { width: after.width, height: after.height },
    changedPixels,
    firstDifference,
  };
}

export function shotPairs(beforeDir, afterDir) {
  const names = new Set();
  for (const dir of [beforeDir, afterDir]) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const name of fs.readdirSync(dir)) {
      if (name.toLowerCase().endsWith('.webp')) {
        names.add(name);
      }
    }
  }
  return [...names].sort().map((name) => ({
    name: name.slice(0, -5),
    before: path.join(beforeDir, name),
    after: path.join(afterDir, name),
    missing: !fs.existsSync(path.join(beforeDir, name))
      ? 'before'
      : !fs.existsSync(path.join(afterDir, name))
        ? 'after'
        : null,
  }));
}

// Use the shared launcher, which orders browsers to avoid the Edge and Chrome Windows sign-in failure.
async function browserOrNone() {
  return (await launchAnyBrowser())?.browser ?? null;
}

function imageDataUrl(file) {
  return `data:image/webp;base64,${fs.readFileSync(file).toString('base64')}`;
}

async function compareShots(page, beforeFile, afterFile) {
  return await page.evaluate(
    async ({ beforeUrl, afterUrl }) => {
      async function decoded(url) {
        const image = await createImageBitmap(await (await fetch(url)).blob());
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, image.width, image.height).data;
        return { image, data };
      }
      const before = await decoded(beforeUrl);
      const after = await decoded(afterUrl);
      const beforeSize = { width: before.image.width, height: before.image.height };
      const afterSize = { width: after.image.width, height: after.image.height };
      if (beforeSize.width !== afterSize.width || beforeSize.height !== afterSize.height) {
        return {
          equal: false,
          reason: 'dimensions',
          before: beforeSize,
          after: afterSize,
          changedPixels: null,
          firstDifference: null,
        };
      }
      let changedPixels = 0;
      let firstDifference = null;
      for (let pixel = 0; pixel < before.data.length; pixel += 4) {
        if (
          before.data[pixel] === after.data[pixel] &&
          before.data[pixel + 1] === after.data[pixel + 1] &&
          before.data[pixel + 2] === after.data[pixel + 2] &&
          before.data[pixel + 3] === after.data[pixel + 3]
        ) {
          continue;
        }
        changedPixels += 1;
        if (!firstDifference) {
          const offset = pixel / 4;
          firstDifference = {
            x: offset % beforeSize.width,
            y: Math.floor(offset / beforeSize.width),
            before: Array.from(before.data.slice(pixel, pixel + 4)),
            after: Array.from(after.data.slice(pixel, pixel + 4)),
          };
        }
      }
      return {
        equal: changedPixels === 0,
        reason: changedPixels === 0 ? null : 'pixels',
        before: beforeSize,
        after: afterSize,
        changedPixels,
        firstDifference,
      };
    },
    { beforeUrl: imageDataUrl(beforeFile), afterUrl: imageDataUrl(afterFile) },
  );
}

export async function compareShotDirectories(beforeDir, afterDir) {
  const pairs = shotPairs(beforeDir, afterDir);
  if (pairs.length === 0) {
    return { ok: false, browser: false, results: [], error: 'No panel shots were found to compare.' };
  }
  // A missing baseline identifies a new state without failing the comparison.
  // A missing after image fails the run.
  const missing = pairs.filter((pair) => pair.missing).map((pair) => ({ name: pair.name, missing: pair.missing }));
  const lost = missing.some((result) => result.missing === 'after');
  const complete = pairs.filter((pair) => !pair.missing);
  if (!complete.length) {
    return { ok: !lost, browser: false, results: missing };
  }
  const browser = await browserOrNone();
  if (!browser) {
    return { ok: false, browser: false, results: missing, error: 'No installed browser can read the panel shots.' };
  }
  try {
    const page = await browser.newPage();
    const results = [...missing];
    for (const pair of complete) {
      results.push({ name: pair.name, ...(await compareShots(page, pair.before, pair.after)) });
    }
    return { ok: !lost && results.every((result) => result.missing || result.equal), browser: true, results };
  } finally {
    await browser.close();
  }
}

async function main() {
  const [beforeArg, afterArg] = process.argv.slice(2);
  if (!beforeArg || !afterArg) {
    console.error('Usage: node extension/scripts/compare-panel-shots.mjs <beforeDir> <afterDir>');
    process.exitCode = 2;
    return;
  }
  const outcome = await compareShotDirectories(path.resolve(beforeArg), path.resolve(afterArg));
  if (outcome.error) {
    console.error(outcome.error);
  }
  for (const result of outcome.results) {
    if (result.missing) {
      console.error(`${result.name}: missing ${result.missing} image`);
    } else if (result.equal) {
      console.log(`${result.name}: ${result.before.width}x${result.before.height}, changedPixels=0`);
    } else if (result.reason === 'dimensions') {
      console.error(
        `${result.name}: dimensions ${result.before.width}x${result.before.height} != ${result.after.width}x${result.after.height}`,
      );
    } else {
      const first = result.firstDifference;
      console.error(
        `${result.name}: changedPixels=${result.changedPixels}, firstDifference=${first.x},${first.y} ${first.before.join(',')} -> ${first.after.join(',')}`,
      );
    }
  }
  if (!outcome.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
