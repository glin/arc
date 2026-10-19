import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function get(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function compare(report, mapping, name, prefix, expected, actual) {
  if (Array.isArray(expected)) {
    const value = get(actual, mapping[prefix] ?? prefix);
    if (!Array.isArray(value) || value.length !== expected.length) {
      report(`${name} ${prefix}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(value)}`);
      return;
    }
    for (let index = 0; index < expected.length; index++) {
      compare(report, mapping, name, `${prefix}.${index}`, expected[index], actual);
    }
    return;
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    for (const [key, value] of Object.entries(expected)) {
      compare(report, mapping, name, prefix ? `${prefix}.${key}` : key, value, actual);
    }
    return;
  }
  const value = get(actual, mapping[prefix] ?? prefix);
  const dollar = /(?:^|\.)(?:costUsd|clientCostUsd|returnInputUsd|writeUsd)$/.test(prefix);
  const equal =
    dollar && typeof expected === 'number' && typeof value === 'number'
      ? Math.abs(expected - value) <= 0.0001
      : JSON.stringify(expected) === JSON.stringify(value);
  if (!equal) report(`${name} ${prefix}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(value)}`);
}

// Compares every expected fixture with the output of `execute(invocation)`, which returns
// { error, status, stdout, stderr } like spawnSync. Returns the failure messages in order.
export function auditStreams({ directory, command, mapping = {}, execute }) {
  const messages = [];
  const report = (message) => messages.push(message);
  const files = readdirSync(directory).filter((file) => /\.expected\.json$/.test(file));
  const inputs = readdirSync(directory).filter((file) => /\.jsonl?$/.test(file) && !file.endsWith('.expected.json'));
  if (files.length === 0) return ['No expected stream fixtures found'];
  for (const input of inputs) {
    const stem = input.replace(/\.jsonl?$/, '');
    if (!files.includes(`${stem}.expected.json`)) report(`${stem} has no expected file`);
  }
  for (const expectedFile of files) {
    const stem = expectedFile.slice(0, -'.expected.json'.length);
    const input = inputs.find((file) => file === `${stem}.json` || file === `${stem}.jsonl`);
    if (!input) {
      report(`${stem} has no input file`);
      continue;
    }
    const fixture = join(directory, input);
    const invocation = command.map((part) => (part === '{}' ? fixture : part));
    const run = execute(invocation);
    if (run.error || run.status !== 0) {
      report(`${stem} command: ${run.error?.message ?? `exit ${run.status}: ${run.stderr.trim()}`}`);
      continue;
    }
    try {
      compare(
        report,
        mapping,
        stem,
        '',
        JSON.parse(readFileSync(join(directory, expectedFile), 'utf8')),
        JSON.parse(run.stdout),
      );
    } catch (error) {
      report(`${stem} output: ${error.message}`);
    }
  }
  return messages;
}
