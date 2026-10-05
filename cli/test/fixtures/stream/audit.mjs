import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0 || separator === args.length - 1) {
  console.error('Usage: audit.mjs [--map FILE] [--fixtures DIRECTORY] -- COMMAND ... {}');
  process.exit(2);
}
let mapping = {};
const options = args.slice(0, separator);
const fixtureIndex = options.indexOf('--fixtures');
if (fixtureIndex >= 0 && fixtureIndex + 1 >= separator) {
  console.error('--fixtures needs a directory before --');
  process.exit(2);
}
const directory = fixtureIndex >= 0 ? options[fixtureIndex + 1] : defaultDirectory;
const mapIndex = options.indexOf('--map');
if (mapIndex >= 0) {
  if (mapIndex + 1 >= separator) {
    console.error('--map needs a JSON file before --');
    process.exit(2);
  }
  mapping = JSON.parse(readFileSync(options[mapIndex + 1], 'utf8'));
}
const command = args.slice(separator + 1);
const files = readdirSync(directory).filter((file) => /\.expected\.json$/.test(file));
const inputs = readdirSync(directory).filter((file) => /\.jsonl?$/.test(file) && !file.endsWith('.expected.json'));
let failures = 0;
if (files.length === 0) {
  console.error('No expected stream fixtures found');
  process.exit(1);
}
for (const input of inputs) {
  const stem = input.replace(/\.jsonl?$/, '');
  if (!files.includes(`${stem}.expected.json`)) {
    console.error(`${stem} has no expected file`);
    failures++;
  }
}

function get(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function compare(name, prefix, expected, actual) {
  if (Array.isArray(expected)) {
    const value = get(actual, mapping[prefix] ?? prefix);
    if (!Array.isArray(value) || value.length !== expected.length) {
      console.error(`${name} ${prefix}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(value)}`);
      failures++;
      return;
    }
    for (let index = 0; index < expected.length; index++) {
      compare(name, `${prefix}.${index}`, expected[index], actual);
    }
    return;
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    for (const [key, value] of Object.entries(expected)) {
      compare(name, prefix ? `${prefix}.${key}` : key, value, actual);
    }
    return;
  }
  const value = get(actual, mapping[prefix] ?? prefix);
  const dollar = /(?:^|\.)(?:costUsd|clientCostUsd|returnInputUsd|writeUsd)$/.test(prefix);
  const equal = dollar && typeof expected === 'number' && typeof value === 'number'
    ? Math.abs(expected - value) <= 0.0001
    : JSON.stringify(expected) === JSON.stringify(value);
  if (!equal) {
    console.error(`${name} ${prefix}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(value)}`);
    failures++;
  }
}

for (const expectedFile of files) {
  const stem = expectedFile.slice(0, -'.expected.json'.length);
  const input = inputs.find((file) => file === `${stem}.json` || file === `${stem}.jsonl`);
  if (!input) {
    console.error(`${stem} has no input file`);
    failures++;
    continue;
  }
  const fixture = join(directory, input);
  const invocation = command.map((part) => part === '{}' ? fixture : part);
  const run = spawnSync(invocation[0], invocation.slice(1), { encoding: 'utf8' });
  if (run.error || run.status !== 0) {
    console.error(`${stem} command: ${run.error?.message ?? `exit ${run.status}: ${run.stderr.trim()}`}`);
    failures++;
    continue;
  }
  try {
    compare(stem, '', JSON.parse(readFileSync(join(directory, expectedFile), 'utf8')), JSON.parse(run.stdout));
  } catch (error) {
    console.error(`${stem} output: ${error.message}`);
    failures++;
  }
}
process.exitCode = failures ? 1 : 0;
