// extension/src/fileicons.test.ts
import { test } from 'vitest';
import assert from 'node:assert';
import { iconFor } from './fileicons.ts';

test('a known type gets its own badge and colour', () => {
  assert.deepEqual(iconFor('c:/repo/src/store.ts'), { label: 'TS', colour: '#4a9fe0' });
  assert.equal(iconFor('/home/dev/notes.md').label, 'MD');
  assert.equal(iconFor('script.py').label, 'PY');
  assert.equal(iconFor('data.json').label, '{ }');
});

test('a path arrives in either separator shape, and in any case', () => {
  // Icon lookup accepts both path separators and ignores extension case.
  // Drive-letter case must not affect the result.
  assert.equal(iconFor('c:\\repo\\src\\Store.TS').label, 'TS');
  assert.equal(iconFor('C:/Repo/README.MD').label, 'MD');
});

test('only the last dot names the type', () => {
  // A test file is a TypeScript file, not a file of type "test.ts".
  assert.equal(iconFor('extension/src/pricing.test.ts').label, 'TS');
  assert.equal(iconFor('archive.tar.gz').label, 'ZIP');
});

test('a file that carries its meaning in its name is not read as its extension', () => {
  assert.equal(iconFor('c:/repo/package.json').label, 'NPM');
  assert.notEqual(iconFor('c:/repo/package.json').label, iconFor('c:/repo/other.json').label);
  assert.equal(iconFor('c:/repo/Dockerfile').label, 'DOCK');
});

test('a dotfile has no extension, so its name decides or nothing does', () => {
  // `.gitignore` must not read as a file of type "gitignore".
  assert.equal(iconFor('.gitignore').label, 'GIT');
  assert.equal(iconFor('c:/repo/.gitignore').label, 'GIT');
  assert.equal(iconFor('.unheardof').label, '•');
});

test('a type the table has never heard of still says what it is', () => {
  // Unknown extensions use a shortened extension label rather than an empty badge.
  // An empty colour selects the panel's neutral tone.
  assert.deepEqual(iconFor('notes.rst'), { label: 'RST', colour: '' });
  assert.deepEqual(iconFor('thing.parquet'), { label: 'PARQ', colour: '' });
  assert.equal(iconFor('thing.parquet').label.length, 4, 'a long extension is cut, not drawn in full');
});

test('a name with no extension at all still gets a mark', () => {
  assert.equal(iconFor('c:/repo/Makefile').label, 'MAKE');
  assert.equal(iconFor('c:/repo/CHANGELOG').label, '•');
  assert.equal(iconFor('').label, '•');
});

test('a file named after something on the object prototype gets a badge like any other', () => {
  // Filename and extension lookups must exclude inherited object properties.
  // constructor and __proto__ name truthy values on Object.prototype.
  // Neither inherited value supplies an icon label or colour.
  // The lookup lower-cases first, so these two are the names that can reach it.
  assert.deepEqual(iconFor('constructor'), { label: '•', colour: '' });
  assert.deepEqual(iconFor('c:/repo/__proto__'), { label: '•', colour: '' });
  assert.deepEqual(iconFor('notes.constructor'), { label: 'CONS', colour: '' });
  assert.deepEqual(iconFor('notes.__proto__'), { label: '__PR', colour: '' });
  // Truthiness alone does not establish that the returned value contains icon fields.
  // Check the label and colour types separately.
  for (const p of ['constructor', '__proto__', 'notes.constructor', 'notes.__proto__']) {
    assert.equal(typeof iconFor(p).label, 'string', `${p} came back with no label of its own`);
    assert.equal(typeof iconFor(p).colour, 'string', `${p} came back with no colour of its own`);
  }
});

test('every badge fits the width the row gives it', () => {
  // The row draws these in a fixed-width column, so one long enough to push the filename
  // out of the row would break the whole column rather than one line of it.
  const paths = [
    'a.ts',
    'a.tsx',
    'a.svelte',
    'a.swift',
    'package-lock.json',
    'a.jsonc',
    'a.scss',
    'a.unheardofextension',
    'Makefile',
    'a.cpp',
    'a.hpp',
    'a.cs',
  ];
  for (const p of paths) {
    const { label } = iconFor(p);
    assert.ok(label.length >= 1 && label.length <= 4, `${p} gives a badge of ${label.length} characters: ${label}`);
  }
});
