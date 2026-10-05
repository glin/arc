import { test } from 'vitest';
import assert from 'node:assert';
import { claudeCommandIsSkill, safeSkillFolderName, sameSkillList, withDirectorySkills } from './claude-skills.ts';

test('a known skill list highlights only the names it carries', () => {
  assert.equal(claudeCommandIsSkill('land', ['land', 'polish']), true);
  assert.equal(claudeCommandIsSkill('context', ['land', 'polish']), false);
});

test('a known skill list matches case-insensitively, including a plugin-qualified name', () => {
  assert.equal(claudeCommandIsSkill('Land', ['land']), true);
  assert.equal(claudeCommandIsSkill('sample-plugin:sample-skill', ['sample-plugin:sample-skill']), true);
});

test('no list ever seen for the working directory falls back to every command', () => {
  assert.equal(claudeCommandIsSkill('context', null), true);
  assert.equal(claudeCommandIsSkill('anything', null), true);
});

test('an empty list, once seen, highlights nothing', () => {
  assert.equal(claudeCommandIsSkill('land', []), false);
});

test('a new list replaces an earlier list filed under the same working directory', () => {
  const first = withDirectorySkills({}, 'c:/repo', ['land']);
  const second = withDirectorySkills(first, 'c:/repo', ['polish']);
  assert.deepEqual(second, { 'c:/repo': ['polish'] });
});

test('a list filed under one working directory leaves another directory untouched', () => {
  const lists = withDirectorySkills({ 'c:/other': ['sample-skill'] }, 'c:/repo', ['land']);
  assert.deepEqual(lists, { 'c:/other': ['sample-skill'], 'c:/repo': ['land'] });
});

test('a reported list equal to the stored list is recognized as unchanged', () => {
  assert.equal(sameSkillList(['land', 'polish'], ['land', 'polish']), true);
});

test('a reported list is not the same as a stored list of different length or order', () => {
  assert.equal(sameSkillList(['land'], ['land', 'polish']), false);
  assert.equal(sameSkillList(['land', 'polish'], ['polish', 'land']), false);
});

test('a directory with no stored list is never read as matching a reported one', () => {
  assert.equal(sameSkillList(undefined, []), false);
});

test('an ordinary single-segment name is a safe skill folder name', () => {
  assert.equal(safeSkillFolderName('land'), true);
  assert.equal(safeSkillFolderName('check-guide-docs'), true);
});

test('an empty name is not a safe skill folder name', () => {
  assert.equal(safeSkillFolderName(''), false);
});

test('a name made only of dots is not a safe skill folder name', () => {
  assert.equal(safeSkillFolderName('.'), false);
  assert.equal(safeSkillFolderName('..'), false);
  assert.equal(safeSkillFolderName('...'), false);
  assert.equal(safeSkillFolderName('....'), false);
});

test('a name with a trailing dot or space is not a safe skill folder name', () => {
  assert.equal(safeSkillFolderName('land.'), false);
  assert.equal(safeSkillFolderName('land '), false);
  assert.equal(safeSkillFolderName('land..'), false);
});

test('an absolute path or a drive-letter name is not a safe skill folder name', () => {
  assert.equal(safeSkillFolderName('/etc/passwd'), false);
  assert.equal(safeSkillFolderName('C:\\Users\\reader'), false);
  assert.equal(safeSkillFolderName('C:'), false);
});
