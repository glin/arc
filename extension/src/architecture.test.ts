import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inventorySourceTree } from '../test/source-tree.ts';

const DOC = path.join(__dirname, '..', '..', 'docs', 'architecture.md');

function tableNames(doc: string): string[] {
  const found: string[] = [];
  for (const line of doc.split('\n')) {
    const row = /^\|\s*`([A-Za-z0-9_./-]+\.(?:ts|css|js|json))`\s*\|/.exec(line);
    if (row) found.push(row[1]);
  }
  return found;
}

function documentedNames(): string[] {
  return tableNames(fs.readFileSync(DOC, 'utf8'));
}

function source(): ReturnType<typeof inventorySourceTree> {
  return inventorySourceTree(__dirname);
}

test('the architecture table has one row for every recursive component path', () => {
  const documented = documentedNames();
  const duplicate = [...new Set(documented.filter((name, index) => documented.indexOf(name) !== index))].sort();
  assert.deepEqual(duplicate, [], `the component table repeats ${duplicate.join(', ')}`);
  const discovered = source();
  assert.deepEqual(
    discovered.unsupported,
    [],
    `unsupported source entries are not accounted for: ${discovered.unsupported.join(', ')}`,
  );
  assert.deepEqual(discovered.links, [], `linked source entries are not accounted for: ${discovered.links.join(', ')}`);
  assert.deepEqual(
    [...documented].sort(),
    [...discovered.components].sort(),
    'the architecture table and recursive source inventory describe different component paths',
  );
});

test('removed snapshot mutation APIs stay out of production source', () => {
  const removed = /\b(?:keepFile|rejectFile|keepHunk|rejectHunk|removeFromManifest)\b/;
  const offenders = source().components.filter((file) => {
    const full = path.join(__dirname, file);
    return fs.statSync(full).isFile() && removed.test(fs.readFileSync(full, 'utf8'));
  });
  assert.deepEqual(offenders, [], `removed snapshot mutations returned in ${offenders.join(', ')}`);
});
