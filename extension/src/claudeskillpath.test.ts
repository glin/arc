import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir } from './temproot.ts';
import { claudeSkillPath } from './claudeskillpath.ts';

function withClaudeHome(claudeHome: string, run: () => void): void {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
  }
}

function writeSkill(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, '# skill');
  return file;
}

test('a skill file in the project skills folder is found', () => {
  const projectDir = tempDir('claude-skill-project-');
  const claudeHome = tempDir('claude-skill-home-');
  const expected = writeSkill(path.join(projectDir, '.claude', 'skills'), 'land');
  withClaudeHome(claudeHome, () => {
    assert.equal(claudeSkillPath('land', projectDir), expected);
  });
});

test('a skill file in the user skills folder is found when the project has none', () => {
  const projectDir = tempDir('claude-skill-project-');
  const claudeHome = tempDir('claude-skill-home-');
  const expected = writeSkill(path.join(claudeHome, 'skills'), 'polish');
  withClaudeHome(claudeHome, () => {
    assert.equal(claudeSkillPath('polish', projectDir), expected);
  });
});

test('a project skill wins over a user skill of the same name', () => {
  const projectDir = tempDir('claude-skill-project-');
  const claudeHome = tempDir('claude-skill-home-');
  const expected = writeSkill(path.join(projectDir, '.claude', 'skills'), 'land');
  writeSkill(path.join(claudeHome, 'skills'), 'land');
  withClaudeHome(claudeHome, () => {
    assert.equal(claudeSkillPath('land', projectDir), expected);
  });
});

test('no file in either folder resolves to no path', () => {
  const projectDir = tempDir('claude-skill-project-');
  const claudeHome = tempDir('claude-skill-home-');
  withClaudeHome(claudeHome, () => {
    assert.equal(claudeSkillPath('nonexistent', projectDir), null);
  });
});

test('a name that is not a safe single folder name resolves to no path, even when a matching file exists', () => {
  const projectDir = tempDir('claude-skill-project-');
  const claudeHome = tempDir('claude-skill-home-');
  writeSkill(path.join(projectDir, '.claude', 'skills'), '..');
  withClaudeHome(claudeHome, () => {
    assert.equal(claudeSkillPath('..', projectDir), null);
    assert.equal(claudeSkillPath('../land', projectDir), null);
    assert.equal(claudeSkillPath('a/b', projectDir), null);
    assert.equal(claudeSkillPath('a\\b', projectDir), null);
    assert.equal(claudeSkillPath('plugin:skill', projectDir), null);
  });
});

test('a null project directory still checks the user skills folder', () => {
  const claudeHome = tempDir('claude-skill-home-');
  const expected = writeSkill(path.join(claudeHome, 'skills'), 'polish');
  withClaudeHome(claudeHome, () => {
    assert.equal(claudeSkillPath('polish', null), expected);
  });
});
