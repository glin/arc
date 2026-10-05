import assert from 'node:assert';
import * as fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import { test } from 'vitest';
import { pathToFileURL } from 'node:url';

interface Fixture {
  format: string;
  shape: string;
  file: string;
  size: number;
  newestTurnBytes: number;
}

interface BenchmarkModule {
  generateFixtures(root: string, targets: Record<string, number>): Fixture[];
  validateReport(report: { fixtures: Omit<Fixture, 'file'>[]; matrix: object[]; paths: object[] }): unknown;
}

const formats = ['claude', 'codex'];
const shapes = ['normal', 'overTail', 'overCeiling'];
const strategies = ['bounded', 'eager', 'chunkedPage'];
const refreshPaths = ['unchangedRefresh', 'appendOpenTurn', 'firstSelection', 'olderPageRequest'];

function matrix(): object[] {
  return formats.flatMap((format) =>
    shapes.flatMap((shape) => strategies.map((strategy) => ({ format, shape, strategy }))),
  );
}

function paths(): object[] {
  return formats.flatMap((format) => refreshPaths.map((pathName) => ({ format, path: pathName })));
}

test('the history benchmark validates every fixture and report coordinate', async () => {
  const benchmark = (await import(
    /* @vite-ignore */ pathToFileURL(path.resolve(__dirname, '..', 'bench', 'history.mjs')).href
  )) as BenchmarkModule;
  const root = tempDir('history-fixtures-');
  try {
    const fixtures = benchmark.generateFixtures(root, {
      normal: 64 * 1024,
      overTail: 4 * 1024 * 1024 + 1,
      overCeiling: 32 * 1024 * 1024 + 1,
    });
    const rows = fixtures.map(({ file: _file, ...fixture }) => fixture);
    assert.doesNotThrow(() => benchmark.validateReport({ fixtures: rows, matrix: matrix(), paths: paths() }));
    assert.throws(
      () => benchmark.validateReport({ fixtures: rows, matrix: matrix().slice(1), paths: paths() }),
      /strategy matrix is incomplete/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
