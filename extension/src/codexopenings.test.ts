import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'vitest';
import { CodexMetaCache, readCodexSessionMeta, type CodexSessionMeta } from './codex';
import { CODEX_META_VERSION, CodexOpeningsWriter, loadCodexOpenings, storedCodexMetas } from './codexopenings';
import { loadDerivedCache, METADATA_GENERATIONS } from './derivedcache';
import { tempDir } from './temproot';

test('the shared writer retains the file identity captured by an opening read', () => {
  const root = tempDir('codex-openings-');
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'session', cwd: root } }) + '\n');
  const cache = new CodexMetaCache();
  const file = path.join(root, 'openings.json');
  const writer = new CodexOpeningsWriter(file, cache, false);
  writer.setWalk([rollout]);
  try {
    const opening = cache.get(rollout)!;
    assert.equal(writer.write(), true);
    assert.deepEqual(loadCodexOpenings(file)?.get(rollout), readCodexSessionMeta(rollout));
    assert.ok(opening.size! > 0);
    assert.ok(Number.isFinite(opening.mtimeMs));
    assert.ok(opening.fileIdentity?.dev !== undefined);
    assert.ok(opening.fileIdentity?.ino !== undefined);
    fs.appendFileSync(rollout, '{}\n');
    cache.get(rollout, () => assert.fail('append reads the opening'));
    assert.equal(writer.write(), true);
    assert.equal(loadCodexOpenings(file)?.get(rollout)?.size, fs.statSync(rollout).size);
  } finally {
    writer.dispose();
  }
});

test.each(['shared', 'derived'] as const)('the %s opening loader retains current and legacy file stats', (source) => {
  const root = tempDir('codex-opening-loader-');
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'session', cwd: root } }) + '\n');
  const current = readCodexSessionMeta(rollout)!;
  const { fileIdentity: _fileIdentity, ...legacy } = current;
  const { size: _size, mtimeMs: _mtimeMs, ...unmeasured } = legacy;
  const entries: CodexSessionMeta[] = [current, legacy, unmeasured];
  for (const meta of entries) {
    const file = path.join(root, `${source}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: METADATA_GENERATIONS.claude,
        codexMetaVersion: CODEX_META_VERSION,
        codexMetas: [{ file: rollout, meta }],
        titles: [],
      }),
    );
    const loaded = source === 'shared' ? loadCodexOpenings(file) : loadDerivedCache(file).codexMetas;
    assert.ok(loaded);
    assert.deepEqual(loaded.get(rollout), meta);
    const cache = new CodexMetaCache();
    cache.load(loaded);
    let reads = 0;
    assert.equal(cache.get(rollout, () => reads++)?.sessionId, 'session');
    assert.equal(reads, meta.size === undefined ? 1 : 0);
    assert.deepEqual(cache.snapshot()[0][1], current);
  }
});

test('opening validation drops malformed file stats without dropping other rows', () => {
  const root = tempDir('codex-opening-validation-');
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'session', cwd: root } }) + '\n');
  const meta = readCodexSessionMeta(rollout)!;
  const invalid = [
    { size: -1 },
    { size: 1.5 },
    { size: '10' },
    { mtimeMs: 'yesterday' },
    { mtimeMs: undefined },
    { fileIdentity: { dev: 'invalid' } },
    { fileIdentity: { ino: -1 } },
  ];
  const rows = storedCodexMetas({
    codexMetaVersion: CODEX_META_VERSION,
    codexMetas: [
      { file: rollout, meta },
      ...invalid.map((fields, index) => ({ file: `${index}.jsonl`, meta: { ...meta, ...fields } })),
    ],
  });
  assert.deepEqual([...rows], [[rollout, meta]]);
});
