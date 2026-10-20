import { test } from 'vitest';
import assert from 'node:assert';
import { compareVersion, parseVersion, type Version } from './version.ts';

const version = (text: string): Version => {
  const parsed = parseVersion(text);
  assert.ok(parsed, `${text} did not parse`);
  return parsed;
};

test('a release version parses into numbers, and leading zeros read as numbers', () => {
  assert.deepEqual(parseVersion('0.160.00'), { release: [0, 160, 0], prerelease: [] });
  assert.deepEqual(parseVersion('2.1.268'), { release: [2, 1, 268], prerelease: [] });
  assert.deepEqual(parseVersion('0.164.0-alpha.3'), { release: [0, 164, 0], prerelease: ['alpha', '3'] });
});

test('text that is not a whole version does not parse', () => {
  for (const text of [
    '',
    'garbage',
    '0.160',
    '0.160.0.1',
    'v0.160.0',
    '0.160.0 ',
    '0.160.0-',
    '0.160.0-a..b',
    '0.160.0+build',
  ])
    assert.equal(parseVersion(text), null, text);
});

test('versions order by release numbers before any prerelease', () => {
  assert.ok(compareVersion(version('0.160.1'), version('0.159.2')) > 0);
  assert.ok(compareVersion(version('0.159.20'), version('0.159.3')) > 0);
  assert.ok(compareVersion(version('1.0.0'), version('0.999.999')) > 0);
  assert.ok(compareVersion(version('0.164.0-alpha.3'), version('0.163.0')) > 0);
  assert.equal(compareVersion(version('0.160.00'), version('0.160.0')), 0);
});

test('a prerelease ranks below its own release', () => {
  assert.ok(compareVersion(version('0.159.2-alpha.1'), version('0.159.2')) < 0);
  assert.ok(compareVersion(version('0.159.2'), version('0.159.2-alpha.1')) > 0);
});

test('prereleases of one release order by their identifiers', () => {
  assert.ok(compareVersion(version('0.1.0-alpha.10'), version('0.1.0-alpha.2')) > 0);
  assert.ok(compareVersion(version('0.1.0-alpha.1'), version('0.1.0-alpha')) > 0);
  assert.ok(compareVersion(version('0.1.0-beta'), version('0.1.0-alpha.9')) > 0);
  assert.ok(compareVersion(version('0.1.0-alpha'), version('0.1.0-1')) > 0);
  assert.equal(compareVersion(version('0.1.0-rc.1'), version('0.1.0-rc.1')), 0);
});
